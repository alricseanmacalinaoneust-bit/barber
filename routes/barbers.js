
const express = require("express");
const { ObjectId } = require("mongodb");
const { requireAuth, requireRole } = require("../middleware/auth");
const { cleanText } = require("../utils/validation");

const router = express.Router();

// GET all active barber profiles and their rating summaries.
router.get("/", async (req, res) => {
  try {
    const db = req.app.locals.db;

    const barbers = await db.collection("barbers")
      .find({ active: true })
      .sort({ name: 1 })
      .toArray();

    const ratings = await db.collection("barberRatings")
      .aggregate([
        {
          $group: {
            _id: "$barberId",
            averageRating: { $avg: "$rating" },
            reviewCount: { $sum: 1 }
          }
        }
      ])
      .toArray();

    const ratingMap = new Map(
      ratings.map(r => [String(r._id), r])
    );

    res.json(barbers.map(barber => {
      const rating = ratingMap.get(String(barber._id));

      return {
        id: String(barber._id),
        name: barber.name,
        available: barber.available === true,
        specialty: barber.specialty || "General Barber",
        bio: barber.bio || "",
        photoUrl: barber.photoUrl || "",
        experienceYears: barber.experienceYears || 0,
        averageRating: rating
          ? Math.round(rating.averageRating * 10) / 10
          : 0,
        reviewCount: rating ? rating.reviewCount : 0
      };
    }));
  } catch (error) {
    console.error("Failed to load barbers:", error);
    res.status(500).json({ error: "Unable to load barbers." });
  }
});

// ADMIN: Add a barber.
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const db = req.app.locals.db;
    const name = cleanText(req.body.name, 80);

    if (name.length < 2) {
      return res.status(400).json({
        error: "Barber name must contain at least 2 characters."
      });
    }

    const barber = {
      name,
      active: true,
      available: true,
      specialty: cleanText(req.body.specialty || "", 80),
      bio: cleanText(req.body.bio || "", 500),
      photoUrl: cleanText(req.body.photoUrl || "", 500),
      experienceYears: Number.isInteger(req.body.experienceYears)
        && req.body.experienceYears >= 0
        && req.body.experienceYears <= 60
        ? req.body.experienceYears
        : 0,
      createdAt: new Date()
    };

    const result = await db.collection("barbers").insertOne(barber);

    res.status(201).json({
      id: String(result.insertedId),
      ...barber
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: "A barber with this name already exists."
      });
    }

    console.error("Failed to add barber:", error);
    res.status(500).json({ error: "Unable to add barber." });
  }
});

// ADMIN OR STAFF: Update barber availability.
router.patch(
  "/:id/availability",
  requireAuth,
  requireRole("admin", "staff"),
  async (req, res) => {
    try {
      const db = req.app.locals.db;
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid barber ID." });
      }

      if (typeof req.body.available !== "boolean") {
        return res.status(400).json({
          error: "Availability must be true or false."
        });
      }

      const result = await db.collection("barbers").updateOne(
        { _id: new ObjectId(id), active: true },
        { $set: { available: req.body.available } }
      );

      if (!result.matchedCount) {
        return res.status(404).json({ error: "Barber not found." });
      }

      res.json({ message: "Availability updated." });
    } catch (error) {
      console.error("Failed to update availability:", error);
      res.status(500).json({
        error: "Unable to update availability."
      });
    }
  }
);


/* CUSTOMER: Submit a rating for a barber after a completed visit. */
router.post("/:id/ratings", async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid barber ID." });
    }

    const customerName = cleanText(req.body.customerName, 80);
    const rating = Number(req.body.rating);
    const comment = cleanText(req.body.comment || "", 500);

    if (customerName.length < 2) {
      return res.status(400).json({ error: "Enter your customer name." });
    }

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({
        error: "Rating must be from 1 to 5 stars."
      });
    }

    // Customers rating from their own dashboard are identified by the queue
    // cookie set when they joined; otherwise they enter their queue details.
    const cookieTicketId = req.signedCookies.queueTicket;
    let ticketFilter;

    if (cookieTicketId && ObjectId.isValid(cookieTicketId)) {
      ticketFilter = { _id: new ObjectId(cookieTicketId) };
    } else {
      const queueNumber = Number(req.body.queueNumber);
      const queueDate = cleanText(req.body.queueDate, 10);

      if (!Number.isInteger(queueNumber) || queueNumber < 1) {
        return res.status(400).json({ error: "Enter a valid queue number." });
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(queueDate)) {
        return res.status(400).json({
          error: "Enter the queue date in YYYY-MM-DD format."
        });
      }

      ticketFilter = { queueDate, queueNumber };
    }

    const barberId = new ObjectId(id);

    const ticket = await db.collection("queueTickets").findOne({
      ...ticketFilter,
      customerName: { $regex: "^" + customerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", $options: "i" },
      // Visits without a chosen barber can rate whoever served them.
      barberId: { $in: [barberId, null] },
      status: "completed"
    });

    if (!ticket) {
      return res.status(403).json({
        error: "We couldn't verify a completed visit with this barber. Check your name and queue details."
      });
    }

    try {
      await db.collection("barberRatings").insertOne({
        barberId,
        queueTicketId: ticket._id,
        customerName,
        rating,
        comment,
        createdAt: new Date()
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          error: "This completed queue ticket has already been used to submit a rating."
        });
      }
      throw error;
    }

    res.status(201).json({
      message: "Thank you! Your rating has been submitted."
    });
  } catch (error) {
    console.error("Failed to submit barber rating:", error);
    res.status(500).json({ error: "Unable to submit rating." });
  }
});

module.exports = router;
