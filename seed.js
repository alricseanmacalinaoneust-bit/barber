const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });
const bcrypt = require("bcryptjs");
const { MongoClient } = require("mongodb");

// Starting services. Prices and durations are examples: change them on the admin Services page.
const SERVICES = [
  { name: "Haircut", price: 150, durationMinutes: 30 },
  { name: "Haircut + Beard", price: 200, durationMinutes: 45 },
  { name: "Beard Trim", price: 80, durationMinutes: 15 },
  { name: "Buzz Cut", price: 100, durationMinutes: 20 },
  { name: "Low Taper Fade", price: 200, durationMinutes: 40 },
  { name: "Modern Mullet", price: 250, durationMinutes: 45 },
  { name: "Taper + Mullet", price: 250, durationMinutes: 45 },
  { name: "Others", price: 150, durationMinutes: 30 }
];

// Sample barbers for testing; edit or remove them on the admin Barbers page.
const BARBERS = ["Barber A", "Barber B", "Barber C"];

async function upsertStaff(db, { name, email, password, role }) {
  await db.collection("users").updateOne(
    { email: email.toLowerCase() },
    {
      $set: {
        name,
        email: email.toLowerCase(),
        passwordHash: await bcrypt.hash(password, 12),
        role,
        active: true,
        updatedAt: new Date()
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );
}

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || "barbershop");

  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
  }

  await upsertStaff(db, {
    name: process.env.ADMIN_NAME || "System Administrator",
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    role: "admin"
  });

  if (process.env.CASHIER_EMAIL && process.env.CASHIER_PASSWORD) {
    await upsertStaff(db, {
      name: process.env.CASHIER_NAME || "Cashier",
      email: process.env.CASHIER_EMAIL,
      password: process.env.CASHIER_PASSWORD,
      role: "cashier"
    });
  }

  for (const name of BARBERS) {
    await db.collection("barbers").updateOne(
      { name },
      { $setOnInsert: { name, active: true, available: true, createdAt: new Date() } },
      { upsert: true }
    );
  }

  // Only adds missing services, so prices changed on the Services page are kept.
  for (const service of SERVICES) {
    await db.collection("services").updateOne(
      { name: service.name },
      { $setOnInsert: { ...service, active: true, createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true }
    );
  }

  console.log(`Seeded "${db.databaseName}": admin${process.env.CASHIER_EMAIL ? ", cashier" : ""}, ${BARBERS.length} sample barbers, ${SERVICES.length} services.`);
  await client.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
