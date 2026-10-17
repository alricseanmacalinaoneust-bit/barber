const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { ObjectId } = require("mongodb");
const { requireAuth } = require("../middleware/auth");
const { cleanText, validEmail } = require("../utils/validation");
const { send2FA } = require("../utils/mailer");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." }
});

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

const cookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production"
};

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

// Step 1: check the password, then email a 6-digit code.
router.post("/login", loginLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const email = cleanText(req.body.email, 254).toLowerCase();
  const password = String(req.body.password ?? "");

  if (!validEmail(email) || !password) {
    return res.status(400).json({ error: "Enter your email and password." });
  }

  const user = await db.collection("users").findOne({ email });
  const passwordOk = user && await bcrypt.compare(password, user.passwordHash);

  if (!passwordOk) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");

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

// Step 2: check the emailed code and start the session.
router.post("/verify-2fa", loginLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const challengeId = req.signedCookies.pending2fa;
  const code = String(req.body.code ?? "").trim();
  const expired = { error: "Your sign-in has expired. Please log in again." };

  if (!challengeId || !ObjectId.isValid(challengeId)) {
    return res.status(401).json(expired);
  }

  const _id = new ObjectId(challengeId);

  // Count the attempt atomically so parallel guesses can't exceed the limit.
  const challenge = await db.collection("loginChallenges").findOneAndUpdate(
    { _id, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_CODE_ATTEMPTS } },
    { $inc: { attempts: 1 } }
  );

  if (!challenge) {
    await db.collection("loginChallenges").deleteOne({ _id });
    res.clearCookie("pending2fa", cookieOptions);
    return res.status(401).json(expired);
  }

  if (!/^\d{6}$/.test(code) || hashCode(code) !== challenge.codeHash) {
    return res.status(401).json({ error: "Incorrect verification code." });
  }

  await db.collection("loginChallenges").deleteOne({ _id });
  res.clearCookie("pending2fa", cookieOptions);

  const user = await db.collection("users").findOne({ _id: challenge.userId });
  if (!user) return res.status(401).json(expired);

  const token = jwt.sign(
    { sub: String(user._id), name: user.name, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: SESSION_TTL_MS / 1000 }
  );

  res.cookie("session", token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
  res.json({ user: { name: user.name, email: user.email, role: user.role } });
});

router.post("/logout", (req, res) => {
  res.clearCookie("session", cookieOptions);
  res.json({ message: "Logged out." });
});

router.get("/me", requireAuth, (req, res) => {
  const { name, email, role } = req.user;
  res.json({ user: { name, email, role } });
});

module.exports = router;
