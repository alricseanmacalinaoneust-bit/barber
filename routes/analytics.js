const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/inventory-monthly", requireAuth, requireRole("admin"), async (req, res) => {
  const db = req.app.locals.db;
  const year = Number(req.query.year || new Date().getFullYear());

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: "Invalid year." });
  }

  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));

  const data = await db.collection("inventoryEvents").aggregate([
    { $match: { createdAt: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: { month: { $month: "$createdAt" } },
        quantityAddedOrRemoved: { $sum: "$quantityChange" },
        eventCount: { $sum: 1 }
      }
    },
    { $sort: { "_id.month": 1 } }
  ]).toArray();

  const result = Array.from({ length: 12 }, (_, i) => {
    const row = data.find(x => x._id.month === i + 1);
    return {
      month: i + 1,
      quantityChange: row?.quantityAddedOrRemoved || 0,
      eventCount: row?.eventCount || 0
    };
  });

  res.json({ year, months: result });
});

module.exports = router;
