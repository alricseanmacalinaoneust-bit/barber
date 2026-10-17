const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { todayKey, startOfDay, addDays } = require("../utils/dates");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const RANGES = {
  today: () => { const s = startOfDay(todayKey()); return [s, addDays(s, 1)]; },
  yesterday: () => { const s = addDays(startOfDay(todayKey()), -1); return [s, addDays(s, 1)]; },
  week: () => { const e = addDays(startOfDay(todayKey()), 1); return [addDays(e, -7), e]; },
  month: () => { const now = new Date(); return [new Date(now.getFullYear(), now.getMonth(), 1), addDays(startOfDay(todayKey()), 1)]; }
};

function hourLabel(hour) {
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12} ${suffix}`;
}

function topCounts(items, key, limit) {
  const counts = new Map();
  for (const item of items) {
    const name = item[key];
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// Live numbers for the admin dashboard, from queue tickets and payments.
router.get("/summary", async (req, res) => {
  const db = req.app.locals.db;
  const range = RANGES[req.query.range] ? req.query.range : "today";
  const [start, end] = RANGES[range]();

  const tickets = await db.collection("queueTickets").find({ createdAt: { $gte: start, $lt: end } }).toArray();
  const payments = await db.collection("payments").find({ createdAt: { $gte: start, $lt: end } }).toArray();

  const completed = tickets.filter(t => t.status === "completed");
  const called = tickets.filter(t => t.calledAt);
  const averageWait = called.length
    ? Math.round(called.reduce((sum, t) => sum + (t.calledAt - t.createdAt), 0) / called.length / 60000)
    : null;

  // Customers per hour of the day (local time), shop hours 8 AM - 9 PM plus any outliers.
  const hours = new Map();
  for (let h = 8; h <= 21; h++) hours.set(h, 0);
  for (const t of tickets) {
    const h = t.createdAt.getHours();
    hours.set(h, (hours.get(h) || 0) + 1);
  }
  const customersPerHour = [...hours].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, label: hourLabel(hour), count }));

  const barberRatings = await db.collection("barberRatings").aggregate([
    { $group: { _id: "$barberId", avg: { $avg: "$rating" }, count: { $sum: 1 } } }
  ]).toArray();
  const ratingByBarber = new Map(barberRatings.map(r => [String(r._id), r]));

  const barberStats = new Map();
  for (const t of completed) {
    if (!t.barberId) continue;
    const key = String(t.barberId);
    const stat = barberStats.get(key) || { name: t.barberName, customers: 0, revenue: 0 };
    stat.customers += 1;
    stat.revenue += t.amountPaid || 0;
    barberStats.set(key, stat);
  }
  const topBarbers = [...barberStats].map(([id, s]) => ({
    ...s,
    averageRating: ratingByBarber.has(id) ? Math.round(ratingByBarber.get(id).avg * 10) / 10 : null
  })).sort((a, b) => b.customers - a.customers).slice(0, 5);

  const productSales = new Map();
  for (const p of payments.filter(p => p.type === "product")) {
    const sale = productSales.get(p.description) || { name: p.description, quantity: 0, revenue: 0 };
    sale.quantity += p.quantity || 0;
    sale.revenue += p.amount;
    productSales.set(p.description, sale);
  }

  const revenue = payments.reduce((sum, p) => sum + p.amount, 0);
  const lowStockItems = await db.collection("inventory").countDocuments({ $expr: { $lte: ["$quantity", "$minimumStock"] } });

  res.json({
    range,
    from: start,
    to: end,
    totals: {
      customers: tickets.length,
      served: completed.length,
      noShows: tickets.filter(t => t.status === "no-show").length,
      cancelled: tickets.filter(t => t.status === "cancelled").length,
      averageWaitMinutes: averageWait,
      revenue,
      serviceRevenue: payments.filter(p => p.type !== "product").reduce((sum, p) => sum + p.amount, 0),
      productRevenue: payments.filter(p => p.type === "product").reduce((sum, p) => sum + p.amount, 0),
      lowStockItems
    },
    customersPerHour,
    popularServices: topCounts(tickets.filter(t => t.status !== "cancelled"), "service", 5).map(([name, count]) => ({ name, count })),
    topBarbers,
    peakHours: [...customersPerHour].filter(h => h.count > 0).sort((a, b) => b.count - a.count).slice(0, 3),
    mostSoldItems: [...productSales.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5)
  });
});

// Inventory changes per month for a year, grouped in the shop's time zone.
router.get("/inventory-monthly", async (req, res) => {
  const db = req.app.locals.db;
  const year = Number(req.query.year || new Date().getFullYear());

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: "Invalid year." });
  }

  const timezone = process.env.TZ;
  const data = await db.collection("inventoryEvents").aggregate([
    { $match: { createdAt: { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) } } },
    {
      $group: {
        _id: { month: { $month: { date: "$createdAt", timezone } } },
        quantityChange: { $sum: "$quantityChange" },
        sold: { $sum: { $cond: [{ $eq: ["$type", "sold"] }, { $multiply: ["$quantityChange", -1] }, 0] } },
        eventCount: { $sum: 1 }
      }
    }
  ]).toArray();

  const months = Array.from({ length: 12 }, (_, i) => {
    const row = data.find(x => x._id.month === i + 1);
    return {
      month: i + 1,
      quantityChange: row?.quantityChange || 0,
      sold: row?.sold || 0,
      eventCount: row?.eventCount || 0
    };
  });

  res.json({ year, months });
});

module.exports = router;
