// End-to-end test: starts the server on a throwaway database, walks through every role, then deletes the database.
// Run with: npm test   (MongoDB must be running; your real database is never touched)
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { MongoClient } = require("mongodb");

const root = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });

const PORT = 3999;
const DB_NAME = "barbershop_test";
const BASE = `http://localhost:${PORT}`;
// A small online-queue cap so the "queue is full" check is quick.
const env = { ...process.env, PORT: String(PORT), DB_NAME, MAX_ONLINE_WAITING: "5", HOST: "127.0.0.1" };

let failures = 0;
let checks = 0;
let passed = 0;
let serverOutput = "";

function check(label, condition, detail) {
  checks++;
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : "  -> " + JSON.stringify(detail).slice(0, 300)}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// A browser-like client that keeps its own cookies.
function client() {
  const jar = {};

  return async function request(method, url, body, raw) {
    const headers = {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined || raw) headers["Content-Type"] = "application/json";

    const response = await fetch(BASE + url, {
      method,
      headers,
      redirect: "manual",
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
    });

    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (!value || /Expires=Thu, 01 Jan 1970/i.test(setCookie)) delete jar[name];
      else jar[name] = value;
    }

    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, headers: response.headers };
  };
}

function latestCode() {
  const matches = [...serverOutput.matchAll(/\[2FA\] Verification code for \S+: (\d{6})/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForCode(previous) {
  for (let i = 0; i < 40; i++) {
    const code = latestCode();
    if (code && code !== previous) return code;
    await wait(50);
  }
  return null;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, ["server.js"], { cwd: root, env });
    const timer = setTimeout(() => reject(new Error("Server did not start:\n" + serverOutput)), 15000);

    const collect = chunk => {
      serverOutput += chunk.toString();
      if (serverOutput.includes("Server running")) {
        clearTimeout(timer);
        resolve(server);
      }
    };

    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.on("exit", code => reject(new Error(`Server exited (${code}):\n${serverOutput}`)));
  });
}

async function dropDatabase() {
  const mongo = new MongoClient(env.MONGODB_URI);
  await mongo.connect();
  await mongo.db(DB_NAME).dropDatabase();
  await mongo.close();
}

