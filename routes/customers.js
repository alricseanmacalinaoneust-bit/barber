const express = require("express");
const bcrypt = require("bcryptjs");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText, validEmail, validName, toObjectId, escapeRegex } = require("../utils/validation");
const { temporaryPassword } = require("../utils/session");
const { dateKey, addDays } = require("../utils/dates");

const router = express.Router();
router.use(requireAuth, requireRole("admin", "cashier"));

function visitView(t) {
  return {
    id: String(t._id),
    queueDate: t.queueDate,
    queueNumber: t.queueNumber,
    customerName: t.customerName,
    service: t.service,
    barberName: t.barberName || null,
    status: t.status === "assigned" ? "waiting" : t.status,
    amountPaid: t.amountPaid ?? null,
    source: t.source || "guest"
  };
}

// Customer accounts, newest first, with visit counts. Optional ?search= by name, email or phone.
router.get("/", async (req, res) => {
  const db = req.app.locals.db;
  const search = cleanText(req.query.search, 60);
  const filter = { role: "customer" };

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
  }

  const customers = await db.collection("users")
    .find(filter, { projection: { passwordHash: 0 } })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  const visits = await db.collection("queueTickets").aggregate([
    { $match: { customerId: { $in: customers.map(c => c._id) }, status: "completed" } },
    { $group: { _id: "$customerId", visits: { $sum: 1 }, lastVisit: { $max: "$queueDate" }, spent: { $sum: { $ifNull: ["$amountPaid", 0] } } } }
  ]).toArray();
  const visitMap = new Map(visits.map(v => [String(v._id), v]));

  res.json(customers.map(c => {
    const v = visitMap.get(String(c._id));
    return {
      id: String(c._id),
      name: c.name,
      email: c.email,
      phone: c.phone || "",
      active: c.active !== false,
      createdAt: c.createdAt,
      visits: v ? v.visits : 0,
      lastVisit: v ? v.lastVisit : null,
      spent: v ? v.spent : 0
    };
  }));
});

// Walk-in visits without an account in the last 30 days.
router.get("/walk-ins", async (req, res) => {
  const since = dateKey(addDays(new Date(), -30));
  const tickets = await req.app.locals.db.collection("queueTickets")
    .find({ customerId: null, queueDate: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();

  res.json(tickets.map(visitView));
});

// Create an account for a customer at the counter. Returns a one-time password to give them.
router.post("/", async (req, res) => {
  const db = req.app.locals.db;
  const name = cleanText(req.body.name, 60);
  const email = cleanText(req.body.email, 254).toLowerCase();
  const phone = cleanText(req.body.phone, 20);

  if (!validName(name)) return res.status(400).json({ error: "Enter the customer's name (2 to 60 characters)." });
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });

  const password = temporaryPassword();

  try {
    const result = await db.collection("users").insertOne({
      name,
      email,
      phone,
      passwordHash: await bcrypt.hash(password, 12),
      role: "customer",
      active: true,
      mustChangePassword: true,
      createdBy: req.user._id,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.status(201).json({ id: String(result.insertedId), name, email, temporaryPassword: password });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "An account with this email already exists." });
    throw error;
  }
});

router.get("/:id/visits", async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid customer ID." });

  const tickets = await req.app.locals.db.collection("queueTickets")
    .find({ customerId: id })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  res.json(tickets.map(visitView));
});

router.post("/:id/reset-password", async (req, res) => {
  const db = req.app.locals.db;
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid customer ID." });

  const password = temporaryPassword();
  const result = await db.collection("users").updateOne(
    { _id: id, role: "customer" },
    { $set: { passwordHash: await bcrypt.hash(password, 12), mustChangePassword: true, updatedAt: new Date() } }
  );

  if (!result.matchedCount) return res.status(404).json({ error: "Customer not found." });
  res.json({ temporaryPassword: password });
});

module.exports = router;
