// Saves every collection to backups/<database>-<date>.json. Run with: npm run backup
// Backups contain customer details and password hashes: keep them private (the backups folder is not uploaded to GitHub).
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { MongoClient, BSON } = require("mongodb");

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || "barbershop");

  const data = {};
  for (const { name } of await db.listCollections().toArray()) {
    data[name] = await db.collection(name).find().toArray();
  }

  const folder = path.join(__dirname, "..", "backups");
  fs.mkdirSync(folder, { recursive: true });

  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const file = path.join(folder, `${db.databaseName}-${stamp}.json`);

  fs.writeFileSync(file, BSON.EJSON.stringify(data, null, 1, { relaxed: false }));
  console.log(`Saved ${Object.entries(data).map(([name, docs]) => `${name} (${docs.length})`).join(", ")}`);
  console.log(`Backup: ${file}`);
  await client.close();
})().catch(error => {
  console.error("Backup failed:", error.message);
  process.exit(1);
});
