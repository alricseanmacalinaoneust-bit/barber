const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAuth, optionalAuth, requireRole } = require("../middleware/auth");
const { cleanText, validName, toObjectId } = require("../utils/validation");
const { ticketCookie } = require("../utils/session");
const { todayKey } = require("../utils/dates");
const { audit } = require("../utils/security");

const router = express.Router();
const staffOnly = [requireAuth, requireRole("admin", "cashier")];

// Tickets from older versions may say "assigned"; they are treated as waiting.
const WAITING = ["waiting", "assigned"];
const ACTIVE = ["waiting", "assigned", "serving"];
const PAYMENT_METHODS = ["cash", "gcash", "card", "other"];
const DEFAULT_DURATION = 30;

// Online joins: limits per device, and a cap on the waiting line, so nobody can flood the queue
// with fake tickets. Walk-ins added by the cashier are not limited.
const MAX_ONLINE_WAITING = Number(process.env.MAX_ONLINE_WAITING) || 60;
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many queue requests from this device. Please ask at the counter." }
});

// "Juan Dela Cruz" -> "Juan C." for public screens.
function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || "Customer";
  return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
}

function ticketView(t) {
  return {
    id: String(t._id),
    queueNumber: t.queueNumber,
    customerName: t.customerName,
    hasAccount: Boolean(t.customerId),
    service: t.service,
    price: t.price ?? null,
    durationMinutes: t.durationMinutes || DEFAULT_DURATION,
    preferredBarberId: t.preferredBarberId ? String(t.preferredBarberId) : null,
    preferredBarberName: t.preferredBarberName || null,
    barberId: t.barberId ? String(t.barberId) : null,
    barberName: t.barberName || null,
    status: t.status === "assigned" ? "waiting" : t.status,
    source: t.source || "guest",
    amountPaid: t.amountPaid ?? null,
    createdAt: t.createdAt,
    calledAt: t.calledAt || null,
    completedAt: t.completedAt || null
  };
}

// Wait = service time of everyone ahead, shared between the barbers on duty.
async function waitEstimate(db, queueNumber) {
  const filter = { queueDate: todayKey(), status: { $in: WAITING } };
  if (queueNumber) filter.queueNumber = { $lt: queueNumber };

  const ahead = await db.collection("queueTickets")
    .find(filter, { projection: { durationMinutes: 1 } })
    .toArray();

  const minutes = ahead.reduce((sum, t) => sum + (t.durationMinutes || DEFAULT_DURATION), 0);
  const barbers = await db.collection("barbers").countDocuments({ active: true, available: true });

  return { peopleAhead: ahead.length, estimatedMinutes: Math.ceil(minutes / Math.max(1, barbers)) };
}

async function nextQueueNumber(db, date) {
  const last = await db.collection("queueTickets")
    .find({ queueDate: date })
    .sort({ queueNumber: -1 })
    .limit(1)
    .next();

  return last ? last.queueNumber + 1 : 1;
}

async function createTicket(db, fields) {
  const date = todayKey();

  for (let attempt = 1; ; attempt++) {
    const ticket = {
      queueDate: date,
      queueNumber: await nextQueueNumber(db, date),
      ...fields,
      status: "waiting",
      barberId: null,
      barberName: null,
      createdAt: new Date(),
      calledAt: null,
      completedAt: null
    };

    try {
      await db.collection("queueTickets").insertOne(ticket);
      return ticket;
    } catch (error) {
      // Another customer took this number at the same moment; try the next one.
      if (error.code !== 11000 || attempt >= 5) throw error;
    }
  }
}

// The chosen service (required) and preferred barber (optional) for a new ticket.
async function readOrder(db, body) {
  const serviceId = toObjectId(body.serviceId);
  const service = serviceId && await db.collection("services").findOne({ _id: serviceId, active: { $ne: false } });
  if (!service) return { error: "Please select a service." };

  const fields = {
    serviceId: service._id,
    service: service.name,
    price: service.price,
    durationMinutes: service.durationMinutes,
    preferredBarberId: null,
    preferredBarberName: null
  };

  if (body.preferredBarberId) {
    const barberId = toObjectId(body.preferredBarberId);
    const barber = barberId && await db.collection("barbers").findOne({ _id: barberId, active: true });
    if (!barber) return { error: "That barber is not available. Choose another barber or any barber." };

    fields.preferredBarberId = barber._id;
    fields.preferredBarberName = barber.name;
  }

  return { fields };
}

