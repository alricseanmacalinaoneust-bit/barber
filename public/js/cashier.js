// Cashier page: front desk, payments, customers and account.
(async function () {
  const user = await App.requireStaff(["cashier", "admin"]);
  if (!user) return;

  App.mountPages({
    desk: {
      title: "Front Desk",
      eyebrow: "TODAY'S QUEUE",
      description: "Add walk-ins, call customers to free barbers, and take payment when they're done.",
      render: (body, actions) => Desk.queue(body, actions, user)
    },
    payments: {
      title: "Payments",
      eyebrow: "FINANCE",
      description: "Today's sales by payment method, product sales, and past days.",
      render: (body, actions) => Desk.payments(body, actions, user)
    },
    customers: {
      title: "Customers",
      eyebrow: "CUSTOMER RECORDS",
      description: "Optional customer accounts and walk-in visits.",
      render: (body, actions) => Desk.customers(body, actions, user)
    },
    account: {
      title: "My Account",
      eyebrow: "SECURITY",
      description: "Change your password and manage signed-in devices.",
      render: (body, actions) => Desk.account(body, actions, user)
    }
  }, "desk");
})();
