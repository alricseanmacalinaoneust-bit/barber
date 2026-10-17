const jwt = require("jsonwebtoken");
const { toObjectId } = require("../utils/validation");

// Reads the session cookie and re-checks the account in the database,
// so deactivated accounts and role changes take effect immediately.
async function loadUser(req) {
  const token = req.cookies.session;
  if (!token) return null;

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }

  const id = toObjectId(payload.sub);
  if (!id) return null;

  const user = await req.app.locals.db.collection("users").findOne({
    _id: id,
    active: { $ne: false }
  });

  if (!user) return null;

  return {
    _id: user._id,
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword === true
  };
}

async function requireAuth(req, res, next) {
  req.user = await loadUser(req);

  if (!req.user) {
    return res.status(401).json({ error: "Please log in again." });
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
