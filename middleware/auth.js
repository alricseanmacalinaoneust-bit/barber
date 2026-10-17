const jwt = require("jsonwebtoken");
const { toObjectId } = require("../utils/validation");
const { sessionKey } = require("../utils/session");

// Reads the session cookie and re-checks the account in the database, so deactivated
// accounts, role changes and "log out everywhere" take effect immediately.
async function loadUser(req) {
  const token = req.cookies.session;
  if (!token) return null;

  let payload;
  try {
    payload = jwt.verify(token, sessionKey(), { algorithms: ["HS256"] });
  } catch {
    return null;
  }

  const id = toObjectId(payload.sub);
  if (!id) return null;

  const user = await req.app.locals.db.collection("users").findOne({
    _id: id,
    active: { $ne: false }
  });

  if (!user || (payload.v ?? 0) !== (user.sessionVersion || 0)) return null;

  return {
    _id: user._id,
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword === true
  };
}

// Staff signed in with a one-time password may only change it (so whoever handed it over no longer knows it).
const ALLOWED_BEFORE_PASSWORD_CHANGE = ["/api/auth/me", "/api/auth/change-password", "/api/auth/logout", "/api/auth/logout-everywhere"];

async function requireAuth(req, res, next) {
  req.user = await loadUser(req);

  if (!req.user) {
    return res.status(401).json({ error: "Please log in again." });
  }

  const path = req.originalUrl.split("?")[0];
  if (req.user.mustChangePassword && req.user.role !== "customer" && !ALLOWED_BEFORE_PASSWORD_CHANGE.includes(path)) {
    return res.status(403).json({ error: "Please change your one-time password first (My Account).", code: "password_change_required" });
  }

  next();
}

// For routes that both guests and signed-in users can use.
async function optionalAuth(req, res, next) {
  req.user = await loadUser(req);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You are not authorized for this action." });
    }

    next();
  };
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireRole
};
