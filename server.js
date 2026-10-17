const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

// Queue days, reports and analytics follow the shop's local time.
process.env.TZ = process.env.TZ || "Asia/Manila";

const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const { MongoClient } = require("mongodb");

const authRoutes = require("./routes/auth");
const queueRoutes = require("./routes/queue");
const barberRoutes = require("./routes/barbers");
const serviceRoutes = require("./routes/services");
const paymentRoutes = require("./routes/payments");
const customerRoutes = require("./routes/customers");
const staffRoutes = require("./routes/staff");
const inventoryRoutes = require("./routes/inventory");
const analyticsRoutes = require("./routes/analytics");

for (const name of ["MONGODB_URI", "JWT_SECRET"]) {
  if (!process.env[name]) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === "production";
const app = express();

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
// The secret enables signed cookies (used for the 2FA step and guest queue tickets).
app.use(cookieParser(process.env.JWT_SECRET));

app.get("/", (req, res) => res.redirect("/login.html"));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.use("/api/auth", authRoutes);
app.use("/api/queue", queueRoutes);
app.use("/api/barbers", barberRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/analytics", analyticsRoutes);

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
    db.collection("loginChallenges").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ]);

  app.locals.db = db;

  app.listen(PORT, () => {
    console.log(`Connected to MongoDB database "${db.databaseName}" (time zone ${process.env.TZ}).`);
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
