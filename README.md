# Barbershop Queue System

## Setup
Requires Node.js and MongoDB (local or Atlas).

1. Copy `.env.example` to `.env` and fill in `MONGODB_URI`, `JWT_SECRET`, `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
2. `npm install`
3. `npm run seed` creates the admin account and three sample barbers.
4. `npm start` (or double-click `start-server.cmd` on Windows), then open http://localhost:3000

Admin login uses email 2FA. While `SMTP_USER`/`SMTP_PASS` are empty, the 6-digit code is printed in the server terminal instead of emailed.

## Project structure
```
server.js          starts the backend (Express + MongoDB)
seed.js            creates the admin account and sample barbers
routes/            API endpoints, one file per feature
  auth.js            login, 2FA code check, logout
  queue.js           join, my ticket, public queue, call next, complete
  barbers.js         barber profiles, availability, ratings
  inventory.js       products (admin only)
  analytics.js       monthly inventory report
middleware/auth.js login and role checks for protected endpoints
utils/             email sending and input validation
public/            frontend served to the browser
  login.html         admin sign-in, or customer entry by name   (js/login.js)
  verify.html        2FA code entry after admin sign-in        (js/verify.js)
  admin.html         admin dashboard                           (js/script.js, js/navigation.js)
  dashboard.html     customer dashboard                        (js/dashboard.js)
  css/               style.css (shared), login.css, dashboard.css
```

On the admin dashboard only Barbers is connected so far; Analytics shows sample numbers, and the other pages are placeholders.

## Queue behavior
1. Customer enters name and service.
2. Server validates input and creates a queue number.
3. Available barbers are shown.
4. Customer may select an available barber.
5. If no barber is available, the page tells the customer to wait for their number/name to be called.
6. The public queue displays waiting customers and an estimated wait time.
7. Staff/admin calls the next customer.
8. Staff completes the customer and the selected barber becomes available again.

## Inventory analytics
Inventory changes create events in `inventoryEvents`.
The admin dashboard groups those events by month for a selected year.

## Important
The browser UI is NOT the security boundary. Do not rely on hiding buttons to protect admin functions. The API checks the session and role.

For production, also deploy over HTTPS, use a strong JWT secret, keep `.env` out of source control, configure a production SMTP provider, and add CSRF protection if you change the cookie strategy or expose state-changing endpoints cross-site.