async function run() {
  const anon = client();
  const admin = client();
  const cashier = client();
  const alice = client();   // guest
  const bob = client();     // guest
  const carla = client();   // customer account

  section("Pages and security headers");
  let r = await anon("GET", "/");
  check("/ redirects to the login page", r.status === 302 && r.headers.get("location") === "/login.html", r.status);
  for (const page of ["/login.html", "/verify.html", "/dashboard.html", "/cashier.html", "/admin.html", "/display.html",
    "/css/app.css", "/css/login.css", "/js/common.js", "/js/desk.js", "/js/admin.js", "/js/cashier.js", "/js/dashboard.js", "/js/login.js", "/js/verify.js", "/js/display.js"]) {
    r = await anon("GET", page);
    check(`GET ${page}`, r.status === 200, r.status);
  }
  check("Content-Security-Policy header is set", Boolean(r.headers.get("content-security-policy")));
  r = await anon("GET", "/api/nope");
  check("Unknown API route -> 404", r.status === 404, r.status);

  section("Public data");
  r = await anon("GET", "/api/services");
  const services = r.json;
  check("8 services with prices and durations", r.status === 200 && services.length === 8 && services.every(s => s.price > 0 && s.durationMinutes > 0), r.json);
  const haircut = services.find(s => s.name === "Haircut");
  const beard = services.find(s => s.name === "Beard Trim");
  r = await anon("GET", "/api/barbers");
  const barbers = r.json;
  check("3 barbers, all available", barbers.length === 3 && barbers.every(b => b.status === "available"), barbers);
  const [barberA, barberB, barberC] = ["Barber A", "Barber B", "Barber C"].map(n => barbers.find(b => b.name === n));

  section("Admin login with email code");
  r = await admin("POST", "/api/auth/login", { email: env.ADMIN_EMAIL, password: "wrong-password" });
  check("Wrong password rejected", r.status === 401, r.status);
  r = await admin("POST", "/api/auth/login", { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
  check("Admin password asks for a code", r.json?.requires2FA === true && r.json.redirectUrl === "/verify.html", r.json);
  const firstCode = await waitForCode(null);
  r = await admin("POST", "/api/auth/resend-code");
  check("Resend code works", r.status === 200, r.json);
  const secondCode = await waitForCode(firstCode);
  check("A new code was issued", Boolean(secondCode) && secondCode !== firstCode);
  r = await admin("POST", "/api/auth/verify-2fa", { code: firstCode });
  check("Old code no longer works", r.status === 401, r.json);
  r = await admin("POST", "/api/auth/verify-2fa", { code: secondCode });
  check("New code signs in and goes to admin page", r.status === 200 && r.json.redirectUrl === "/admin.html", r.json);
  r = await admin("GET", "/api/auth/me");
  check("/me says admin", r.json?.user?.role === "admin", r.json);

  section("Remembered admin device");
  const laptop = client();
  r = await laptop("POST", "/api/auth/login", { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
  const laptopCode = await waitForCode(secondCode);
  r = await laptop("POST", "/api/auth/verify-2fa", { code: laptopCode, remember: true });
  check("Admin verifies and ticks 'remember this device'", r.status === 200, r.json);
  await laptop("POST", "/api/auth/logout");
  r = await laptop("POST", "/api/auth/login", { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
  check("Next login on that device skips the code", r.status === 200 && !r.json.requires2FA && r.json.redirectUrl === "/admin.html", r.json);
  r = await laptop("POST", "/api/auth/login", { email: env.ADMIN_EMAIL, password: "wrong-password" });
  check("A remembered device still needs the right password", r.status === 401, r.status);

  section("Requests from other websites");
  r = await fetch(BASE + "/api/queue", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  check("A change sent from another website is blocked", r.status === 403, r.status);

  section("Staff accounts");
  r = await admin("POST", "/api/staff", { name: "Test Cashier", email: "cashier.test@example.com", role: "cashier" });
  check("Admin creates a cashier with a one-time password", r.status === 201 && r.json.temporaryPassword, r.json);
  const cashierId = r.json?.id;
  const cashierPassword = r.json?.temporaryPassword;
  r = await cashier("POST", "/api/auth/login", { email: "cashier.test@example.com", password: cashierPassword });
  check("Cashier signs in without a code and goes to the front desk", r.status === 200 && r.json.redirectUrl === "/cashier.html", r.json);
  r = await cashier("GET", "/api/auth/me");
  check("Cashier must change the temporary password", r.json?.user?.mustChangePassword === true, r.json);
  r = await cashier("GET", "/api/queue");
  check("Until then, the front desk is blocked", r.status === 403 && r.json.code === "password_change_required", r.json);
  r = await cashier("POST", "/api/auth/change-password", { currentPassword: cashierPassword, newPassword: "weakpass1" });
  check("Staff passwords must be strong", r.status === 400, r.json);
  r = await cashier("POST", "/api/auth/change-password", { currentPassword: cashierPassword, newPassword: "Cashier-Strong-2026!" });
  check("Cashier sets their own strong password", r.status === 200, r.json);
  r = await cashier("GET", "/api/queue");
  check("Now the front desk opens", r.status === 200, r.status);
  r = await cashier("GET", "/api/staff");
  check("Cashier can't manage staff", r.status === 403, r.status);
  r = await cashier("POST", "/api/services", { name: "Hack", price: 1, durationMinutes: 10 });
  check("Cashier can't change services", r.status === 403, r.status);
  r = await cashier("GET", "/api/analytics/summary");
  check("Cashier can't see admin analytics", r.status === 403, r.status);
  r = await admin("PATCH", `/api/staff/${(await admin("GET", "/api/staff")).json.find(s => s.isYou).id}`, { active: false });
  check("Admin can't deactivate themselves", r.status === 400, r.json);

  section("Account lock after repeated wrong passwords");
  r = await admin("POST", "/api/staff", { name: "Lock Test", email: "lock.test@example.com", role: "cashier" });
  const lockId = r.json.id;
  const lockPassword = r.json.temporaryPassword;
  const intruder = client();
  for (let i = 0; i < 5; i++) await intruder("POST", "/api/auth/login", { email: "lock.test@example.com", password: "guess" + i });
  r = await intruder("POST", "/api/auth/login", { email: "lock.test@example.com", password: lockPassword });
  check("After 5 wrong passwords even the right one is refused (locked)", r.status === 429, r.json);
  r = await admin("POST", `/api/staff/${lockId}/reset-password`);
  r = await intruder("POST", "/api/auth/login", { email: "lock.test@example.com", password: r.json.temporaryPassword });
  check("Admin password reset unlocks the account", r.status === 200, r.json);
  r = await anon("POST", "/api/auth/login", { email: "nobody@example.com", password: "whatever1" });
  check("Unknown email gets the same answer as a wrong password", r.status === 401 && r.json.error === "Invalid email or password.", r.json);

  section("Customer accounts");
  r = await carla("POST", "/api/auth/register", { name: "Carla Santos", email: "carla@example.com", password: "short" });
  check("Weak customer password rejected", r.status === 400, r.json);
  r = await carla("POST", "/api/auth/register", { name: "Carla Santos", email: "carla@example.com", phone: "0917", password: "carla12345" });
  check("Customer creates an account", r.status === 201 && r.json.redirectUrl === "/dashboard.html", r.json);
  r = await anon("POST", "/api/auth/register", { name: "Copy", email: "carla@example.com", password: "copy12345" });
  check("Duplicate email rejected", r.status === 409, r.status);
  r = await carla("GET", "/api/queue");
  check("Customer can't open the front desk", r.status === 403, r.status);

  section("Joining the queue");
  r = await alice("POST", "/api/queue", { name: "A", serviceId: haircut.id });
  check("One-letter name rejected", r.status === 400, r.json);
  r = await alice("POST", "/api/queue", { name: "Alice Reyes", serviceId: "nope" });
  check("Missing service rejected", r.status === 400, r.json);
  r = await alice("POST", "/api/queue", { name: "Alice Reyes", serviceId: haircut.id });
  check("Guest Alice joins as #1", r.status === 201 && r.json.ticket.queueNumber === 1 && r.json.ticket.price === haircut.price, r.json);
  r = await alice("POST", "/api/queue", { name: "Alice Reyes", serviceId: haircut.id });
  check("Alice can't join twice", r.status === 409, r.status);
  r = await carla("POST", "/api/queue", { serviceId: beard.id, preferredBarberId: barberB.id });
  check("Carla (account) joins as #2, prefers Barber B", r.status === 201 && r.json.ticket.queueNumber === 2 && r.json.ticket.preferredBarberName === "Barber B", r.json);
  r = await cashier("POST", "/api/queue/walk-in", { name: "Walter Cruz", serviceId: haircut.id });
  check("Cashier adds walk-in Walter as #3", r.status === 201 && r.json.queueNumber === 3 && r.json.source === "walk-in", r.json);
  r = await cashier("POST", "/api/queue/walk-in", { customerEmail: "carla@example.com", serviceId: haircut.id });
  check("Account already in the queue can't be added twice", r.status === 409, r.json);
  r = await bob("POST", "/api/queue", { name: "Bob Lim", serviceId: beard.id });
  check("Guest Bob joins as #4", r.json?.ticket?.queueNumber === 4, r.json);
  r = await bob("POST", "/api/queue/mine/leave");
  check("Bob leaves the queue", r.status === 200, r.json);
  r = await bob("GET", "/api/queue/mine");
  check("Bob no longer has a ticket", r.status === 404, r.status);
  r = await bob("POST", "/api/queue", { name: "Bob Lim", serviceId: beard.id });
  check("Bob can rejoin as #5", r.json?.ticket?.queueNumber === 5, r.json);
  r = await alice("GET", "/api/queue/mine");
  check("Alice sees her ticket, no one ahead", r.json?.ticket?.status === "waiting" && r.json.ticket.peopleAhead === 0, r.json);
  r = await bob("GET", "/api/queue/mine");
  check("Bob has 3 people ahead and a wait estimate", r.json?.ticket?.peopleAhead === 3 && r.json.ticket.estimatedMinutes > 0, r.json);

  r = await anon("GET", "/api/queue/public");
  check("Queue screen shows 4 waiting with short names and no IDs",
    r.json.waiting.length === 4 && r.json.waiting[0].name === "Alice R." && !JSON.stringify(r.json).includes('"id"'), r.json);

  section("Front desk: calling customers");
  r = await cashier("POST", "/api/queue/call-next", { barberId: barberA.id });
  check("Barber A gets #1 Alice", r.status === 200 && r.json.queueNumber === 1 && r.json.barberName === "Barber A", r.json);
  const aliceTicket = r.json.id;
  r = await cashier("POST", "/api/queue/call-next", { barberId: barberA.id });
  check("Barber A can't take a second customer", r.status === 409, r.json);
  r = await cashier("POST", "/api/queue/call-next", { barberId: barberC.id });
  check("Barber C skips Carla (wants B) and gets #3 Walter", r.json?.queueNumber === 3, r.json);
  const walterTicket = r.json.id;
  r = await cashier("POST", "/api/queue/call-next", { barberId: barberB.id });
  check("Barber B gets #2 Carla", r.json?.queueNumber === 2, r.json);
  const carlaTicket = r.json.id;
  r = await anon("GET", "/api/barbers");
  check("All three barbers show as busy", r.json.every(b => b.status === "busy"), r.json.map(b => b.status));
  r = await alice("GET", "/api/queue/mine");
  check("Alice sees it's her turn with Barber A", r.json?.ticket?.status === "serving" && r.json.ticket.barberName === "Barber A", r.json);

  section("Completing visits and payments");
  r = await cashier("POST", `/api/queue/${aliceTicket}/complete`, {});
  check("Payment method is required", r.status === 400, r.json);
  r = await cashier("POST", `/api/queue/${aliceTicket}/complete`, { method: "cash" });
  check("Alice completed at the service price", r.status === 200 && r.json.ticket.amountPaid === haircut.price, r.json);
  r = await cashier("POST", `/api/queue/${aliceTicket}/complete`, { method: "cash" });
  check("Can't complete twice", r.status === 409, r.status);
  r = await cashier("POST", `/api/queue/${carlaTicket}/complete`, { method: "gcash", amount: 50 });
  check("Charging less than the price needs a reason", r.status === 400 && /reason/.test(r.json.error), r.json);
  r = await cashier("POST", `/api/queue/${carlaTicket}/complete`, { method: "gcash", amount: 60, note: "Senior citizen discount" });
  check("Carla completed with a ₱20 discount and a reason", r.json?.ticket?.amountPaid === 60, r.json);
  r = await cashier("POST", `/api/queue/${walterTicket}/no-show`);
  check("Walter marked no-show", r.status === 200, r.json);
  r = await cashier("POST", `/api/queue/${walterTicket}/complete`, { method: "cash" });
  check("A no-show can't be completed", r.status === 409, r.status);
  r = await cashier("POST", "/api/queue/not-an-id/complete", { method: "cash" });
  check("Invalid ticket ID -> 400", r.status === 400, r.status);

  section("Ratings");
  r = await alice("POST", `/api/barbers/${barberB.id}/ratings`, { rating: 5 });
  check("Alice can't rate a barber who didn't serve her", r.status === 403, r.json);
  r = await alice("POST", `/api/barbers/${barberA.id}/ratings`, { rating: 5, comment: "Great cut" });
  check("Alice rates Barber A", r.status === 201, r.json);
  r = await alice("POST", `/api/barbers/${barberA.id}/ratings`, { rating: 4 });
  check("Alice can't rate the same visit twice", r.status === 409, r.status);
  r = await bob("POST", `/api/barbers/${barberA.id}/ratings`, { rating: 1 });
  check("Bob (not served) can't rate", r.status === 403, r.status);
  r = await anon("POST", `/api/barbers/${barberA.id}/ratings`, { rating: 1, customerName: "Alice Reyes", queueNumber: 1, queueDate: "2026-01-01" });
  check("Ratings by name and number alone are no longer accepted", r.status === 403, r.status);
  r = await carla("GET", "/api/queue/history");
  check("Carla's history shows her completed visit", r.json?.length === 1 && r.json[0].status === "completed" && r.json[0].rated === false, r.json);
  r = await carla("POST", `/api/barbers/${barberB.id}/ratings`, { rating: 4, ticketId: aliceTicket });
  check("Carla can't rate Alice's visit", r.status === 403, r.status);
  r = await carla("POST", `/api/barbers/${barberB.id}/ratings`, { rating: 4, ticketId: carlaTicket });
  check("Carla rates Barber B from her history", r.status === 201, r.json);

  section("Shared device");
  r = await alice("POST", "/api/auth/logout");
  r = await alice("GET", "/api/queue/mine");
  check("After log out, the next person doesn't see Alice's ticket", r.status === 404, r.status);

  section("Product sales");
  r = await admin("POST", "/api/inventory", { name: "Pomade", category: "Hair", quantity: 3, minimumStock: 2, price: 250 });
  check("Admin adds Pomade", r.status === 201, r.json);
  const pomadeId = r.json.id;
  r = await cashier("POST", "/api/payments/product-sale", { inventoryId: pomadeId, quantity: 2, method: "cash" });
  check("Cashier sells 2 Pomade", r.status === 201 && r.json.remainingStock === 1 && r.json.payment.amount === 500, r.json);
  r = await cashier("POST", "/api/payments/product-sale", { inventoryId: pomadeId, quantity: 5, method: "cash" });
  check("Can't sell more than in stock", r.status === 409, r.json);
  r = await cashier("GET", "/api/inventory");
  check("Pomade is now flagged low stock", r.json.find(i => i.id === pomadeId)?.lowStock === true, r.json);

  r = await cashier("GET", "/api/payments");
  const expectedTotal = haircut.price + 60 + 500;
  check(`Today's payments total ${expectedTotal}, discounts ₱20`, r.json?.totals?.total === expectedTotal && r.json.totals.byMethod.gcash === 60 && r.json.totals.products === 500 && r.json.totals.discounts === 20, r.json?.totals);
  const pomadeSale = r.json.payments.find(p => p.type === "product");
  r = await cashier("GET", "/api/payments?from=2026-02-30");
  check("Invalid date rejected", r.status === 400, r.status);

  section("Analytics");
  r = await admin("GET", "/api/analytics/summary?range=today");
  const t = r.json?.totals;
  check("Summary counts match", t && t.customers === 5 && t.served === 2 && t.noShows === 1 && t.cancelled === 1 && t.revenue === expectedTotal, t);
  check("Most sold item is Pomade", r.json?.mostSoldItems?.[0]?.name === "Pomade" && r.json.mostSoldItems[0].quantity === 2, r.json?.mostSoldItems);
  check("Top barbers list Barber A and B", r.json?.topBarbers?.length === 2, r.json?.topBarbers);
  r = await admin("GET", "/api/analytics/inventory-monthly");
  check("Monthly report counts 2 sold this month", r.json?.months?.[new Date().getMonth()]?.sold === 2, r.json?.months);

  section("Voiding a payment");
  r = await cashier("POST", `/api/payments/${pomadeSale.id}/void`, { reason: "Mistake" });
  check("A cashier can't void payments", r.status === 403, r.status);
  r = await admin("POST", `/api/payments/${pomadeSale.id}/void`, {});
  check("Voiding needs a reason", r.status === 400, r.json);
  r = await admin("POST", `/api/payments/${pomadeSale.id}/void`, { reason: "Customer returned the pomade" });
  check("Admin voids the pomade sale", r.status === 200, r.json);
  r = await admin("POST", `/api/payments/${pomadeSale.id}/void`, { reason: "Again" });
  check("A payment can't be voided twice", r.status === 409, r.status);
  r = await cashier("GET", "/api/inventory");
  check("Voided items go back into stock", r.json.find(i => i.id === pomadeId)?.quantity === 3, r.json);
  r = await cashier("GET", "/api/payments");
  check("Voided payment no longer counts in totals", r.json.totals.total === haircut.price + 60 && r.json.totals.voided === 1, r.json.totals);

  section("Guest turns into an account");
  const ella = client();
  r = await ella("POST", "/api/queue", { name: "Ella Tan", serviceId: haircut.id, preferredBarberId: barberC.id });
  check("Guest Ella joins and asks for Barber C", r.status === 201 && r.json.ticket.preferredBarberName === "Barber C", r.json);

  section("Managing barbers, reviews and services");
  r = await admin("PATCH", `/api/barbers/${barberC.id}`, { name: "Barber C", specialty: "Fades", experienceYears: 4 });
  check("Admin edits Barber C", r.status === 200, r.json);
  r = await admin("DELETE", `/api/barbers/${barberC.id}`);
  check("Admin removes Barber C", r.status === 200, r.json);
  r = await anon("GET", "/api/barbers");
  check("Removed barber is hidden from customers", !r.json.some(b => b.name === "Barber C"), r.json.map(b => b.name));
  r = await ella("GET", "/api/queue/mine");
  check("Ella, who wanted Barber C, can now be served by anyone", r.json?.ticket?.preferredBarberName === null, r.json);
  r = await admin("PATCH", `/api/barbers/${barberC.id}`, { name: "Barber C", active: true });
  check("Admin restores Barber C", r.status === 200 && (await anon("GET", "/api/barbers")).json.length === 3, r.json);
  r = await ella("POST", "/api/auth/register", { name: "Ella Tan", email: "ella@example.com", password: "ella12345" });
  check("Ella decides to create an account", r.status === 201, r.json);
  r = await ella("GET", "/api/queue/history");
  check("Her visit from today is now in her account", r.json?.length === 1 && r.json[0].customerName === "Ella Tan", r.json);
  r = await admin("GET", `/api/barbers/${barberA.id}/ratings`);
  check("Admin sees Alice's review", r.json?.length === 1 && r.json[0].comment === "Great cut", r.json);
  r = await admin("DELETE", `/api/barbers/ratings/${r.json[0].id}`);
  check("Admin deletes a review", r.status === 200, r.json);
  r = await admin("POST", "/api/services", { name: "Kids Cut", price: 120, durationMinutes: 20 });
  check("Admin adds a service", r.status === 201, r.json);
  const kidsId = r.json.id;
  r = await admin("POST", "/api/services", { name: "Kids Cut", price: 120, durationMinutes: 20 });
  check("Duplicate service rejected", r.status === 409, r.status);
  r = await admin("DELETE", `/api/services/${kidsId}`);
  r = await anon("GET", "/api/services");
  check("Hidden service isn't offered", !r.json.some(s => s.id === kidsId), r.json.length);

  section("Customer records");
  r = await cashier("GET", "/api/customers?search=carla");
  check("Cashier finds Carla with 1 visit and ₱60 spent", r.json?.length === 1 && r.json[0].visits === 1 && r.json[0].spent === 60, r.json);
  r = await cashier("GET", "/api/customers/walk-ins");
  check("Walk-ins list includes Walter", r.json?.some(v => v.customerName === "Walter Cruz"), r.json);
  r = await cashier("POST", "/api/customers", { name: "Walter Cruz", email: "walter@example.com", ticketId: walterTicket });
  check("Walter asks for an account; his walk-in visit is added to it", r.status === 201 && r.json.linkedVisit === true, r.json);
  r = await cashier("GET", `/api/customers/${r.json.id}/visits`);
  check("Walter's account shows that visit", r.json?.length === 1, r.json);
  r = await cashier("POST", "/api/customers", { name: "Dina Cruz", email: "dina@example.com" });
  check("Cashier creates an account for a customer", r.status === 201 && r.json.temporaryPassword, r.json);
  const dinaPassword = r.json.temporaryPassword;
  const dina = client();
  r = await dina("POST", "/api/auth/login", { email: "dina@example.com", password: dinaPassword });
  check("Customer signs in with the one-time password", r.status === 200 && r.json.redirectUrl === "/dashboard.html", r.json);
  r = await dina("POST", "/api/auth/change-password", { currentPassword: "wrong", newPassword: "dina12345" });
  check("Wrong current password rejected", r.status === 400, r.json);
  r = await dina("POST", "/api/auth/delete-account", { password: dinaPassword });
  check("Dina deletes her account", r.status === 200, r.json);
  r = await dina("POST", "/api/auth/login", { email: "dina@example.com", password: dinaPassword });
  check("A deleted account can't sign in", r.status === 401, r.status);
  r = await cashier("GET", "/api/customers?search=dina");
  check("Deleted account no longer appears in customer records", r.json?.length === 0, r.json);

  section("Changing a password signs out other devices");
  const carlaPhone = client();
  r = await carlaPhone("POST", "/api/auth/login", { email: "carla@example.com", password: "carla12345" });
  check("Carla is also signed in on her phone", r.status === 200, r.json);
  r = await carla("POST", "/api/auth/change-password", { currentPassword: "carla12345", newPassword: "carla67890" });
  check("Carla changes her password", r.status === 200, r.json);
  r = await carla("GET", "/api/auth/me");
  check("She stays signed in on this device", r.status === 200, r.status);
  r = await carlaPhone("GET", "/api/auth/me");
  check("Her phone is signed out", r.status === 401, r.status);

  section("Deactivating staff");
  r = await admin("PATCH", `/api/staff/${cashierId}`, { active: false });
  check("Admin deactivates the cashier", r.status === 200, r.json);
  r = await cashier("GET", "/api/auth/me");
  check("Deactivated cashier is signed out immediately", r.status === 401, r.status);
  r = await cashier("POST", "/api/auth/login", { email: "cashier.test@example.com", password: "Cashier-Strong-2026!" });
  check("Deactivated cashier can't sign in", r.status === 401, r.status);

  section("Other");
  r = await anon("POST", "/api/queue", undefined, "{bad json");
  check("Malformed JSON -> 400", r.status === 400, r.status);
  r = await admin("DELETE", "/api/queue");
  check("Admin clears the waiting queue (Bob and Ella)", r.status === 200 && /Cleared 2/.test(r.json.message), r.json);

  section("Flooding the queue");
  let full = null;
  for (let i = 1; i <= 6; i++) {
    r = await client()("POST", "/api/queue", { name: `Bot Number${i}`, serviceId: beard.id });
    if (r.status !== 201) { full = { i, status: r.status, error: r.json?.error }; break; }
  }
  check("Online joins stop when the waiting line is full (test cap: 5)", full?.i === 6 && full.status === 503, full);
  r = await admin("POST", "/api/queue/walk-in", { name: "Real Walk-in", serviceId: beard.id });
  check("Walk-ins can still be added at the counter when online joins are full", r.status === 201, r.json);

  section("Activity log");
  r = await admin("GET", "/api/audit?action=login");
  check("Failed and successful sign-ins are logged", r.json?.some(e => e.action === "login.failed") && r.json.some(e => e.action === "login"), r.json?.map(e => e.action));
  r = await admin("GET", "/api/audit?action=payment");
  check("Discounts and voids are logged with reasons",
    r.json?.some(e => e.action === "payment.discount" && e.details.reason === "Senior citizen discount") && r.json.some(e => e.action === "payment.voided"), r.json);
  r = await admin("GET", "/api/audit");
  check("Barber removal, staff changes and account deletion steps are logged",
    ["barber.removed", "staff.created", "staff.updated", "staff.password-reset", "customer.created", "queue.no-show"].every(a => r.json.some(e => e.action === a)), r.json?.map(e => e.action));
  r = await carla("GET", "/api/audit");
  check("Customers can't read the activity log", r.status === 403, r.status);

  section("Changing the service at payment");
  const haircutBeard = services.find(s => s.name === "Haircut + Beard");
  r = await admin("POST", "/api/queue/call-next", { barberId: barberA.id });
  const switchTicket = r.json;
  check("Barber A calls the next customer (joined for Beard Trim)", r.status === 200 && switchTicket.service === "Beard Trim", r.json);
  r = await admin("POST", `/api/queue/${switchTicket.id}/complete`, { method: "cash", serviceId: "nope" });
  check("An invalid service is rejected", r.status === 400, r.json);
  r = await admin("POST", `/api/queue/${switchTicket.id}/complete`, { method: "cash", serviceId: haircutBeard.id });
  check("Completing as Haircut + Beard charges that price and records that service",
    r.status === 200 && r.json.ticket.service === "Haircut + Beard" && r.json.ticket.amountPaid === haircutBeard.price, r.json);

  r = await admin("POST", "/api/auth/logout");
  r = await admin("GET", "/api/auth/me");
  check("Admin logged out", r.status === 401, r.status);
}

// Tickets from earlier days should be closed when the server starts.
async function addStaleTicket() {
  const mongo = new MongoClient(env.MONGODB_URI);
  await mongo.connect();
  await mongo.db(DB_NAME).collection("queueTickets").insertOne({
    queueDate: "2020-01-01", queueNumber: 1, customerName: "Old Ticket", service: "Haircut",
    status: "waiting", createdAt: new Date("2020-01-01T09:00:00")
  });
  await mongo.close();
}

async function staleTicketStatus() {
  const mongo = new MongoClient(env.MONGODB_URI);
  await mongo.connect();
  const ticket = await mongo.db(DB_NAME).collection("queueTickets").findOne({ customerName: "Old Ticket" });
  await mongo.close();
  return ticket?.status;
}

(async () => {
  let server;
  try {
    await dropDatabase();
    const seed = spawnSync(process.execPath, ["seed.js"], { cwd: root, env, encoding: "utf8" });
    if (seed.status !== 0) throw new Error("Seeding failed:\n" + seed.stderr + seed.stdout);

    await addStaleTicket();
    server = await startServer();

    section("Start-up clean-up");
    check("A ticket left open from an earlier day is closed as expired", await staleTicketStatus() === "expired");

    await run();
  } catch (error) {
    failures++;
    console.error("\nTest run stopped:", error.message);
  } finally {
    if (server) {
      server.removeAllListeners("exit");
      server.kill();
    }
    await dropDatabase().catch(() => {});
  }

  console.log(`\n${passed} of ${checks} checks passed.`);
  process.exit(failures ? 1 : 0);
})();
