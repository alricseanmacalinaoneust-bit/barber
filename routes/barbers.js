const express = require("express");
const { requireAuth, optionalAuth, requireRole } = require("../middleware/auth");
const { cleanText, validName, toObjectId } = require("../utils/validation");
const { todayKey } = require("../utils/dates");
const { audit } = require("../utils/security");

const router = express.Router();

// status: "available" (on duty and free), "busy" (serving someone) or "unavailable" (off duty).
async function barberViews(db, filter) {
  const barbers = await db.collection("barbers").find(filter).sort({ name: 1 }).toArray();

  const ratings = await db.collection("barberRatings").aggregate([
    { $group: { _id: "$barberId", averageRating: { $avg: "$rating" }, reviewCount: { $sum: 1 } } }
  ]).toArray();
  const ratingMap = new Map(ratings.map(r => [String(r._id), r]));

  const serving = await db.collection("queueTickets")
    .find({ queueDate: todayKey(), status: "serving" }, { projection: { barberId: 1, queueNumber: 1 } })
    .toArray();
  const servingMap = new Map(serving.map(t => [String(t.barberId), t.queueNumber]));

  return barbers.map(barber => {
    const id = String(barber._id);
    const rating = ratingMap.get(id);
    const servingNumber = servingMap.get(id) ?? null;

    return {
      id,
      name: barber.name,
      active: barber.active !== false,
      available: barber.available === true,
      status: barber.active === false || !barber.available ? "unavailable" : servingNumber ? "busy" : "available",
      servingNumber,
      specialty: barber.specialty || "General Barber",
      bio: barber.bio || "",
      photoUrl: barber.photoUrl || "",
      experienceYears: barber.experienceYears || 0,
      averageRating: rating ? Math.round(rating.averageRating * 10) / 10 : 0,
      reviewCount: rating ? rating.reviewCount : 0
    };
  });
}

function readProfile(body) {
  const name = cleanText(body.name, 60);
  const experienceYears = Number(body.experienceYears ?? 0);

  if (!validName(name)) return { error: "Barber name must be 2 to 60 characters." };
  if (!Number.isInteger(experienceYears) || experienceYears < 0 || experienceYears > 60) {
    return { error: "Years of experience must be a whole number from 0 to 60." };
  }

  return {
    value: {
      name,
      specialty: cleanText(body.specialty, 80),
      bio: cleanText(body.bio, 500),
      photoUrl: cleanText(body.photoUrl, 500),
      experienceYears
    }
  };
}

// Active barbers for customers and the front desk.
router.get("/", async (req, res) => {
  res.json(await barberViews(req.app.locals.db, { active: true }));
});

// ADMIN: all barbers, including removed ones that can be restored.
router.get("/all", requireAuth, requireRole("admin"), async (req, res) => {
  res.json(await barberViews(req.app.locals.db, {}));
});

router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { value, error } = readProfile(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const result = await req.app.locals.db.collection("barbers").insertOne({
      ...value,
      active: true,
      available: true,
      createdAt: new Date()
    });

    res.status(201).json({ id: String(result.insertedId), ...value });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A barber with this name already exists (it may be removed — restore it instead)." });
    throw err;
  }
});

// ADMIN: edit a profile, or restore a removed barber with { active: true }.
router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid barber ID." });

  const { value, error } = readProfile(req.body);
  if (error) return res.status(400).json({ error });

  if (req.body.active === true) value.active = true;

  try {
    const result = await req.app.locals.db.collection("barbers").updateOne({ _id: id }, { $set: value });
    if (!result.matchedCount) return res.status(404).json({ error: "Barber not found." });
    if (value.active) await audit(req, "barber.restored", { barber: value.name });
    res.json({ message: "Barber updated." });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A barber with this name already exists." });
    throw err;
  }
});