// A signed-in customer's ticket, or the one this device joined with as a guest.
function ownTicketFilter(req) {
  if (req.user?.role === "customer") return { customerId: req.user._id, queueDate: todayKey() };

  const id = toObjectId(req.signedCookies.queueTicket);
  return id ? { _id: id, queueDate: todayKey() } : null;
}

async function findOwnTicket(db, req) {
  const filter = ownTicketFilter(req);
  if (!filter) return null;

  return db.collection("queueTickets").find(filter).sort({ createdAt: -1 }).limit(1).next();
}

// A barber who is on duty and not already serving someone.
async function freeBarber(db, barberIdValue) {
  const barberId = toObjectId(barberIdValue);
  const barber = barberId && await db.collection("barbers").findOne({ _id: barberId, active: true });

  if (!barber) return { status: 400, error: "Choose a barber." };
  if (!barber.available) return { status: 409, error: `${barber.name} is marked unavailable.` };

  const serving = await db.collection("queueTickets").findOne({ queueDate: todayKey(), barberId, status: "serving" });
  if (serving) {
    return { status: 409, error: `${barber.name} is still serving #${serving.queueNumber}. Complete that customer first.` };
  }

  return { barber };
}

function callFields(barber, user) {
  return {
    status: "serving",
    barberId: barber._id,
    barberName: barber.name,
    calledAt: new Date(),
    calledBy: user._id
  };
}

async function callTicket(res, db, filter, barber, user, notFound) {
  try {
    const ticket = await db.collection("queueTickets").findOneAndUpdate(
      filter,
      { $set: callFields(barber, user) },
      { sort: { queueNumber: 1 }, returnDocument: "after" }
    );

    if (!ticket) return res.status(404).json({ error: notFound });
    res.json(ticketView(ticket));
  } catch (error) {
    // The unique index allows only one customer being served per barber.
    if (error.code === 11000) return res.status(409).json({ error: `${barber.name} is already serving a customer.` });
    throw error;
  }
}

// ---------- Customers ----------

// Join the queue, signed in or as a guest.
router.post("/", joinLimiter, optionalAuth, async (req, res) => {
  const db = req.app.locals.db;

  if (req.user && req.user.role !== "customer") {
    return res.status(400).json({ error: "Staff add customers from the front desk." });
  }

  const isAccount = req.user?.role === "customer";
  const name = isAccount ? req.user.name : cleanText(req.body.name, 60);
  if (!validName(name)) return res.status(400).json({ error: "Enter your name (2 to 60 characters)." });

  const existing = await findOwnTicket(db, req);
  if (existing && ACTIVE.includes(existing.status)) {
    return res.status(409).json({ error: "You are already in today's queue." });
  }

  const waiting = await db.collection("queueTickets").countDocuments({ queueDate: todayKey(), status: { $in: WAITING } });
  if (waiting >= MAX_ONLINE_WAITING) {
    return res.status(503).json({ error: "The queue is full right now. Please ask at the counter." });
  }

  const { fields, error } = await readOrder(db, req.body);
  if (error) return res.status(400).json({ error });

  const ticket = await createTicket(db, {
    ...fields,
    customerName: name,
    customerId: isAccount ? req.user._id : null,
    source: isAccount ? "account" : "guest"
  });

  if (!isAccount) res.cookie("queueTicket", String(ticket._id), ticketCookie);

  res.status(201).json({ ticket: { ...ticketView(ticket), ...await waitEstimate(db, ticket.queueNumber) } });
});

router.get("/mine", optionalAuth, async (req, res) => {
  const db = req.app.locals.db;
  const ticket = await findOwnTicket(db, req);

  if (!ticket || ticket.status === "cancelled") {
    return res.status(404).json({ error: "You have not joined today's queue." });
  }

  const estimate = WAITING.includes(ticket.status)
    ? await waitEstimate(db, ticket.queueNumber)
    : { peopleAhead: 0, estimatedMinutes: 0 };

  const rated = ticket.status === "completed"
    && Boolean(await db.collection("barberRatings").findOne({ queueTicketId: ticket._id }));

  res.json({ ticket: { ...ticketView(ticket), ...estimate, rated } });
});

router.post("/mine/leave", optionalAuth, async (req, res) => {
  const db = req.app.locals.db;
  const filter = ownTicketFilter(req);
  if (!filter) return res.status(404).json({ error: "You have not joined today's queue." });

  const ticket = await db.collection("queueTickets").findOneAndUpdate(
    { ...filter, status: { $in: WAITING } },
    { $set: { status: "cancelled", endedAt: new Date() } },
    { sort: { createdAt: -1 } }
  );

  if (!ticket) return res.status(409).json({ error: "You are not waiting in the queue." });
  res.json({ message: "You have left the queue." });
});

