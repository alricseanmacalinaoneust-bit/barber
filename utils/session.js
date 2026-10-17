const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

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

function publicUser(user) {
  return {
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword === true
  };
}

function startSession(res, user) {
  const token = jwt.sign(
    { sub: String(user._id), role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: SESSION_TTL_MS / 1000 }
  );

  res.cookie("session", token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
}

// A readable one-time password for accounts created or reset by staff.
function temporaryPassword() {
  return "Temp-" + crypto.randomBytes(6).toString("base64url") + "7a";
}

module.exports = {
  cookieOptions,
  ticketCookie,
  HOME_PAGES,
  publicUser,
  startSession,
  temporaryPassword
};
