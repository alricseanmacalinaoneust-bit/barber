// Replaces the database with a backup made by "npm run backup".
// Run with: npm run restore -- backups/<file>.json --yes
// Stop the server first. Everything currently in the database is replaced.
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { MongoClient, BSON } = require("mongodb");

const [file, confirm] = process.argv.slice(2);

if (!file || confirm !== "--yes") {
  console.log("Usage: npm run restore -- backups/<file>.json --yes");
  console.log("This replaces everything in the database with the backup.");
  process.exit(1);
}

(async () => {
  const data = BSON.EJSON.parse(fs.readFileSync(path.resolve(file), "utf8"), { relaxed: false });
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || "barbershop");

  for (const [name, docs] of Object.entries(data)) {
    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs);
    console.log(`Restored ${name} (${docs.length})`);
  }

  await client.close();
  console.log("Done. Start the server again.");
})().catch(error => {
  console.error("Restore failed:", error.message);
  process.exit(1);
});
