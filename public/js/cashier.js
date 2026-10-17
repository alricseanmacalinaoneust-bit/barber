// Cashier page: front desk, payments, customers and account.
(async function () {
  const user = await App.requireStaff(["cashier", "admin"]);
  if (!user) return;

  App.mountPages({
    desk: {
      title: "Front Desk",
      eyebrow: "TODAY'S QUEUE",
      description: "Add walk-ins, call customers to free barbers, and take payment when they're done.",
      render: Desk.queue
    },
    payments: {
      title: "Payments",
      eyebrow: "FINANCE",
      description: "Today's sales by payment method, product sales, and past days.",
      render: Desk.payments
    },
    customers: {
      title: "Customers",
      eyebrow: "CUSTOMER RECORDS",
      description: "Customer accounts and walk-in visits.",
      render: Desk.customers
    },
    account: {
      title: "My Account",
      eyebrow: "SECURITY",
      description: "Change your password.",
      render: (body, actions) => Desk.account(body, actions, user)
    }
  }, "desk");
})();
