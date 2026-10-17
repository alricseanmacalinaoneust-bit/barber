const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText, validEmail, validName, strongPassword, basicPassword, toObjectId } = require("../utils/validation");
const { cookieOptions, HOME_PAGES, publicUser, startSession, rememberDevice, isTrustedDevice } = require("../utils/session");
const { DUMMY_HASH, audit } = require("../utils/security");
const { todayKey } = require("../utils/dates");
const { send2FA } = require("../utils/mailer");

const router = express.Router();

function limiter(limit, message) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message }
  });
}

const loginLimiter = limiter(20, "Too many login attempts from this device. Try again later.");
const codeLimiter = limiter(10, "Too many verification attempts. Try again later.");
const registerLimiter = limiter(10, "Too many sign-ups from this device. Try again later.");

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODE_RESENDS = 3;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

const expired = { error: "Your sign-in has expired. Please log in again." };

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function newCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, "0");
}

// Wrong passwords and wrong codes both count. After 5 in a row the account is
// locked for 15 minutes (except on a device the admin has already verified).
async function recordFailure(db, user) {
  const updated = await db.collection("users").findOneAndUpdate(
    { _id: user._id },
    { $inc: { failedLogins: 1 } },
    { returnDocument: "after" }
  );

  if (updated && updated.failedLogins >= MAX_FAILED_LOGINS) {
    await db.collection("users").updateOne(
      { _id: user._id },
      { $set: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } }
    );
    return true;
  }

  return false;
}

async function clearFailures(db, user) {
  if (user.failedLogins || user.lockedUntil) {
    await db.collection("users").updateOne({ _id: user._id }, { $unset: { failedLogins: "", lockedUntil: "" } });
  }
}

function lockedMessage(user) {
  const minutes = Math.max(1, Math.ceil((user.lockedUntil - Date.now()) / 60000));
  return { error: `Too many failed attempts. This account is locked for ${minutes} more minute(s).` };
}

async function finishLogin(req, res, user, how) {
  await clearFailures(req.app.locals.db, user);
  startSession(res, user);
  req.user = user;
  await audit(req, "login", { how });
  res.json({ user: publicUser(user), redirectUrl: HOME_PAGES[user.role] || "/login.html" });
}

// One login for everyone. Admins also confirm with an emailed code, unless this device was remembered.
router.post("/login", loginLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const email = cleanText(req.body.email, 254).toLowerCase();
  const password = String(req.body.password ?? "");

  if (!validEmail(email) || !password) {
    return res.status(400).json({ error: "Enter your email and password." });
  }

  const user = await db.collection("users").findOne({ email, active: { $ne: false } });
  const trusted = user?.role === "admin" && await isTrustedDevice(req, user);

  if (user?.lockedUntil > new Date() && !trusted) {
    return res.status(429).json(lockedMessage(user));
  }

  const passwordOk = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);

  if (!user || !passwordOk) {
    const locked = user ? await recordFailure(db, user) : false;
    await audit(req, "login.failed", { email, locked });
    return res.status(401).json({ error: "Invalid email or password." });
  }

  if (user.role !== "admin") return finishLogin(req, res, user, "password");
  if (trusted) return finishLogin(req, res, user, "password + remembered device");

  const code = newCode();
  const challenge = await db.collection("loginChallenges").insertOne({
    userId: user._id,
    codeHash: hashCode(code),
    attempts: 0,
    resends: 0,
    expiresAt: new Date(Date.now() + CODE_TTL_MS)
  });

  try {
    await send2FA(user.email, code);
  } catch (error) {
    console.error("Failed to send 2FA email:", error);
    await db.collection("loginChallenges").deleteOne({ _id: challenge.insertedId });
    return res.status(502).json({ error: "Could not send the verification email. Check the SMTP settings." });
  }

  res.cookie("pending2fa", String(challenge.insertedId), { ...cookieOptions, signed: true, maxAge: CODE_TTL_MS });
  res.json({ requires2FA: true, redirectUrl: "/verify.html" });
});

