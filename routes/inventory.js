const express = require("express");
const { ObjectId } = require("mongodb");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText, positiveNumber } = require("../utils/validation");
const { audit } = require("../utils/security");

const router = express.Router();

router.get("/", requireAuth, requireRole("admin", "cashier"), async (req, res) => {
  const db = req.app.locals.db;
  const items = await db.collection("inventory").find({}).sort({ name: 1 }).toArray();
  res.json(items.map(i => ({
    ...i,
    id: String(i._id),
    _id: undefined,
    lowStock: i.quantity <= i.minimumStock
  })));
});

router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const db = req.app.locals.db;
  const name = cleanText(req.body.name, 100);
  const category = cleanText(req.body.category, 60);
  const quantity = Number(req.body.quantity);
  const minimumStock = Number(req.body.minimumStock);
  const price = Number(req.body.price);

  if (name.length < 2) return res.status(400).json({ error: "Product name is required." });
  if (!positiveNumber(quantity) || !Number.isInteger(quantity)) return res.status(400).json({ error: "Quantity must be a whole number >= 0." });
  if (!positiveNumber(minimumStock) || !Number.isInteger(minimumStock)) return res.status(400).json({ error: "Minimum stock must be a whole number >= 0." });
  if (!positiveNumber(price)) return res.status(400).json({ error: "Price must be >= 0." });

  const doc = {
    name, category, quantity, minimumStock, price,
    createdAt: new Date(), updatedAt: new Date()
  };
  const result = await db.collection("inventory").insertOne(doc);

  // Monthly analytics event
  await db.collection("inventoryEvents").insertOne({
    inventoryId: result.insertedId,
    type: "created",
    quantityChange: quantity,
    createdAt: new Date()
  });

  await audit(req, "inventory.created", { product: name, quantity, price });
  res.status(201).json({ id: String(result.insertedId), ...doc });
});

router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const db = req.app.locals.db;
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid product ID." });
  const id = new ObjectId(req.params.id);
  const current = await db.collection("inventory").findOne({ _id: id });
  if (!current) return res.status(404).json({ error: "Product not found." });

  const name = cleanText(req.body.name, 100);
  const category = cleanText(req.body.category, 60);
  const quantity = Number(req.body.quantity);
  const minimumStock = Number(req.body.minimumStock);
  const price = Number(req.body.price);

  if (name.length < 2 || !Number.isInteger(quantity) || quantity < 0 ||
      !Number.isInteger(minimumStock) || minimumStock < 0 || !Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: "Invalid inventory values." });
  }

  await db.collection("inventory").updateOne(
    { _id: id },
    { $set: { name, category, quantity, minimumStock, price, updatedAt: new Date() } }
  );

  await db.collection("inventoryEvents").insertOne({
    inventoryId: id,
    type: "updated",
    quantityChange: quantity - current.quantity,
    createdAt: new Date()
  });

  await audit(req, "inventory.updated", { product: name, quantityBefore: current.quantity, quantityAfter: quantity, price });
  res.json({ message: "Inventory updated." });
});

router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const db = req.app.locals.db;
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid product ID." });
  const id = new ObjectId(req.params.id);
  const current = await db.collection("inventory").findOneAndDelete({ _id: id });
  if (!current) return res.status(404).json({ error: "Product not found." });

  await db.collection("inventoryEvents").insertOne({
    inventoryId: id,
    type: "deleted",
    quantityChange: -current.quantity,
    createdAt: new Date()
  });

  await audit(req, "inventory.deleted", { product: current.name, quantity: current.quantity });
  res.json({ message: "Inventory item deleted." });
});

module.exports = router;