// ADMIN: remove a barber. Their past visits and ratings are kept.
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const db = req.app.locals.db;
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid barber ID." });

  const serving = await db.collection("queueTickets").findOne({ barberId: id, status: "serving", queueDate: todayKey() });
  if (serving) return res.status(409).json({ error: `This barber is serving #${serving.queueNumber}. Complete that visit first.` });

  const barber = await db.collection("barbers").findOneAndUpdate({ _id: id }, { $set: { active: false, available: false } });
  if (!barber) return res.status(404).json({ error: "Barber not found." });

  // Customers waiting for this barber can now be called by anyone.
  const released = await db.collection("queueTickets").updateMany(
    { queueDate: todayKey(), status: { $in: ["waiting", "assigned"] }, preferredBarberId: id },
    { $set: { preferredBarberId: null, preferredBarberName: null } }
  );

  await audit(req, "barber.removed", { barber: barber.name, customersReleased: released.modifiedCount });
  res.json({ message: `Barber removed.${released.modifiedCount ? ` ${released.modifiedCount} waiting customer(s) can now be served by any barber.` : ""}` });
});

// ADMIN OR CASHIER: mark a barber on duty (available) or off duty.
router.patch("/:id/availability", requireAuth, requireRole("admin", "cashier"), async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid barber ID." });

  if (typeof req.body.available !== "boolean") {
    return res.status(400).json({ error: "Availability must be true or false." });
  }

  const result = await req.app.locals.db.collection("barbers").updateOne(
    { _id: id, active: true },
    { $set: { available: req.body.available } }
  );

  if (!result.matchedCount) return res.status(404).json({ error: "Barber not found." });
  res.json({ message: "Availability updated." });
});

// ADMIN: read a barber's reviews.
router.get("/:id/ratings", requireAuth, requireRole("admin"), async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid barber ID." });

  const ratings = await req.app.locals.db.collection("barberRatings")
    .find({ barberId: id })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  res.json(ratings.map(r => ({
    id: String(r._id),
    customerName: r.customerName,
    rating: r.rating,
    comment: r.comment,
    createdAt: r.createdAt
  })));
});

// ADMIN: delete a fake or abusive review.
router.delete("/ratings/:ratingId", requireAuth, requireRole("admin"), async (req, res) => {
  const id = toObjectId(req.params.ratingId);
  if (!id) return res.status(400).json({ error: "Invalid review ID." });

  const review = await req.app.locals.db.collection("barberRatings").findOneAndDelete({ _id: id });
  if (!review) return res.status(404).json({ error: "Review not found." });

  await audit(req, "review.deleted", { customer: review.customerName, rating: review.rating, comment: review.comment });
  res.json({ message: "Review deleted." });
});

// CUSTOMER: rate the barber who served a completed visit.
// The visit must be this device's ticket (guests) or belong to the signed-in customer.
router.post("/:id/ratings", optionalAuth, async (req, res) => {
  const db = req.app.locals.db;
  const barberId = toObjectId(req.params.id);
  if (!barberId) return res.status(400).json({ error: "Invalid barber ID." });

  const rating = Number(req.body.rating);
  const comment = cleanText(req.body.comment || "", 500);

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Rating must be from 1 to 5 stars." });
  }

  let ticketFilter;
  if (req.user?.role === "customer") {
    const ticketId = toObjectId(req.body.ticketId);
    if (!ticketId) return res.status(400).json({ error: "Choose the visit you want to rate." });
    ticketFilter = { _id: ticketId, customerId: req.user._id };
  } else {
    const ticketId = toObjectId(req.signedCookies.queueTicket);
    if (!ticketId) return res.status(403).json({ error: "Join the queue and finish your visit before rating a barber." });
    ticketFilter = { _id: ticketId };
  }

  const ticket = await db.collection("queueTickets").findOne({ ...ticketFilter, status: "completed" });
  if (!ticket) return res.status(403).json({ error: "You can rate a barber after your visit is completed." });

  if (!ticket.barberId || !ticket.barberId.equals(barberId)) {
    return res.status(403).json({ error: `You can only rate the barber who served you${ticket.barberName ? ` (${ticket.barberName})` : ""}.` });
  }

  try {
    await db.collection("barberRatings").insertOne({
      barberId,
      queueTicketId: ticket._id,
      customerId: ticket.customerId || null,
      customerName: ticket.customerName,
      rating,
      comment,
      createdAt: new Date()
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "You have already rated this visit." });
    throw error;
  }

  res.status(201).json({ message: "Thank you! Your rating has been submitted." });
});

module.exports = router;