// Past visits for customers with an account.
router.get("/history", requireAuth, requireRole("customer"), async (req, res) => {
  const db = req.app.locals.db;
  const tickets = await db.collection("queueTickets")
    .find({ customerId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  const ratings = await db.collection("barberRatings")
    .find({ queueTicketId: { $in: tickets.map(t => t._id) } }, { projection: { queueTicketId: 1 } })
    .toArray();
  const rated = new Set(ratings.map(r => String(r.queueTicketId)));

  res.json(tickets.map(t => ({ ...ticketView(t), queueDate: t.queueDate, rated: rated.has(String(t._id)) })));
});

// The queue screen shown in the shop: numbers and short names only.
router.get("/public", async (req, res) => {
  const db = req.app.locals.db;
  const tickets = await db.collection("queueTickets")
    .find({ queueDate: todayKey(), status: { $in: ACTIVE } })
    .sort({ queueNumber: 1 })
    .toArray();

  res.json({
    serving: tickets.filter(t => t.status === "serving").map(t => ({
      queueNumber: t.queueNumber,
      name: shortName(t.customerName),
      barberName: t.barberName
    })),
    waiting: tickets.filter(t => WAITING.includes(t.status)).map(t => ({
      queueNumber: t.queueNumber,
      name: shortName(t.customerName),
      service: t.service
    })),
    estimatedMinutes: (await waitEstimate(db)).estimatedMinutes
  });
});

// ---------- Front desk (cashier and admin) ----------

router.get("/", ...staffOnly, async (req, res) => {
  const tickets = await req.app.locals.db.collection("queueTickets")
    .find({ queueDate: todayKey() })
    .sort({ queueNumber: 1 })
    .toArray();

  res.json(tickets.map(ticketView));
});

// Add a walk-in customer, optionally linked to their account by email.
router.post("/walk-in", ...staffOnly, async (req, res) => {
  const db = req.app.locals.db;
  const email = cleanText(req.body.customerEmail, 254).toLowerCase();
  let customer = null;

  if (email) {
    customer = await db.collection("users").findOne({ email, role: "customer", active: { $ne: false } });
    if (!customer) return res.status(404).json({ error: "No customer account uses that email." });

    const active = await db.collection("queueTickets").findOne({
      customerId: customer._id,
      queueDate: todayKey(),
      status: { $in: ACTIVE }
    });
    if (active) return res.status(409).json({ error: `${customer.name} is already in the queue as #${active.queueNumber}.` });
  }

  const customerName = customer ? customer.name : cleanText(req.body.name, 60);
  if (!validName(customerName)) return res.status(400).json({ error: "Enter the customer's name (2 to 60 characters)." });

  const { fields, error } = await readOrder(db, req.body);
  if (error) return res.status(400).json({ error });

  const ticket = await createTicket(db, {
    ...fields,
    customerName,
    customerId: customer ? customer._id : null,
    source: "walk-in",
    addedBy: req.user._id
  });

  res.status(201).json(ticketView(ticket));
});

// Call the next customer for a barber: the first who chose that barber or has no preference.
router.post("/call-next", ...staffOnly, async (req, res) => {
  const db = req.app.locals.db;
  const { barber, status, error } = await freeBarber(db, req.body.barberId);
  if (error) return res.status(status).json({ error });

  await callTicket(
    res,
    db,
    { queueDate: todayKey(), status: { $in: WAITING }, preferredBarberId: { $in: [barber._id, null] } },
    barber,
    req.user,
    `No customers are waiting for ${barber.name}.`
  );
});

// Call a specific customer (for example, out of order) to a barber.
router.post("/:id/call", ...staffOnly, async (req, res) => {
  const db = req.app.locals.db;
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid ticket ID." });

  const { barber, status, error } = await freeBarber(db, req.body.barberId);
  if (error) return res.status(status).json({ error });

  await callTicket(
    res,
    db,
    { _id: id, queueDate: todayKey(), status: { $in: WAITING } },
    barber,
    req.user,
    "This customer is no longer waiting."
  );
});

// Finish a visit and record the payment.
router.post("/:id/complete", ...staffOnly, async (req, res) => {
  const db = req.app.locals.db;
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid ticket ID." });

  const method = String(req.body.method || "").toLowerCase();
  if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: "Choose a payment method." });

  const current = await db.collection("queueTickets").findOne({ _id: id });
  if (!current) return res.status(404).json({ error: "Ticket not found." });

  // The customer may have had a different service than they joined for.
  let listPrice = Number(current.price) || 0;
  let serviceUpdate = {};
  if (req.body.serviceId) {
    const serviceId = toObjectId(req.body.serviceId);
    const service = serviceId && await db.collection("services").findOne({ _id: serviceId, active: { $ne: false } });
    if (!service) return res.status(400).json({ error: "Choose a valid service." });

    listPrice = service.price;
    if (!(current.serviceId && service._id.equals(current.serviceId))) {
      serviceUpdate = { serviceId: service._id, service: service.name, price: service.price, durationMinutes: service.durationMinutes };
    }
  }

  const rawAmount = req.body.amount;
  const amount = rawAmount === undefined || rawAmount === "" || rawAmount === null ? listPrice : Number(rawAmount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) return res.status(400).json({ error: "Enter a valid amount." });

  // Charging less than the service price needs a reason, so discounts can be reviewed later.
  const note = cleanText(req.body.note, 200);
  const discount = Math.round(Math.max(0, listPrice - amount) * 100) / 100;
  if (discount > 0 && note.length < 3) {
    return res.status(400).json({ error: `The amount is ${discount} below the price. Enter a reason for the discount.` });
  }

  const ticket = await db.collection("queueTickets").findOneAndUpdate(
    { _id: id, status: "serving" },
    { $set: { status: "completed", completedAt: new Date(), completedBy: req.user._id, ...serviceUpdate } },
    { returnDocument: "after" }
  );

  if (!ticket) return res.status(409).json({ error: "Only a customer who is being served can be completed." });

  const payment = {
    type: "service",
    ticketId: ticket._id,
    queueNumber: ticket.queueNumber,
    customerName: ticket.customerName,
    customerId: ticket.customerId || null,
    description: ticket.service,
    barberId: ticket.barberId,
    barberName: ticket.barberName,
    amount: Math.round(amount * 100) / 100,
    listPrice,
    discount,
    method,
    note,
    cashierId: req.user._id,
    cashierName: req.user.name,
    createdAt: new Date()
  };

  const result = await db.collection("payments").insertOne(payment);
  await db.collection("queueTickets").updateOne(
    { _id: ticket._id },
    { $set: { paymentId: result.insertedId, amountPaid: payment.amount } }
  );

  if (discount > 0) {
    await audit(req, "payment.discount", { queueNumber: ticket.queueNumber, customer: ticket.customerName, price: listPrice, charged: payment.amount, reason: note });
  }

  res.json({ message: "Visit completed and payment recorded.", ticket: ticketView({ ...ticket, amountPaid: payment.amount }) });
});

