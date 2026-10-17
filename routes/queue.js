const express = require("express");
const { ObjectId } = require("mongodb");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText } = require("../utils/validation");

const router = express.Router();

// "assigned" tickets have picked a barber but are still waiting to be called.
const WAITING = ["waiting", "assigned"];
const ACTIVE = ["waiting", "assigned", "serving"];

const ticketCookie = {
  httpOnly: true,
  sameSite: "strict",
  signed: true,
  maxAge: 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === "production"
};

function todayKey() {
  // Local date, so the queue resets at local midnight rather than UTC midnight.
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

async function nextQueueNumber(db, date) {
  const last = await db.collection("queueTickets")
    .find({ queueDate: date })
    .sort({ queueNumber: -1 })
    .limit(1)
    .next();

  return last ? last.queueNumber + 1 : 1;
}

async function estimatedMinutes(db, barberCount, upToNumber) {
  const filter = { queueDate: todayKey(), status: { $in: WAITING } };
  if (upToNumber) filter.queueNumber = { $lte: upToNumber };

  const waiting = await db.collection("queueTickets").countDocuments(filter);
  // Simple transparent estimate: 30 minutes per waiting ticket divided by available barbers.
  const capacity = Math.max(1, barberCount);
  return Math.ceil((waiting * 30) / capacity);
}

async function availableBarbers(db) {
  return db.collection("barbers")
    .find({ active: true, available: true })
    .sort({ name: 1 })
    .toArray();
}

router.post("/", async (req, res) => {
  const db = req.app.locals.db;
  const name = cleanText(req.body.name, 80);
  const service = cleanText(req.body.service, 80);

  if (name.length < 2) return res.status(400).json({ error: "Customer name is required." });
  if (service.length < 2) return res.status(400).json({ error: "Please select a service." });

  const date = todayKey();

  // One active ticket per browser per day.
  const existingId = req.signedCookies.queueTicket;
  if (existingId && ObjectId.isValid(existingId)) {
    const existing = await db.collection("queueTickets").findOne({
      _id: new ObjectId(existingId),
      queueDate: date,
      status: { $in: ACTIVE }
    });

    if (existing) return res.status(409).json({ error: "You are already in today's queue." });
  }

  let number;
  let result;

  for (let attempt = 1; ; attempt++) {
    number = await nextQueueNumber(db, date);

    try {
      result = await db.collection("queueTickets").insertOne({
        queueDate: date,
        queueNumber: number,
        customerName: name,
        service,
        barberId: null,
        status: "waiting",
        createdAt: new Date(),
        calledAt: null,
        completedAt: null
      });
      break;
    } catch (error) {
      // Another customer took this number at the same moment; try the next one.
      if (error.code !== 11000 || attempt >= 5) throw error;
    }
  }

  const barbers = await availableBarbers(db);
  const estimate = await estimatedMinutes(db, barbers.length, number);

  res.cookie("queueTicket", String(result.insertedId), ticketCookie);

  res.status(201).json({
    id: String(result.insertedId),
    queueNumber: number,
    service,
    status: "waiting",
    estimatedMinutes: estimate,
    availableBarbers: barbers.map(b => ({
      id: String(b._id),
      name: b.name
    }))
  });
});

// The customer's own ticket for today, identified by the cookie set when they joined.
router.get("/mine", async (req, res) => {
  const db = req.app.locals.db;
  const ticketId = req.signedCookies.queueTicket;
  const notQueued = { error: "You have not joined today's queue." };

  if (!ticketId || !ObjectId.isValid(ticketId)) return res.status(404).json(notQueued);

  const ticket = await db.collection("queueTickets").findOne({
    _id: new ObjectId(ticketId),
    queueDate: todayKey()
  });

  if (!ticket || ticket.status === "cancelled") return res.status(404).json(notQueued);

  const barbers = await availableBarbers(db);
  const estimate = WAITING.includes(ticket.status)
    ? await estimatedMinutes(db, barbers.length, ticket.queueNumber)
    : 0;

  res.json({
    ticket: {
      id: String(ticket._id),
      queueNumber: ticket.queueNumber,
      customerName: ticket.customerName,
      service: ticket.service,
      barberName: ticket.barberName || null,
      status: ticket.status,
      estimatedMinutes: estimate
    }
  });
});

router.get("/public", async (req, res) => {
  const db = req.app.locals.db;
  const tickets = await db.collection("queueTickets")
    .find({ queueDate: todayKey(), status: { $in: WAITING } })
    .sort({ queueNumber: 1 })
    .toArray();

  const barbers = await db.collection("barbers").find({ active: true }).toArray();

  const availableCount = barbers.filter(b => b.available).length;
  const estimate = await estimatedMinutes(db, availableCount);

  res.json({
    waiting: tickets.map(t => ({
      id: String(t._id),
      queueNumber: t.queueNumber,
      customerName: t.customerName,
      service: t.service,
      barberId: t.barberId
    })),
    availableBarbers: barbers.filter(b => b.available).map(b => ({
      id: String(b._id),
      name: b.name
    })),
    estimatedMinutes: estimate
  });
});

router.post("/:id/select-barber", async (req, res) => {
  const db = req.app.locals.db;

  if (!ObjectId.isValid(req.params.id) || !ObjectId.isValid(req.body.barberId)) {
    return res.status(400).json({ error: "Invalid ticket or barber." });
  }

  // Customers can only choose a barber for their own ticket.
  if (req.signedCookies.queueTicket !== req.params.id) {
    return res.status(403).json({ error: "You can only update your own queue ticket." });
  }

  const ticketId = new ObjectId(req.params.id);
  const barberId = new ObjectId(req.body.barberId);

  const barber = await db.collection("barbers").findOne({
    _id: barberId,
    active: true,
    available: true
  });

  if (!barber) return res.status(409).json({ error: "That barber is no longer available." });

  const result = await db.collection("queueTickets").updateOne(
    { _id: ticketId, status: "waiting" },
    { $set: { barberId, barberName: barber.name, status: "assigned" } }
  );

  if (!result.modifiedCount) {
    return res.status(409).json({ error: "Queue ticket is no longer waiting." });
  }

  await db.collection("barbers").updateOne(
    { _id: barberId },
    { $set: { available: false } }
  );

  res.json({ message: `You selected ${barber.name}. Please wait for your number to be called.` });
});

router.get("/", requireAuth, requireRole("admin", "staff"), async (req, res) => {
  const db = req.app.locals.db;
  const tickets = await db.collection("queueTickets")
    .find({ queueDate: todayKey(), status: { $in: ACTIVE } })
    .sort({ queueNumber: 1 })
    .toArray();

  res.json(tickets.map(t => ({
    id: String(t._id),
    queueNumber: t.queueNumber,
    customerName: t.customerName,
    service: t.service,
    barberName: t.barberName || "Not selected",
    status: t.status,
    createdAt: t.createdAt
  })));
});

router.post("/call-next", requireAuth, requireRole("admin", "staff"), async (req, res) => {
  const db = req.app.locals.db;

  const next = await db.collection("queueTickets").findOne(
    { queueDate: todayKey(), status: { $in: WAITING } },
    { sort: { queueNumber: 1 } }
  );

  if (!next) return res.status(404).json({ error: "No waiting customers." });

  if (next.barberId) {
    await db.collection("barbers").updateOne(
      { _id: next.barberId },
      { $set: { available: false } }
    );
  }

  await db.collection("queueTickets").updateOne(
    { _id: next._id },
    { $set: { status: "serving", calledAt: new Date() } }
  );

  res.json({
    id: String(next._id),
    queueNumber: next.queueNumber,
    customerName: next.customerName,
    barberName: next.barberName || "Any available barber"
  });
});

router.post("/:id/complete", requireAuth, requireRole("admin", "staff"), async (req, res) => {
  const db = req.app.locals.db;

  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid ticket ID." });

  const id = new ObjectId(req.params.id);
  const ticket = await db.collection("queueTickets").findOne({ _id: id });

  if (!ticket) return res.status(404).json({ error: "Ticket not found." });

  await db.collection("queueTickets").updateOne(
    { _id: id },
    { $set: { status: "completed", completedAt: new Date() } }
  );

  if (ticket.barberId) {
    await db.collection("barbers").updateOne(
      { _id: ticket.barberId },
      { $set: { available: true } }
    );
  }

  res.json({ message: "Customer completed." });
});

router.delete("/", requireAuth, requireRole("admin"), async (req, res) => {
  const db = req.app.locals.db;
  const filter = { queueDate: todayKey(), status: { $in: WAITING } };

  // Barbers chosen by cancelled customers become available again.
  const barberIds = await db.collection("queueTickets").distinct("barberId", filter);
  const assigned = barberIds.filter(Boolean);

  await db.collection("queueTickets").updateMany(filter, { $set: { status: "cancelled" } });

  if (assigned.length) {
    await db.collection("barbers").updateMany(
      { _id: { $in: assigned } },
      { $set: { available: true } }
    );
  }

  res.json({ message: "Waiting queue cleared." });
});

module.exports = router;
