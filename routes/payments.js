const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { toObjectId } = require("../utils/validation");
const { todayKey, validDateKey, startOfDay, addDays } = require("../utils/dates");

const router = express.Router();
const staffOnly = [requireAuth, requireRole("admin", "cashier")];
const PAYMENT_METHODS = ["cash", "gcash", "card", "other"];

function paymentView(p) {
  return {
    id: String(p._id),
    type: p.type,
    description: p.description,
    customerName: p.customerName || null,
    queueNumber: p.queueNumber ?? null,
    barberName: p.barberName || null,
    quantity: p.quantity ?? null,
    amount: p.amount,
    method: p.method,
    cashierName: p.cashierName,
    createdAt: p.createdAt
  };
}

// Payments between two dates (inclusive), with totals. Defaults to today.
router.get("/", ...staffOnly, async (req, res) => {
  const from = req.query.from || todayKey();
  const to = req.query.to || from;

  if (!validDateKey(from) || !validDateKey(to) || from > to) {
    return res.status(400).json({ error: "Choose a valid date range." });
  }

  const start = startOfDay(from);
  const end = addDays(startOfDay(to), 1);
  if (end - start > 367 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: "Choose a range of one year or less." });

  const payments = await req.app.locals.db.collection("payments")
    .find({ createdAt: { $gte: start, $lt: end } })
    .sort({ createdAt: -1 })
    .toArray();

  const totals = { count: payments.length, total: 0, services: 0, products: 0, byMethod: { cash: 0, gcash: 0, card: 0, other: 0 } };
  for (const p of payments) {
    totals.total += p.amount;
    totals[p.type === "product" ? "products" : "services"] += p.amount;
    totals.byMethod[p.method] = (totals.byMethod[p.method] || 0) + p.amount;
  }

  res.json({ from, to, totals, payments: payments.map(paymentView) });
});

// Sell products from inventory at the counter.
router.post("/product-sale", ...staffOnly, async (req, res) => {
  const db = req.app.locals.db;
  const inventoryId = toObjectId(req.body.inventoryId);
  const quantity = Number(req.body.quantity);
  const method = String(req.body.method || "").toLowerCase();

  if (!inventoryId) return res.status(400).json({ error: "Choose a product." });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return res.status(400).json({ error: "Enter a quantity of 1 or more." });
  if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: "Choose a payment method." });

  // Take the stock in one step so two sales can't sell the same last item.
  const item = await db.collection("inventory").findOneAndUpdate(
    { _id: inventoryId, quantity: { $gte: quantity } },
    { $inc: { quantity: -quantity }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!item) {
    const exists = await db.collection("inventory").findOne({ _id: inventoryId });
    return exists
      ? res.status(409).json({ error: `Only ${exists.quantity} ${exists.name} left in stock.` })
      : res.status(404).json({ error: "Product not found." });
  }

  await db.collection("inventoryEvents").insertOne({
    inventoryId,
    type: "sold",
    quantityChange: -quantity,
    createdAt: new Date()
  });

  const payment = {
    type: "product",
    inventoryId,
    description: item.name,
    quantity,
    amount: Math.round(item.price * quantity * 100) / 100,
    method,
    cashierId: req.user._id,
    cashierName: req.user.name,
    createdAt: new Date()
  };

  const result = await db.collection("payments").insertOne(payment);

  res.status(201).json({
    message: `Sold ${quantity} × ${item.name}.`,
    payment: paymentView({ _id: result.insertedId, ...payment }),
    remainingStock: item.quantity
  });
});

module.exports = router;
