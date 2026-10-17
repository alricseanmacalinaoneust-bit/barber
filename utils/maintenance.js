const { todayKey } = require("./dates");

// Tickets left waiting or being served on an earlier day are closed as "expired",
// so they don't linger in reports or block anything. Runs at start-up and every hour.
async function closeStaleTickets(db) {
  const result = await db.collection("queueTickets").updateMany(
    { queueDate: { $lt: todayKey() }, status: { $in: ["waiting", "assigned", "serving"] } },
    { $set: { status: "expired", endedAt: new Date() } }
  );

  return result.modifiedCount;
}

module.exports = { closeStaleTickets };
