const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText } = require("../utils/validation");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

// ADMIN: recent activity (sign-ins, failed sign-ins, discounts, voids, no-shows, account changes...).
router.get("/", async (req, res) => {
  const filter = {};
  const action = cleanText(req.query.action, 40);
  if (action) filter.action = { $regex: "^" + action.replace(/[^a-z.-]/g, "") };

  const entries = await req.app.locals.db.collection("auditLogs")
    .find(filter)
    .sort({ at: -1 })
    .limit(300)
    .toArray();

  res.json(entries.map(e => ({
    id: String(e._id),
    at: e.at,
    action: e.action,
    actorName: e.actorName,
    actorRole: e.actorRole,
    ip: e.ip,
    details: e.details || {}
  })));
});

module.exports = router;
