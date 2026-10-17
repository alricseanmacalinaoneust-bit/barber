// Dates use the server's time zone (TZ, default Asia/Manila; set in server.js),
// so "today" starts at local midnight.

function dateKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function todayKey() {
  return dateKey(new Date());
}

function validDateKey(key) {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  return dateKey(startOfDay(key)) === key;
}

// Local midnight at the start of a YYYY-MM-DD day.
function startOfDay(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

module.exports = { dateKey, todayKey, validDateKey, startOfDay, addDays };
