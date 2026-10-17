const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { requireAuth } = require("../middleware/auth");
const { cleanText, validEmail, validName, strongPassword, basicPassword, toObjectId } = require("../utils/validation");
const { cookieOptions, HOME_PAGES, publicUser, startSession } = require("../utils/session");
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

const loginLimiter = limiter(10, "Too many login attempts. Try again later.");
const codeLimiter = limiter(10, "Too many verification attempts. Try again later.");
const registerLimiter = limiter(10, "Too many sign-ups from this device. Try again later.");

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function newCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, "0");
}

// One login for everyone. Admins confirm with an emailed code; cashiers and customers go straight in.
router.post("/login", loginLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const email = cleanText(req.body.email, 254).toLowerCase();
  const password = String(req.body.password ?? "");

  if (!validEmail(email) || !password) {
    return res.status(400).json({ error: "Enter your email and password." });
  }

  const user = await db.collection("users").findOne({ email, active: { $ne: false } });
  const passwordOk = user && await bcrypt.compare(password, user.passwordHash);

  if (!passwordOk) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  if (user.role !== "admin") {
    startSession(res, user);
    return res.json({ user: publicUser(user), redirectUrl: HOME_PAGES[user.role] || "/login.html" });
  }

  const code = newCode();
  const challenge = await db.collection("loginChallenges").insertOne({
    userId: user._id,
    codeHash: hashCode(code),
    attempts: 0,
    expiresAt: new Date(Date.now() + CODE_TTL_MS)
  });

  try {
    await send2FA(user.email, code);
  } catch (error) {
    console.error("Failed to send 2FA email:", error);
    await db.collection("loginChallenges").deleteOne({ _id: challenge.insertedId });
    return res.status(502).json({ error: "Could not send the verification email. Check the SMTP settings." });
  }

  res.cookie("pending2fa", String(challenge.insertedId), {
    ...cookieOptions,
    signed: true,
    maxAge: CODE_TTL_MS
  });

  res.json({ requires2FA: true, redirectUrl: "/verify.html" });
});

router.post("/verify-2fa", codeLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const challengeId = toObjectId(req.signedCookies.pending2fa);
  const code = String(req.body.code ?? "").trim();
  const expired = { error: "Your sign-in has expired. Please log in again." };

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

  if (!/^\d{6}$/.test(code) || hashCode(code) !== challenge.codeHash) {
    return res.status(401).json({ error: "Incorrect verification code." });
  }

  await db.collection("loginChallenges").deleteOne({ _id: challengeId });
  res.clearCookie("pending2fa", cookieOptions);

  const user = await db.collection("users").findOne({ _id: challenge.userId, active: { $ne: false } });
  if (!user) return res.status(401).json(expired);

  startSession(res, user);
  res.json({ user: publicUser(user), redirectUrl: HOME_PAGES[user.role] });
});

router.post("/resend-code", codeLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const challengeId = toObjectId(req.signedCookies.pending2fa);
  const expired = { error: "Your sign-in has expired. Please log in again." };

  if (!challengeId) return res.status(401).json(expired);

  const challenge = await db.collection("loginChallenges").findOne({ _id: challengeId, expiresAt: { $gt: new Date() } });
  if (!challenge) return res.status(401).json(expired);

  const user = await db.collection("users").findOne({ _id: challenge.userId, active: { $ne: false } });
  if (!user) return res.status(401).json(expired);

  const code = newCode();
  await db.collection("loginChallenges").updateOne(
    { _id: challengeId },
    { $set: { codeHash: hashCode(code), attempts: 0, expiresAt: new Date(Date.now() + CODE_TTL_MS) } }
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

// Customers create their own account.
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
    createdAt: new Date(),
    updatedAt: new Date()
  };

  try {
    const result = await db.collection("users").insertOne(user);
    user._id = result.insertedId;
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "An account with this email already exists." });
    throw error;
  }

  startSession(res, user);
  res.status(201).json({ user: publicUser(user), redirectUrl: HOME_PAGES.customer });
});

router.post("/logout", (req, res) => {
  // Also forget the guest's queue ticket, so the next person on a shared device starts fresh.
  res.clearCookie("session", cookieOptions);
  res.clearCookie("queueTicket", cookieOptions);
  res.clearCookie("pending2fa", cookieOptions);
  res.json({ message: "Logged out." });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

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

  await db.collection("users").updateOne(
    { _id: user._id },
    { $set: { passwordHash: await bcrypt.hash(newPassword, 12), mustChangePassword: false, updatedAt: new Date() } }
  );

  res.json({ message: "Password changed." });
});

module.exports = router;
