function cleanText(value, max = 100) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function strongPassword(password) {
  return typeof password === "string"
    && password.length >= 10
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

module.exports = { cleanText, validEmail, strongPassword, positiveNumber };
