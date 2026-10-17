const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { deriveKey, hashToken } = require("./security");

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TRUSTED_DEVICE_MS = 30 * 24 * 60 * 60 * 1000;

const cookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production"
};

// Remembers a guest customer's ticket on their device.
const ticketCookie = {
  ...cookieOptions,
  signed: true,
  maxAge: 24 * 60 * 60 * 1000
};

const HOME_PAGES = {
  admin: "/admin.html",
  cashier: "/cashier.html",
  customer: "/dashboard.html"
};

function sessionKey() {
  return deriveKey("session-token");
}

function publicUser(user) {
  return {
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword === true
  };
}

// The token carries the account's session version: raising the version
// (password change, reset, "log out everywhere") ends every older session.
function startSession(res, user) {
  const token = jwt.sign(
    { sub: String(user._id), role: user.role, v: user.sessionVersion || 0 },
    sessionKey(),
    { algorithm: "HS256", expiresIn: SESSION_TTL_MS / 1000 }
  );

  res.cookie("session", token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
}

// After an admin enters their email code, this browser can skip the code for 30 days.
async function rememberDevice(req, res, user) {
  const token = crypto.randomBytes(32).toString("base64url");

  await req.app.locals.db.collection("trustedDevices").insertOne({
    userId: user._id,
    tokenHash: hashToken(token),
    sessionVersion: user.sessionVersion || 0,
    userAgent: String(req.get("user-agent") || "").slice(0, 200),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + TRUSTED_DEVICE_MS)
  });

  res.cookie("trustedDevice", token, { ...cookieOptions, signed: true, maxAge: TRUSTED_DEVICE_MS });
}

async function isTrustedDevice(req, user) {
  const token = req.signedCookies.trustedDevice;
  if (!token || !user) return false;

  const device = await req.app.locals.db.collection("trustedDevices").findOne({
    userId: user._id,
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() }
  });

  return Boolean(device) && device.sessionVersion === (user.sessionVersion || 0);
}

// A readable one-time password for accounts created or reset by staff.
function temporaryPassword() {
  return "Temp-" + crypto.randomBytes(6).toString("base64url") + "7a";
}

module.exports = {
  cookieOptions,
  ticketCookie,
  HOME_PAGES,
  sessionKey,
  publicUser,
  startSession,
  rememberDevice,
  isTrustedDevice,
  temporaryPassword
};