router.post("/:id/no-show", ...staffOnly, async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid ticket ID." });

  const ticket = await req.app.locals.db.collection("queueTickets").findOneAndUpdate(
    { _id: id, status: { $in: ACTIVE } },
    { $set: { status: "no-show", endedAt: new Date() } }
  );

  if (!ticket) return res.status(409).json({ error: "This customer is no longer in the queue." });
  await audit(req, "queue.no-show", { queueNumber: ticket.queueNumber, customer: ticket.customerName });
  res.json({ message: `#${ticket.queueNumber} marked as no-show.` });
});

router.post("/:id/cancel", ...staffOnly, async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid ticket ID." });

  const ticket = await req.app.locals.db.collection("queueTickets").findOneAndUpdate(
    { _id: id, status: { $in: WAITING } },
    { $set: { status: "cancelled", endedAt: new Date() } }
  );

  if (!ticket) return res.status(409).json({ error: "Only waiting customers can be cancelled." });
  await audit(req, "queue.cancelled", { queueNumber: ticket.queueNumber, customer: ticket.customerName });
  res.json({ message: `#${ticket.queueNumber} cancelled.` });
});

router.delete("/", requireAuth, requireRole("admin"), async (req, res) => {
  const result = await req.app.locals.db.collection("queueTickets").updateMany(
    { queueDate: todayKey(), status: { $in: WAITING } },
    { $set: { status: "cancelled", endedAt: new Date() } }
  );

  await audit(req, "queue.cleared", { cancelled: result.modifiedCount });
  res.json({ message: `Cleared ${result.modifiedCount} waiting customer(s).` });
});

module.exports = router;
