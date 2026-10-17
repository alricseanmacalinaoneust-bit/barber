const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });
const bcrypt = require("bcryptjs");
const { MongoClient } = require("mongodb");

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || "barbershop");

  const email = String(process.env.ADMIN_EMAIL || "").toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  const name = process.env.ADMIN_NAME || "System Administrator";

  if (!email || !password) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db.collection("users").updateOne(
    { email },
    {
      $set: {
        name,
        email,
        passwordHash,
        role: "admin",
        emailVerified: true,
        updatedAt: new Date()
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );

  const barbers = [
    { name: "Barber A", active: true, available: true },
    { name: "Barber B", active: true, available: true },
    { name: "Barber C", active: true, available: true }
  ];

  for (const barber of barbers) {
    await db.collection("barbers").updateOne(
      { name: barber.name },
      { $setOnInsert: { ...barber, createdAt: new Date() } },
      { upsert: true }
    );
  }

  console.log("Admin and sample barbers created.");
  await client.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
