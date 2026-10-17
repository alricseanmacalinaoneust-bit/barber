const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText, validName, toObjectId } = require("../utils/validation");
const { audit } = require("../utils/security");

const router = express.Router();

function serviceView(s) {
  return {
    id: String(s._id),
    name: s.name,
    price: s.price,
    durationMinutes: s.durationMinutes,
    active: s.active !== false
  };
}

function readService(body) {
  const name = cleanText(body.name, 60);
  const price = Number(body.price);
  const durationMinutes = Number(body.durationMinutes);

  if (!validName(name)) return { error: "Service name must be 2 to 60 characters." };
  if (!Number.isFinite(price) || price < 0 || price > 100000) return { error: "Enter a valid price." };
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
    return { error: "Duration must be a whole number of minutes from 5 to 480." };
  }

  return { value: { name, price: Math.round(price * 100) / 100, durationMinutes } };
}

// Services customers can choose from.
router.get("/", async (req, res) => {
  const services = await req.app.locals.db.collection("services")
    .find({ active: { $ne: false } })
    .sort({ name: 1 })
    .toArray();

  res.json(services.map(serviceView));
});

// ADMIN: every service, including hidden ones.
router.get("/all", requireAuth, requireRole("admin"), async (req, res) => {
  const services = await req.app.locals.db.collection("services").find().sort({ name: 1 }).toArray();
  res.json(services.map(serviceView));
});

router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { value, error } = readService(req.body);
  if (error) return res.status(400).json({ error });

  const service = { ...value, active: true, createdAt: new Date(), updatedAt: new Date() };

  try {
    const result = await req.app.locals.db.collection("services").insertOne(service);
    await audit(req, "service.created", { service: service.name, price: service.price });
    res.status(201).json(serviceView({ _id: result.insertedId, ...service }));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "A service with this name already exists. If it is hidden, show it again instead." });
    }
    throw err;
  }
});

router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid service ID." });

  const { value, error } = readService(req.body);
  if (error) return res.status(400).json({ error });

  if (typeof req.body.active === "boolean") value.active = req.body.active;

  try {
    const result = await req.app.locals.db.collection("services").findOneAndUpdate(
      { _id: id },
      { $set: { ...value, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ error: "Service not found." });
    await audit(req, "service.updated", { service: result.name, price: result.price, durationMinutes: result.durationMinutes, active: result.active !== false });
    res.json(serviceView(result));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A service with this name already exists." });
    throw err;
  }
});

// Hiding keeps past visits and payments that mention the service intact.
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid service ID." });

  const result = await req.app.locals.db.collection("services").updateOne(
    { _id: id },
    { $set: { active: false, updatedAt: new Date() } }
  );

  if (!result.matchedCount) return res.status(404).json({ error: "Service not found." });
  await audit(req, "service.hidden", { serviceId: String(id) });
  res.json({ message: "Service hidden from customers." });
});

module.exports = router;
