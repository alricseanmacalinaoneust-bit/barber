# Barbershop Queue System

Queue, front desk, payments and analytics for Renz Barbershop. Node.js (Express) + MongoDB.

## Who uses what

| Role | Page | What they do |
|---|---|---|
| Customer (walk-in) | `/dashboard.html` | Just a name, no account: join the queue, follow their turn (the page updates itself and alerts them), rate the barber who served them |
| Customer (optional account) | `/dashboard.html` | Same, plus visit history, rating past visits, change password, delete account. Only for customers who want one |
| Cashier | `/cashier.html` | Front desk: add walk-ins, call the next customer for each barber, complete visits and take payment (cash, GCash, card), sell products, daily payments, customer accounts |
| Admin (owner) | `/admin.html` | Everything the cashier does, plus live analytics, payment reports (CSV) and voids, barbers, services and prices, inventory, staff accounts, review moderation and the activity log |
| Anyone | `/display.html` | Queue screen for a TV in the shop: now serving and next in line (first name and initial only) |

Everyone starts at `/login.html`. Walk-ins only type their name. Admins confirm with a 6-digit code sent to their email, and can tick "Remember this device for 30 days" so they aren't asked every time.

## Setup

Requires Node.js 20+ and MongoDB (local or Atlas).

1. Copy `.env.example` to `.env` and fill it in (database, `JWT_SECRET`, admin and optional cashier login).
2. `npm install`
3. `npm run seed` creates the admin and cashier accounts, three sample barbers and the starting services. Running it again only adds what is missing.
4. `npm start` (or double-click `start-server.cmd` on Windows), then open http://localhost:3000

While `SMTP_USER`/`SMTP_PASS` are empty, admin login codes are printed in the server window instead of emailed.

By default the site only opens on this computer. To let phones and tablets on the shop Wi-Fi use it, set `HOST=0.0.0.0` in `.env` (and use HTTPS before real customers use it; see Security).

Service prices from the seed are examples: set the real ones on the admin **Services** page. Replace the sample barbers on the **Barbers** page.

## How a visit works

1. The customer joins online (guest or account), or the cashier adds them as a walk-in. They choose a service and, optionally, a barber.
2. When a barber is free, the cashier presses **Call next** for that barber. The next customer who asked for that barber, or for any barber, is called.
3. The customer's page shows "It's your turn" with a sound; the queue screen shows them under Now serving.
4. When the haircut is done, the cashier presses **Complete & pay**, confirms the amount and payment method, and the payment is recorded.
5. The customer can then rate the barber who served them (once per visit).

Customers can leave the queue themselves. The cashier can call a specific customer, mark a no-show, or cancel. Charging less than the price needs a reason. Only the admin can void a payment, with a reason; product sales go back into stock.

Accounts are optional. A walk-in can create one later; their visit from today is kept. The cashier can also create one from a walk-in visit, but only if the customer asks.

## Backups

- `npm run backup` saves the whole database to `backups/` (kept out of GitHub; it contains customer details).
- `npm run restore -- backups/<file>.json --yes` puts a backup back (stop the server first).

Make a backup at least daily once the shop uses the system, and keep a copy off this computer.

## Tests

`npm test` starts the server on a separate throwaway database (`barbershop_test`), checks every role, flow and security rule (143 checks), then deletes that database. Your real data is never touched. MongoDB must be running.

## Project structure

```
server.js            starts the backend: security headers, routes, database indexes
seed.js              creates the admin/cashier accounts, sample barbers and services
start-server.cmd     double-click launcher for Windows
routes/              API endpoints, one file per feature
  auth.js              login, admin email code, customer sign-up, logout, change password
  queue.js             join, my ticket, leave, history, queue screen, walk-ins, call, complete, no-show
  barbers.js           profiles, on/off duty, ratings, review moderation
  services.js          services with prices and durations
  payments.js          payment reports and product sales
  customers.js         customer accounts and walk-in history (cashier and admin)
  staff.js             cashier and admin accounts (admin only)
  inventory.js         products in stock
  analytics.js         live dashboard numbers and monthly product sales
  audit.js             activity log (admin only)
middleware/auth.js   checks the session and role on protected endpoints
utils/               validation, sessions, security helpers, dates (shop time zone), clean-up and email
scripts/             backup and restore
tests/smoke.js       end-to-end test (npm test)
public/              pages served to the browser
  login.html, verify.html, dashboard.html, cashier.html, admin.html, display.html
  css/app.css          shared design for all dashboards
  css/login.css        login and code pages
  js/common.js         shared helpers (server calls, formatting, dialogs, page switching)
  js/desk.js           front desk, payments, customers and account screens (cashier and admin)
  js/admin.js, cashier.js, dashboard.js, login.js, verify.js, display.js
```

## Security

What the system does:

- **Sign-in:** passwords stored with bcrypt. 5 wrong passwords or codes in a row lock the account for 15 minutes (a remembered admin device can still sign in). A wrong email gets the same answer, at the same speed, as a wrong password.
- **Admin code:** 6 digits, 10 minutes, 5 tries, at most 3 new codes per sign-in. "Remember this device" lasts 30 days and is cancelled by a password change or "Sign out all other devices".
- **Sessions:** 8-hour cookies that page scripts can't read, sent only to this site. Changing or resetting a password, deactivating an account or changing a role signs that person out everywhere immediately.
- **One-time passwords:** staff given one by the admin must change it before they can do anything else.
- **Permissions:** every request is checked on the server (customer, cashier, admin). Customers can only see and rate their own visits; ratings are only for the barber who served them.
- **Money:** discounts need a reason, voids are admin-only with a reason, and both are in the activity log and CSV.
- **Abuse limits:** sign-in, sign-up, code and queue-join limits per device, a cap on the online waiting line (`MAX_ONLINE_WAITING`, default 60), and an overall request limit.
- **Browser protections:** security headers (Content-Security-Policy, no framing), changes sent from other websites are blocked, the public queue screen shows only first names and initials, and CSV exports can't run spreadsheet formulas.
- **Activity log:** sign-ins, failed sign-ins, discounts, voids, no-shows, cancellations, and staff, customer, barber, service and inventory changes, with who and when.
- **Privacy:** customers can delete their account; their name is removed from past visits.

Still needed before real customers use it:

1. **HTTPS** (a hosting service or a reverse proxy), with `NODE_ENV=production` and `TRUST_PROXY=1` behind the proxy.
2. **Email** for admin codes (`SMTP_USER`/`SMTP_PASS`).
3. **MongoDB login:** the local MongoDB has no password. Turn on authorization and put the user and password in `MONGODB_URI`, or use MongoDB Atlas with a strong password.
4. **Daily backups** (`npm run backup`), kept off this computer.
5. Change the old MongoDB Atlas password that was shared on Google Drive.