router.post("/verify-2fa", codeLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const challengeId = toObjectId(req.signedCookies.pending2fa);
  const code = String(req.body.code ?? "").trim();

  if (!challengeId) return res.status(401).json(expired);

  // Count the attempt atomically so parallel guesses can't exceed the limit.
  const challenge = await db.collection("loginChallenges").findOneAndUpdate(
    { _id: challengeId, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_CODE_ATTEMPTS } },
    { $inc: { attempts: 1 } }
  );

  if (!challenge) {
    await db.collection("loginChallenges").deleteOne({ _id: challengeId });
    res.clearCookie("pending2fa", cookieOptions);
    return res.status(401).json(expired);
  }

  const user = await db.collection("users").findOne({ _id: challenge.userId, active: { $ne: false } });
  if (!user) return res.status(401).json(expired);
  if (user.lockedUntil > new Date()) return res.status(429).json(lockedMessage(user));

  if (!/^\d{6}$/.test(code) || hashCode(code) !== challenge.codeHash) {
    const locked = await recordFailure(db, user);
    await audit(req, "login.code-failed", { email: user.email, locked });
    return res.status(401).json({ error: locked ? lockedMessage({ lockedUntil: Date.now() + LOCK_MS }).error : "Incorrect verification code." });
  }

  await db.collection("loginChallenges").deleteOne({ _id: challengeId });
  res.clearCookie("pending2fa", cookieOptions);

  if (req.body.remember === true) await rememberDevice(req, res, user);
  await finishLogin(req, res, user, req.body.remember === true ? "password + code (device remembered)" : "password + code");
});

router.post("/resend-code", codeLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const challengeId = toObjectId(req.signedCookies.pending2fa);
  if (!challengeId) return res.status(401).json(expired);

  // A new code doesn't reset the attempt count, and only 3 new codes are allowed per sign-in.
  const challenge = await db.collection("loginChallenges").findOneAndUpdate(
    { _id: challengeId, expiresAt: { $gt: new Date() }, resends: { $lt: MAX_CODE_RESENDS } },
    { $inc: { resends: 1 } }
  );

  if (!challenge) return res.status(429).json({ error: "No more codes can be sent for this sign-in. Please log in again." });

  const user = await db.collection("users").findOne({ _id: challenge.userId, active: { $ne: false } });
  if (!user) return res.status(401).json(expired);

  const code = newCode();
  await db.collection("loginChallenges").updateOne(
    { _id: challengeId },
    { $set: { codeHash: hashCode(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) } }
  );

  try {
    await send2FA(user.email, code);
  } catch (error) {
    console.error("Failed to resend 2FA email:", error);
    return res.status(502).json({ error: "Could not send the verification email. Check the SMTP settings." });
  }

  res.cookie("pending2fa", String(challengeId), { ...cookieOptions, signed: true, maxAge: CODE_TTL_MS });
  res.json({ message: "A new code has been sent." });
});

// Customers create an account only if they want one. A guest's visit from today on this device is kept.
router.post("/register", registerLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const name = cleanText(req.body.name, 60);
  const email = cleanText(req.body.email, 254).toLowerCase();
  const phone = cleanText(req.body.phone, 20);
  const password = String(req.body.password ?? "");

  if (!validName(name)) return res.status(400).json({ error: "Enter your name (2 to 60 characters)." });
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!basicPassword(password)) {
    return res.status(400).json({ error: "Password must be at least 8 characters with letters and numbers." });
  }

  const user = {
    name,
    email,
    phone,
    passwordHash: await bcrypt.hash(password, 12),
    role: "customer",
    active: true,
    sessionVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  try {
    const result = await db.collection("users").insertOne(user);
    user._id = result.insertedId;
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "An account with this email already exists. Sign in instead." });
    throw error;
  }

  const guestTicket = toObjectId(req.signedCookies.queueTicket);
  if (guestTicket) {
    await db.collection("queueTickets").updateOne(
      { _id: guestTicket, queueDate: todayKey(), customerId: null, status: { $ne: "cancelled" } },
      { $set: { customerId: user._id, customerName: name } }
    );
  }

  res.clearCookie("queueTicket", cookieOptions);
  startSession(res, user);
  res.status(201).json({ user: publicUser(user), redirectUrl: HOME_PAGES.customer });
});

