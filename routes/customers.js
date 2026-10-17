const express = require("express");
const bcrypt = require("bcryptjs");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText, validEmail, validName, toObjectId, escapeRegex } = require("../utils/validation");
const { temporaryPassword } = require("../utils/session");
const { audit } = require("../utils/security");
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
  const filter = { role: "customer", deletedAt: { $exists: false } };

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

// Create an account for a customer at the counter, only when they ask for one.
// With ticketId, a walk-in visit is moved onto the new account. Returns a one-time password to give them.
router.post("/", async (req, res) => {
  const db = req.app.locals.db;
  const name = cleanText(req.body.name, 60);
  const email = cleanText(req.body.email, 254).toLowerCase();
  const phone = cleanText(req.body.phone, 20);
  const ticketId = req.body.ticketId ? toObjectId(req.body.ticketId) : null;

  if (!validName(name)) return res.status(400).json({ error: "Enter the customer's name (2 to 60 characters)." });
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (req.body.ticketId && !ticketId) return res.status(400).json({ error: "Invalid visit." });

  const password = temporaryPassword();
  let customerId;

  try {
    const result = await db.collection("users").insertOne({
      name,
      email,
      phone,
      passwordHash: await bcrypt.hash(password, 12),
      role: "customer",
      active: true,
      sessionVersion: 0,
      mustChangePassword: true,
      createdBy: req.user._id,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    customerId = result.insertedId;
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "An account with this email already exists." });
    throw error;
  }

  let linked = 0;
  if (ticketId) {
    const result = await db.collection("queueTickets").updateOne(
      { _id: ticketId, customerId: null },
      { $set: { customerId, customerName: name } }
    );
    await db.collection("payments").updateMany({ ticketId, customerId: null }, { $set: { customerId, customerName: name } });
    linked = result.modifiedCount;
  }

  await audit(req, "customer.created", { customer: name, email, linkedVisit: Boolean(linked) });
  res.status(201).json({ id: String(customerId), name, email, temporaryPassword: password, linkedVisit: Boolean(linked) });
});

// ADMIN: turn a customer account off (for example, abuse) or back on.
router.patch("/:id", requireRole("admin"), async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid customer ID." });
  if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "Active must be true or false." });

  const customer = await req.app.locals.db.collection("users").findOneAndUpdate(
    { _id: id, role: "customer", deletedAt: { $exists: false } },
    { $set: { active: req.body.active, updatedAt: new Date() }, $inc: { sessionVersion: 1 } }
  );

  if (!customer) return res.status(404).json({ error: "Customer not found." });
  await audit(req, req.body.active ? "customer.activated" : "customer.deactivated", { customer: customer.name });
  res.json({ message: req.body.active ? "Account activated." : "Account deactivated." });
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
  const customer = await db.collection("users").findOneAndUpdate(
    { _id: id, role: "customer", active: { $ne: false } },
    {
      $set: { passwordHash: await bcrypt.hash(password, 12), mustChangePassword: true, updatedAt: new Date() },
      $inc: { sessionVersion: 1 }
    }
  );

  if (!customer) return res.status(404).json({ error: "Customer not found." });
  await audit(req, "customer.password-reset", { customer: customer.name });
  res.json({ temporaryPassword: password });
});

module.exports = router;
