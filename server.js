const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

// Queue days, reports and analytics follow the shop's local time.
process.env.TZ = process.env.TZ || "Asia/Manila";

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const { MongoClient } = require("mongodb");

for (const name of ["MONGODB_URI", "JWT_SECRET"]) {
  if (!process.env[name]) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
}

if (process.env.JWT_SECRET.length < 32) {
  console.error("JWT_SECRET in .env is too short. Use at least 32 random characters.");
  process.exit(1);
}

const { deriveKey } = require("./utils/security");
const { closeStaleTickets } = require("./utils/maintenance");
const authRoutes = require("./routes/auth");
const queueRoutes = require("./routes/queue");
const barberRoutes = require("./routes/barbers");
const serviceRoutes = require("./routes/services");
const paymentRoutes = require("./routes/payments");
const customerRoutes = require("./routes/customers");
const staffRoutes = require("./routes/staff");
const inventoryRoutes = require("./routes/inventory");
const analyticsRoutes = require("./routes/analytics");
const auditRoutes = require("./routes/audit");

const PORT = Number(process.env.PORT || 3000);
// Only this computer can open the site unless HOST is set (for example HOST=0.0.0.0 for phones on the shop Wi-Fi).
const HOST = process.env.HOST || "127.0.0.1";
const production = process.env.NODE_ENV === "production";
const app = express();

// Behind a hosting proxy (Render, Nginx, ...) set TRUST_PROXY=1 so rate limits see each visitor's real address.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// Security headers. Barber photos may come from any https address.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "img-src": ["'self'", "data:", "https:"],
      ...(production ? {} : { "upgrade-insecure-requests": null })
    }
  },
  ...(production ? {} : { strictTransportSecurity: false })
}));

app.use(express.json({ limit: "20kb" }));
app.use(cookieParser(deriveKey("signed-cookies")));

app.get("/", (req, res) => res.redirect("/login.html"));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Overall limit per address, well above what the pages need (they refresh every few seconds,
// and many phones on the shop Wi-Fi share one address).
app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." }
}));

// Blocks changes sent from other websites (extra protection on top of SameSite cookies).
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const origin = req.get("origin");
  if (!origin) return next();

  try {
    if (new URL(origin).host === req.get("host")) return next();
  } catch {
    // "null" or malformed origins are rejected below.
  }

  res.status(403).json({ error: "This request was blocked." });
});

app.use("/api/auth", authRoutes);
app.use("/api/queue", queueRoutes);
app.use("/api/barbers", barberRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/audit", auditRoutes);

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use((err, req, res, next) => {
  // Malformed JSON bodies and similar client errors carry a 4xx status.
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: "Invalid request." });
  }

  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

async function start() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || "barbershop");

  // The routes rely on these indexes to reject duplicates and stay fast.
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("barbers").createIndex({ name: 1 }, { unique: true }),
    db.collection("services").createIndex({ name: 1 }, { unique: true }),
    db.collection("queueTickets").createIndex({ queueDate: 1, queueNumber: 1 }, { unique: true }),
    db.collection("queueTickets").createIndex({ customerId: 1, createdAt: -1 }),
    // A barber can serve only one customer at a time.
    db.collection("queueTickets").createIndex(
      { queueDate: 1, barberId: 1 },
      { unique: true, partialFilterExpression: { status: "serving" }, name: "one_serving_per_barber" }
    ),
    db.collection("barberRatings").createIndex({ queueTicketId: 1 }, { unique: true }),
    db.collection("payments").createIndex({ createdAt: -1 }),
    db.collection("auditLogs").createIndex({ at: -1 }),
    db.collection("trustedDevices").createIndex({ userId: 1, tokenHash: 1 }),
    db.collection("trustedDevices").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("loginChallenges").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ]);

  app.locals.db = db;

  const closed = await closeStaleTickets(db);
  if (closed) console.log(`Closed ${closed} ticket(s) left open from earlier days.`);
  setInterval(() => closeStaleTickets(db).catch(error => console.error("Ticket clean-up failed:", error.message)), 60 * 60 * 1000);

  app.listen(PORT, HOST, () => {
    console.log(`Connected to MongoDB database "${db.databaseName}" (time zone ${process.env.TZ}).`);
    console.log(`Server running at http://localhost:${PORT}${HOST === "127.0.0.1" ? " (this computer only)" : ` (listening on ${HOST})`}`);
    if (!production) console.log("Development mode: cookies work over plain http. Set NODE_ENV=production when hosting over HTTPS.");
  });
}

start().catch(err => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
