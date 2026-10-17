const express = require("express");
const bcrypt = require("bcryptjs");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText, validEmail, validName, toObjectId } = require("../utils/validation");
const { temporaryPassword } = require("../utils/session");
const { audit } = require("../utils/security");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const STAFF_ROLES = ["admin", "cashier"];

function staffView(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active !== false,
    createdAt: u.createdAt || null
  };
}

router.get("/", async (req, res) => {
  const staff = await req.app.locals.db.collection("users")
    .find({ role: { $in: STAFF_ROLES } }, { projection: { passwordHash: 0 } })
    .sort({ role: 1, name: 1 })
    .toArray();

  res.json(staff.map(u => ({ ...staffView(u), isYou: u._id.equals(req.user._id) })));
});

// Add a cashier or admin. Returns a one-time password to hand over.
router.post("/", async (req, res) => {
  const name = cleanText(req.body.name, 60);
  const email = cleanText(req.body.email, 254).toLowerCase();
  const role = STAFF_ROLES.includes(req.body.role) ? req.body.role : "cashier";

  if (!validName(name)) return res.status(400).json({ error: "Enter a name (2 to 60 characters)." });
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });

  const password = temporaryPassword();
  const user = {
    name,
    email,
    role,
    passwordHash: await bcrypt.hash(password, 12),
    active: true,
    sessionVersion: 0,
    mustChangePassword: true,
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  try {
    const result = await req.app.locals.db.collection("users").insertOne(user);
    await audit(req, "staff.created", { staff: name, email, role });
    res.status(201).json({ ...staffView({ _id: result.insertedId, ...user }), temporaryPassword: password });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "An account with this email already exists." });
    throw error;
  }
});

// Signs the person out everywhere and forgets their remembered devices.
async function endSessions(db, userId) {
  await db.collection("trustedDevices").deleteMany({ userId });
}

// Change role or turn an account on or off. Admins can't change their own account here.
router.patch("/:id", async (req, res) => {
  const db = req.app.locals.db;
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid staff ID." });
  if (id.equals(req.user._id)) return res.status(400).json({ error: "You can't change your own role or status." });

  const update = { updatedAt: new Date() };
  if (typeof req.body.active === "boolean") update.active = req.body.active;
  if (STAFF_ROLES.includes(req.body.role)) update.role = req.body.role;

  const member = await db.collection("users").findOneAndUpdate(
    { _id: id, role: { $in: STAFF_ROLES } },
    { $set: update, $inc: { sessionVersion: 1 } }
  );

  if (!member) return res.status(404).json({ error: "Staff member not found." });

  await endSessions(db, id);
  await audit(req, "staff.updated", { staff: member.name, changes: { active: update.active, role: update.role } });
  res.json({ message: "Staff account updated. They have been signed out." });
});

router.post("/:id/reset-password", async (req, res) => {
  const db = req.app.locals.db;
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid staff ID." });

  const password = temporaryPassword();
  const member = await db.collection("users").findOneAndUpdate(
    { _id: id, role: { $in: STAFF_ROLES } },
    {
      $set: { passwordHash: await bcrypt.hash(password, 12), mustChangePassword: true, updatedAt: new Date() },
      $inc: { sessionVersion: 1 },
      $unset: { failedLogins: "", lockedUntil: "" }
    }
  );

  if (!member) return res.status(404).json({ error: "Staff member not found." });

  await endSessions(db, id);
  await audit(req, "staff.password-reset", { staff: member.name });
  res.json({ temporaryPassword: password });
});

module.exports = router;
