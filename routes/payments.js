const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText, toObjectId } = require("../utils/validation");
const { todayKey, validDateKey, startOfDay, addDays } = require("../utils/dates");
const { audit } = require("../utils/security");

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
    listPrice: p.listPrice ?? null,
    discount: p.discount || 0,
    note: p.note || "",
    method: p.method,
    cashierName: p.cashierName,
    createdAt: p.createdAt,
    voided: p.voided === true,
    voidReason: p.voidReason || "",
    voidedByName: p.voidedByName || "",
    replacesPaymentId: p.replacesPaymentId ? String(p.replacesPaymentId) : null
  };
}

// Payments between two dates (inclusive), with totals. Voided payments are listed but not counted.
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

  const totals = {
    count: 0,
    total: 0,
    services: 0,
    products: 0,
    discounts: 0,
    voided: 0,
    byMethod: { cash: 0, gcash: 0, card: 0, other: 0 }
  };

  for (const p of payments) {
    if (p.voided) {
      totals.voided += 1;
      continue;
    }
    totals.count += 1;
    totals.total += p.amount;
    totals.discounts += p.discount || 0;
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
    listPrice: Math.round(item.price * quantity * 100) / 100,
    discount: 0,
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

// ADMIN: void a payment recorded by mistake, with a reason. Optionally record the corrected payment.
// Product sales go back into stock.
router.post("/:id/void", requireAuth, requireRole("admin"), async (req, res) => {
  const db = req.app.locals.db;
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid payment ID." });

  const reason = cleanText(req.body.reason, 200);
  if (reason.length < 3) return res.status(400).json({ error: "Enter a reason for voiding this payment." });

  const hasReplacement = req.body.replacementAmount !== undefined && req.body.replacementAmount !== "" && req.body.replacementAmount !== null;
  const replacementAmount = Number(req.body.replacementAmount);
  const replacementMethod = String(req.body.replacementMethod || "").toLowerCase();

  if (hasReplacement) {
    if (!Number.isFinite(replacementAmount) || replacementAmount < 0 || replacementAmount > 100000) {
      return res.status(400).json({ error: "Enter a valid corrected amount." });
    }
    if (!PAYMENT_METHODS.includes(replacementMethod)) return res.status(400).json({ error: "Choose the corrected payment method." });
  }

  const payment = await db.collection("payments").findOneAndUpdate(
    { _id: id, voided: { $ne: true } },
    { $set: { voided: true, voidReason: reason, voidedBy: req.user._id, voidedByName: req.user.name, voidedAt: new Date() } }
  );

  if (!payment) return res.status(409).json({ error: "This payment was not found or is already voided." });

  if (payment.type === "product" && payment.inventoryId) {
    await db.collection("inventory").updateOne({ _id: payment.inventoryId }, { $inc: { quantity: payment.quantity } });
    await db.collection("inventoryEvents").insertOne({
      inventoryId: payment.inventoryId,
      type: "returned",
      quantityChange: payment.quantity,
      createdAt: new Date()
    });
  }

  let replacement = null;
  if (hasReplacement) {
    const { _id, voided, voidReason, voidedBy, voidedByName, voidedAt, ...original } = payment;
    replacement = {
      ...original,
      amount: Math.round(replacementAmount * 100) / 100,
      discount: Math.round(Math.max(0, (payment.listPrice ?? replacementAmount) - replacementAmount) * 100) / 100,
      method: replacementMethod,
      note: `Correction: ${reason}`,
      replacesPaymentId: payment._id,
      cashierId: req.user._id,
      cashierName: req.user.name,
      createdAt: new Date()
    };
    const result = await db.collection("payments").insertOne(replacement);
    replacement._id = result.insertedId;
  }

  if (payment.ticketId) {
    await db.collection("queueTickets").updateOne(
      { _id: payment.ticketId },
      { $set: { amountPaid: replacement ? replacement.amount : 0, paymentId: replacement ? replacement._id : null } }
    );
  }

  await audit(req, "payment.voided", {
    description: payment.description,
    amount: payment.amount,
    method: payment.method,
    reason,
    correctedAmount: replacement?.amount ?? null,
    correctedMethod: replacement?.method ?? null
  });

  res.json({ message: replacement ? "Payment voided and the corrected payment recorded." : "Payment voided." });
});

module.exports = router;
