const { ObjectId } = require("mongodb");

function cleanText(value, max = 100) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Customer and staff names: 2 to 60 characters.
function validName(name) {
  return typeof name === "string" && name.length >= 2 && name.length <= 60;
}

// Staff and admin accounts.
function strongPassword(password) {
  return typeof password === "string"
    && password.length >= 10
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

// Customer accounts.
function basicPassword(password) {
  return typeof password === "string"
    && password.length >= 8
    && /[A-Za-z]/.test(password)
    && /\d/.test(password);
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

// Returns an ObjectId for a valid id string, otherwise null.
function toObjectId(value) {
  return typeof value === "string" && ObjectId.isValid(value) ? new ObjectId(value) : null;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  cleanText,
  validEmail,
  validName,
  strongPassword,
  basicPassword,
  positiveNumber,
  toObjectId,
  escapeRegex
};
