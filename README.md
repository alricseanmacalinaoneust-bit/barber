# Barbershop Queue System

Queue, front desk, payments and analytics for Renz Barbershop. Node.js (Express) + MongoDB.

## Who uses what

| Role | Page | What they do |
|---|---|---|
| Customer (guest) | `/dashboard.html` | Enter a name, join the queue, follow their turn (the page updates itself and alerts them), rate the barber who served them |
| Customer (account) | `/dashboard.html` | Same as a guest, plus visit history and rating past visits |
| Cashier | `/cashier.html` | Front desk: add walk-ins, call the next customer for each barber, complete visits and take payment (cash, GCash, card), sell products, daily payments, customer accounts |
| Admin (owner) | `/admin.html` | Everything the cashier does, plus live analytics, payment reports (CSV), barbers, services and prices, inventory, staff accounts and review moderation |
| Anyone | `/display.html` | Queue screen for a TV in the shop: now serving and next in line (first name and initial only) |

Everyone signs in at `/login.html`. Admins confirm with a 6-digit code sent to their email; cashiers and customers go straight in.

## Setup

Requires Node.js 20+ and MongoDB (local or Atlas).

1. Copy `.env.example` to `.env` and fill it in (database, `JWT_SECRET`, admin and optional cashier login).
2. `npm install`
3. `npm run seed` creates the admin and cashier accounts, three sample barbers and the starting services. Running it again only adds what is missing.
4. `npm start` (or double-click `start-server.cmd` on Windows), then open http://localhost:3000

While `SMTP_USER`/`SMTP_PASS` are empty, admin login codes are printed in the server window instead of emailed.

Service prices from the seed are examples: set the real ones on the admin **Services** page. Replace the sample barbers on the **Barbers** page.

## How a visit works

1. The customer joins online (guest or account), or the cashier adds them as a walk-in. They choose a service and, optionally, a barber.
2. When a barber is free, the cashier presses **Call next** for that barber. The next customer who asked for that barber, or for any barber, is called.
3. The customer's page shows "It's your turn" with a sound; the queue screen shows them under Now serving.
4. When the haircut is done, the cashier presses **Complete & pay**, confirms the amount and payment method, and the payment is recorded.
5. The customer can then rate the barber who served them (once per visit).

Customers can leave the queue themselves. The cashier can call a specific customer, mark a no-show, or cancel.

## Tests

`npm test` starts the server on a separate throwaway database (`barbershop_test`), checks every role and flow (105 checks), then deletes that database. Your real data is never touched. MongoDB must be running.

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
middleware/auth.js   checks the session and role on protected endpoints
utils/               validation, sessions, dates (shop time zone) and email
tests/smoke.js       end-to-end test (npm test)
public/              pages served to the browser
  login.html, verify.html, dashboard.html, cashier.html, admin.html, display.html
  css/app.css          shared design for all dashboards
  css/login.css        login and code pages
  js/common.js         shared helpers (server calls, formatting, dialogs, page switching)
  js/desk.js           front desk, payments, customers and account screens (cashier and admin)
  js/admin.js, cashier.js, dashboard.js, login.js, verify.js, display.js
```

## Important

- The browser is not the security boundary: every API request checks the session and role on the server. Deactivating a staff account signs them out immediately.
- Dates follow the shop's time zone (`TZ`, default `Asia/Manila`), so the queue resets at local midnight even on a server set to UTC.
- For production: serve over HTTPS, set `NODE_ENV=production`, use a strong `JWT_SECRET`, configure SMTP for admin codes, back up the database, and never share `.env`.
