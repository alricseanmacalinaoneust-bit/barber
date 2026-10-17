const crypto = require("crypto");
const bcrypt = require("bcryptjs");

// Separate keys for session tokens and signed cookies, both derived from JWT_SECRET.
function deriveKey(purpose) {
  return crypto.createHmac("sha256", process.env.JWT_SECRET).update(purpose).digest("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Checked when an email isn't found, so a wrong email takes as long as a wrong password
// (otherwise response times would reveal which emails have accounts).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 12);

// Records who did what, for the admin's activity log. Never blocks the request.
async function audit(req, action, details = {}) {
  try {
    await req.app.locals.db.collection("auditLogs").insertOne({
      at: new Date(),
      action,
      actorId: req.user?._id || null,
      actorName: req.user?.name || null,
      actorRole: req.user?.role || null,
      ip: req.ip,
      details
    });
  } catch (error) {
    console.error("Could not write the activity log:", error.message);
  }
}

module.exports = { deriveKey, hashToken, DUMMY_HASH, audit };