router.post("/logout", (req, res) => {
  // Also forget the guest's queue ticket, so the next person on a shared device starts fresh.
  // A remembered admin device stays remembered.
  res.clearCookie("session", cookieOptions);
  res.clearCookie("queueTicket", cookieOptions);
  res.clearCookie("pending2fa", cookieOptions);
  res.json({ message: "Logged out." });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Ends every session of this account (other devices too) and keeps this one signed in.
async function bumpSessions(req, res, extra = {}) {
  const db = req.app.locals.db;
  const user = await db.collection("users").findOneAndUpdate(
    { _id: req.user._id },
    { $inc: { sessionVersion: 1 }, $set: { updatedAt: new Date(), ...extra } },
    { returnDocument: "after" }
  );

  await db.collection("trustedDevices").deleteMany({ userId: req.user._id });
  startSession(res, user);
  return user;
}

router.post("/change-password", requireAuth, async (req, res) => {
  const db = req.app.locals.db;
  const currentPassword = String(req.body.currentPassword ?? "");
  const newPassword = String(req.body.newPassword ?? "");
  const isCustomer = req.user.role === "customer";

  if (isCustomer ? !basicPassword(newPassword) : !strongPassword(newPassword)) {
    return res.status(400).json({
      error: isCustomer
        ? "New password must be at least 8 characters with letters and numbers."
        : "New password must be at least 10 characters with upper and lower case letters, a number and a symbol."
    });
  }

  const user = await db.collection("users").findOne({ _id: req.user._id });
  if (!user || !await bcrypt.compare(currentPassword, user.passwordHash)) {
    return res.status(400).json({ error: "Your current password is incorrect." });
  }

  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    return res.status(400).json({ error: "Choose a password different from your current one." });
  }

  await bumpSessions(req, res, { passwordHash: await bcrypt.hash(newPassword, 12), mustChangePassword: false });
  await audit(req, "password.changed");
  res.json({ message: "Password changed. Other devices have been signed out." });
});

router.post("/logout-everywhere", requireAuth, async (req, res) => {
  await bumpSessions(req, res);
  await audit(req, "sessions.ended");
  res.json({ message: "All other devices have been signed out, and remembered devices forgotten." });
});

// Customers can delete their account. Their name is removed from past visits; the visits stay in the shop's records.
router.post("/delete-account", requireAuth, requireRole("customer"), async (req, res) => {
  const db = req.app.locals.db;
  const user = await db.collection("users").findOne({ _id: req.user._id });

  if (!user || !await bcrypt.compare(String(req.body.password ?? ""), user.passwordHash)) {
    return res.status(400).json({ error: "Your password is incorrect." });
  }

  const label = "Deleted customer";
  await db.collection("users").updateOne(
    { _id: user._id },
    {
      $set: { name: label, email: `deleted-${user._id}@deleted.invalid`, phone: "", active: false, deletedAt: new Date() },
      $inc: { sessionVersion: 1 },
      $unset: { passwordHash: "" }
    }
  );
  await db.collection("queueTickets").updateMany({ customerId: user._id }, { $set: { customerName: label } });
  await db.collection("payments").updateMany({ customerId: user._id }, { $set: { customerName: label } });
  await db.collection("barberRatings").updateMany({ customerId: user._id }, { $set: { customerName: label } });
  await db.collection("queueTickets").updateMany(
    { customerId: user._id, status: { $in: ["waiting", "assigned"] } },
    { $set: { status: "cancelled", endedAt: new Date() } }
  );

  res.clearCookie("session", cookieOptions);
  res.json({ message: "Your account has been deleted." });
});

module.exports = router;
