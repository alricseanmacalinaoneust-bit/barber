// Front-desk screens shared by the cashier and admin pages, available as window.Desk.
(function () {
  const { api, escapeHTML, money, time, minutesSince, setMessage, statusPill, openDialog } = window.App;

  const METHODS = [
    { value: "cash", label: "Cash" },
    { value: "gcash", label: "GCash" },
    { value: "card", label: "Card" },
    { value: "other", label: "Other" }
  ];

  function methodLabel(value) {
    return METHODS.find(m => m.value === value)?.label || value;
  }

  function methodPicker(name = "method") {
    return `<div class="method-picker">${METHODS.map((m, i) => `
      <label><input type="radio" name="${name}" value="${m.value}"${i === 0 ? " checked" : ""}> ${m.label}</label>`).join("")}
    </div>`;
  }

  function serviceOptions(services) {
    return '<option value="">Select a service</option>' + services.map(s =>
      `<option value="${s.id}">${escapeHTML(s.name)} · ${money(s.price)} · ${s.durationMinutes} min</option>`
    ).join("");
  }

  function emptyRow(columns, text) {
    return `<tr class="empty-row"><td colspan="${columns}">${escapeHTML(text)}</td></tr>`;
  }

  // ---------- Front desk: the live queue ----------

  async function queue(body, actions) {
    actions.innerHTML = '<a class="secondary-btn" href="/display.html" target="_blank" rel="noopener">Open queue screen ↗</a>';

    body.innerHTML = `
      <section class="stats stats-4" id="deskStats"></section>
      <p class="message" id="deskMessage" role="status" aria-live="polite"></p>

      <section class="desk-grid">
        <div class="stack">
          <article class="card">
            <div class="card-heading">
              <h2>Barbers</h2>
              <span class="muted">Call the next customer when a barber is free</span>
            </div>
            <div class="barber-desk" id="barberDesk"></div>
          </article>

          <article class="card">
            <div class="card-heading"><h2>Now serving</h2></div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>#</th><th>Customer</th><th>Service</th><th>Barber</th><th>Started</th><th></th></tr></thead>
                <tbody id="servingRows"></tbody>
              </table>
            </div>
          </article>

          <article class="card">
            <div class="card-heading"><h2>Waiting</h2><span class="muted" id="waitingCount"></span></div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>#</th><th>Customer</th><th>Service</th><th>Prefers</th><th>Waiting</th><th></th></tr></thead>
                <tbody id="waitingRows"></tbody>
              </table>
            </div>
          </article>

          <article class="card">
            <div class="card-heading"><h2>Finished today</h2></div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>#</th><th>Customer</th><th>Service</th><th>Barber</th><th>Status</th><th>Paid</th></tr></thead>
                <tbody id="finishedRows"></tbody>
              </table>
            </div>
          </article>
        </div>

        <form class="card form-card" id="walkInForm">
          <h2>Add a walk-in</h2>
          <p class="muted">For customers at the counter. Add their account email to link the visit to their account.</p>

          <label for="walkInName">Customer name</label>
          <input id="walkInName" name="name" maxlength="60" placeholder="e.g. Juan Dela Cruz">

          <label for="walkInEmail">Account email (optional)</label>
          <input id="walkInEmail" name="customerEmail" type="email" placeholder="customer@example.com">

          <label for="walkInService">Service *</label>
          <select id="walkInService" name="serviceId" required></select>

          <label for="walkInBarber">Preferred barber</label>
          <select id="walkInBarber" name="preferredBarberId"><option value="">Any barber</option></select>

          <div class="form-actions"><button class="primary-btn" type="submit">Add to queue</button></div>
          <p class="message" id="walkInMessage" role="status"></p>
        </form>
      </section>`;

    const $ = id => body.querySelector("#" + id);
    let tickets = [];
    let barbers = [];

    const services = await api("/api/services");
    $("walkInService").innerHTML = serviceOptions(services);

    function render() {
      const waiting = tickets.filter(t => t.status === "waiting");
      const serving = tickets.filter(t => t.status === "serving");
      const finished = tickets.filter(t => !["waiting", "serving"].includes(t.status)).reverse();
      const completed = finished.filter(t => t.status === "completed");
      const collected = completed.reduce((sum, t) => sum + (t.amountPaid || 0), 0);

      $("deskStats").innerHTML = [
        ["Waiting", waiting.length, "Customers in line"],
        ["Being served", serving.length, `${barbers.filter(b => b.status === "available").length} barber(s) free`],
        ["Completed today", completed.length, `${finished.length - completed.length} no-show / cancelled`],
        ["Service sales today", money(collected), "Product sales are under Payments"]
      ].map(([label, value, help]) => `
        <article class="card">
          <div class="stat-label">${label}</div>
          <div class="stat-value">${value}</div>
          <div class="stat-help">${help}</div>
        </article>`).join("");

      $("barberDesk").innerHTML = barbers.length ? barbers.map(b => {
        const current = serving.find(t => t.barberId === b.id);
        const waitingForBarber = waiting.filter(t => !t.preferredBarberId || t.preferredBarberId === b.id).length;

        return `
          <div class="barber-row">
            <div>
              <strong>${escapeHTML(b.name)}</strong>
              <span class="barber-status ${b.status}">${b.status === "busy" && current ? `Serving #${current.queueNumber}` : b.status === "available" ? "Free" : "Off duty"}</span>
              <div class="muted small">${waitingForBarber} customer(s) can be called</div>
            </div>
            <div class="row-actions">
              ${b.status === "available" ? `<button class="primary-btn small" type="button" data-action="call-next" data-barber="${b.id}">Call next</button>` : ""}
              ${b.status !== "busy" ? `<button class="secondary-btn small" type="button" data-action="duty" data-barber="${b.id}" data-on="${!b.available}">${b.available ? "Set off duty" : "Set on duty"}</button>` : ""}
            </div>
          </div>`;
      }).join("") : '<div class="empty-state">No barbers yet. The admin adds barbers on the Barbers page.</div>';

      $("servingRows").innerHTML = serving.length ? serving.map(t => `
        <tr>
          <td><strong>#${t.queueNumber}</strong></td>
          <td>${escapeHTML(t.customerName)}${t.hasAccount ? ' <span class="chip">Account</span>' : ""}</td>
          <td>${escapeHTML(t.service)}<div class="muted small">${money(t.price)}</div></td>
          <td>${escapeHTML(t.barberName)}</td>
          <td>${time(t.calledAt)}</td>
          <td class="row-actions">
            <button class="primary-btn small" type="button" data-action="complete" data-id="${t.id}">Complete &amp; pay</button>
            <button class="secondary-btn small" type="button" data-action="no-show" data-id="${t.id}">No-show</button>
          </td>
        </tr>`).join("") : emptyRow(6, "No one is being served.");

      $("waitingCount").textContent = `${waiting.length} waiting`;
      $("waitingRows").innerHTML = waiting.length ? waiting.map(t => `
        <tr>
          <td><strong>#${t.queueNumber}</strong></td>
          <td>${escapeHTML(t.customerName)}${t.hasAccount ? ' <span class="chip">Account</span>' : ""}${t.source === "walk-in" ? ' <span class="chip">Walk-in</span>' : ""}</td>
          <td>${escapeHTML(t.service)}</td>
          <td>${escapeHTML(t.preferredBarberName || "Any")}</td>
          <td>${minutesSince(t.createdAt)} min</td>
          <td class="row-actions">
            <button class="secondary-btn small" type="button" data-action="call" data-id="${t.id}">Call</button>
            <button class="secondary-btn small" type="button" data-action="no-show" data-id="${t.id}">No-show</button>
            <button class="danger-btn small" type="button" data-action="cancel" data-id="${t.id}">Cancel</button>
          </td>
        </tr>`).join("") : emptyRow(6, "No one is waiting.");

      $("finishedRows").innerHTML = finished.length ? finished.map(t => `
        <tr>
          <td>#${t.queueNumber}</td>
          <td>${escapeHTML(t.customerName)}</td>
          <td>${escapeHTML(t.service)}</td>
          <td>${escapeHTML(t.barberName || "—")}</td>
          <td>${statusPill(t.status)}</td>
          <td>${t.amountPaid != null ? money(t.amountPaid) : "—"}</td>
        </tr>`).join("") : emptyRow(6, "Nothing finished yet today.");

      const barberSelect = $("walkInBarber");
      const chosen = barberSelect.value;
      barberSelect.innerHTML = '<option value="">Any barber</option>' + barbers.map(b => `<option value="${b.id}">${escapeHTML(b.name)}</option>`).join("");
      barberSelect.value = chosen;
    }

    async function refresh() {
      try {
        [tickets, barbers] = await Promise.all([api("/api/queue"), api("/api/barbers")]);
        render();
      } catch (error) {
        setMessage($("deskMessage"), error.message, "error");
      }
    }

    async function act(request, successText) {
      try {
        const result = await request();
        setMessage($("deskMessage"), successText(result), "success");
      } catch (error) {
        setMessage($("deskMessage"), error.message, "error");
      }
      await refresh();
    }

    function completeDialog(ticket) {
      const { element, close } = openDialog(`
        <form id="payForm">
          <h2>Complete #${ticket.queueNumber} · ${escapeHTML(ticket.customerName)}</h2>
          <p class="muted">${escapeHTML(ticket.service)} with ${escapeHTML(ticket.barberName)}. Change the amount for extras or discounts.</p>

          <label for="payAmount">Amount (₱)</label>
          <input id="payAmount" name="amount" type="number" min="0" step="0.01" value="${Number(ticket.price || 0)}" required>

          <label>Payment method</label>
          ${methodPicker()}

          <div id="cashBox">
            <label for="payReceived">Cash received (₱, optional)</label>
            <input id="payReceived" type="number" min="0" step="0.01">
            <p class="muted" id="changeText"></p>
          </div>

          <div class="form-actions">
            <button class="primary-btn" type="submit">Complete and record payment</button>
            <button class="secondary-btn" type="button" data-close>Cancel</button>
          </div>
          <p class="message" id="payMessage"></p>
        </form>`);

      const form = element.querySelector("#payForm");
      const updateChange = () => {
        const amount = Number(form.amount.value) || 0;
        const received = Number(element.querySelector("#payReceived").value);
        element.querySelector("#changeText").textContent = received ? (received >= amount ? `Change: ${money(received - amount)}` : `Short by ${money(amount - received)}`) : "";
      };

      form.addEventListener("input", updateChange);
      form.addEventListener("change", () => {
        element.querySelector("#cashBox").classList.toggle("hidden", form.method.value !== "cash");
      });

      form.addEventListener("submit", async event => {
        event.preventDefault();
        try {
          await api(`/api/queue/${ticket.id}/complete`, {
            method: "POST",
            body: { amount: Number(form.amount.value), method: form.method.value }
          });
          close();
          setMessage($("deskMessage"), `#${ticket.queueNumber} completed. ${money(form.amount.value)} recorded (${methodLabel(form.method.value)}).`, "success");
          await refresh();
        } catch (error) {
          setMessage(element.querySelector("#payMessage"), error.message, "error");
        }
      });
    }

    function callDialog(ticket) {
      const free = barbers.filter(b => b.status === "available");
      if (!free.length) {
        setMessage($("deskMessage"), "No barber is free right now.", "error");
        return;
      }

      const { element, close } = openDialog(`
        <form id="callForm">
          <h2>Call #${ticket.queueNumber} · ${escapeHTML(ticket.customerName)}</h2>
          <p class="muted">${ticket.preferredBarberName ? `Prefers ${escapeHTML(ticket.preferredBarberName)}.` : "No barber preference."}</p>
          <label for="callBarber">Barber</label>
          <select id="callBarber" name="barberId">${free.map(b => `<option value="${b.id}"${b.id === ticket.preferredBarberId ? " selected" : ""}>${escapeHTML(b.name)}</option>`).join("")}</select>
          <div class="form-actions">
            <button class="primary-btn" type="submit">Call customer</button>
            <button class="secondary-btn" type="button" data-close>Cancel</button>
          </div>
          <p class="message" id="callMessage"></p>
        </form>`);

      element.querySelector("#callForm").addEventListener("submit", async event => {
        event.preventDefault();
        try {
          const called = await api(`/api/queue/${ticket.id}/call`, { method: "POST", body: { barberId: event.target.barberId.value } });
          close();
          setMessage($("deskMessage"), `Called #${called.queueNumber} ${called.customerName} to ${called.barberName}.`, "success");
          await refresh();
        } catch (error) {
          setMessage(element.querySelector("#callMessage"), error.message, "error");
        }
      });
    }

    body.addEventListener("click", event => {
      const button = event.target.closest("[data-action]");
      if (!button) return;

      const ticket = tickets.find(t => t.id === button.dataset.id);
      const action = button.dataset.action;

      if (action === "call-next") {
        act(
          () => api("/api/queue/call-next", { method: "POST", body: { barberId: button.dataset.barber } }),
          t => `Now serving #${t.queueNumber} ${t.customerName} with ${t.barberName}.`
        );
      } else if (action === "duty") {
        act(
          () => api(`/api/barbers/${button.dataset.barber}/availability`, { method: "PATCH", body: { available: button.dataset.on === "true" } }),
          () => "Barber availability updated."
        );
      } else if (action === "complete" && ticket) {
        completeDialog(ticket);
      } else if (action === "call" && ticket) {
        callDialog(ticket);
      } else if (action === "no-show" && ticket && confirm(`Mark #${ticket.queueNumber} ${ticket.customerName} as a no-show?`)) {
        act(() => api(`/api/queue/${ticket.id}/no-show`, { method: "POST" }), r => r.message);
      } else if (action === "cancel" && ticket && confirm(`Cancel #${ticket.queueNumber} ${ticket.customerName}?`)) {
        act(() => api(`/api/queue/${ticket.id}/cancel`, { method: "POST" }), r => r.message);
      }
    });

    $("walkInForm").addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.target;

      try {
        const ticket = await api("/api/queue/walk-in", {
          method: "POST",
          body: {
            name: form.name.value,
            customerEmail: form.customerEmail.value,
            serviceId: form.serviceId.value,
            preferredBarberId: form.preferredBarberId.value
          }
        });
        form.reset();
        setMessage($("walkInMessage"), `Added ${ticket.customerName} as #${ticket.queueNumber}.`, "success");
        await refresh();
      } catch (error) {
        setMessage($("walkInMessage"), error.message, "error");
      }
    });

    await refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }

  // ---------- Payments: daily sales, product sales and reports ----------

  async function payments(body, actions) {
    actions.innerHTML = '<button class="secondary-btn" type="button" id="downloadCsv">Download CSV</button>';

    body.innerHTML = `
      <form class="card filter-bar" id="rangeForm">
        <label>From <input type="date" name="from" value="${App.today()}" required></label>
        <label>To <input type="date" name="to" value="${App.today()}" required></label>
        <button class="primary-btn" type="submit">Show</button>
        <button class="secondary-btn" type="button" id="todayBtn">Today</button>
      </form>

      <section class="stats stats-4" id="payTotals"></section>
      <p class="message" id="payPageMessage" role="status"></p>

      <section class="desk-grid">
        <article class="card">
          <div class="card-heading"><h2>Transactions</h2><span class="muted" id="payCount"></span></div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Time</th><th>Item</th><th>Customer</th><th>Barber</th><th>Method</th><th>Cashier</th><th>Amount</th></tr></thead>
              <tbody id="payRows"></tbody>
            </table>
          </div>
        </article>

        <form class="card form-card" id="saleForm">
          <h2>Sell a product</h2>
          <p class="muted">Takes the item out of stock and records the payment.</p>

          <label for="saleItem">Product *</label>
          <select id="saleItem" name="inventoryId" required></select>

          <label for="saleQty">Quantity *</label>
          <input id="saleQty" name="quantity" type="number" min="1" value="1" required>

          <label>Payment method</label>
          ${methodPicker()}

          <p class="sale-total" id="saleTotal"></p>
          <div class="form-actions"><button class="primary-btn" type="submit">Record sale</button></div>
          <p class="message" id="saleMessage" role="status"></p>
        </form>
      </section>`;

    const $ = id => body.querySelector("#" + id);
    const rangeForm = $("rangeForm");
    let report = null;
    let items = [];

    async function loadItems() {
      items = await api("/api/inventory");
      $("saleItem").innerHTML = items.length
        ? '<option value="">Select a product</option>' + items.map(i => `<option value="${i.id}"${i.quantity < 1 ? " disabled" : ""}>${escapeHTML(i.name)} · ${money(i.price)} · ${i.quantity} in stock</option>`).join("")
        : '<option value="">No products yet (admin adds them under Inventory)</option>';
      updateTotal();
    }

    function updateTotal() {
      const item = items.find(i => i.id === $("saleItem").value);
      const qty = Number($("saleQty").value) || 0;
      $("saleTotal").textContent = item ? `Total: ${money(item.price * qty)}` : "";
    }

    async function loadReport() {
      try {
        report = await api(`/api/payments?from=${rangeForm.from.value}&to=${rangeForm.to.value}`);
        const t = report.totals;

        $("payTotals").innerHTML = [
          ["Total collected", money(t.total), `Services ${money(t.services)} · Products ${money(t.products)}`],
          ["Cash", money(t.byMethod.cash), "Should match the cash drawer"],
          ["GCash", money(t.byMethod.gcash), ""],
          ["Card / other", money(t.byMethod.card + t.byMethod.other), ""]
        ].map(([label, value, help]) => `
          <article class="card">
            <div class="stat-label">${label}</div>
            <div class="stat-value">${value}</div>
            <div class="stat-help">${help}</div>
          </article>`).join("");

        $("payCount").textContent = `${t.count} transaction(s)`;
        $("payRows").innerHTML = report.payments.length ? report.payments.map(p => `
          <tr>
            <td>${report.from === report.to ? time(p.createdAt) : App.dateTime(p.createdAt)}</td>
            <td>${escapeHTML(p.description)}${p.quantity ? ` × ${p.quantity}` : ""}${p.queueNumber ? ` <span class="muted small">#${p.queueNumber}</span>` : ""}</td>
            <td>${escapeHTML(p.customerName || "—")}</td>
            <td>${escapeHTML(p.barberName || "—")}</td>
            <td>${methodLabel(p.method)}</td>
            <td>${escapeHTML(p.cashierName)}</td>
            <td><strong>${money(p.amount)}</strong></td>
          </tr>`).join("") : emptyRow(7, "No payments in this period.");
      } catch (error) {
        setMessage($("payPageMessage"), error.message, "error");
      }
    }

    rangeForm.addEventListener("submit", event => {
      event.preventDefault();
      loadReport();
    });

    $("todayBtn").addEventListener("click", () => {
      rangeForm.from.value = App.today();
      rangeForm.to.value = App.today();
      loadReport();
    });

    actions.querySelector("#downloadCsv").addEventListener("click", () => {
      if (!report) return;
      App.downloadCSV(`payments-${report.from}-to-${report.to}.csv`, [
        ["Date and time", "Type", "Item", "Quantity", "Queue #", "Customer", "Barber", "Method", "Cashier", "Amount (PHP)"],
        ...report.payments.map(p => [
          new Date(p.createdAt).toLocaleString("en-PH"), p.type, p.description, p.quantity ?? "", p.queueNumber ?? "",
          p.customerName ?? "", p.barberName ?? "", methodLabel(p.method), p.cashierName, p.amount.toFixed(2)
        ])
      ]);
    });

    $("saleForm").addEventListener("input", updateTotal);
    $("saleForm").addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.target;

      try {
        const result = await api("/api/payments/product-sale", {
          method: "POST",
          body: { inventoryId: form.inventoryId.value, quantity: Number(form.quantity.value), method: form.method.value }
        });
        form.reset();
        setMessage($("saleMessage"), `${result.message} ${money(result.payment.amount)} recorded. ${result.remainingStock} left.`, "success");
        await Promise.all([loadItems(), loadReport()]);
      } catch (error) {
        setMessage($("saleMessage"), error.message, "error");
      }
    });

    await Promise.all([loadItems(), loadReport()]);
  }

  // ---------- Customers: accounts and walk-ins ----------

  async function customers(body, actions) {
    actions.innerHTML = '<button class="primary-btn" type="button" id="newCustomer">+ New customer account</button>';

    body.innerHTML = `
      <form class="card filter-bar" id="customerSearch">
        <input type="search" name="search" placeholder="Search by name, email or phone" aria-label="Search customers">
        <button class="primary-btn" type="submit">Search</button>
      </form>
      <p class="message" id="customerMessage" role="status"></p>

      <article class="card">
        <div class="card-heading"><h2>Customer accounts</h2><span class="muted" id="customerCount"></span></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Visits</th><th>Spent</th><th>Last visit</th><th></th></tr></thead>
            <tbody id="customerRows"></tbody>
          </table>
        </div>
      </article>

      <article class="card spaced">
        <div class="card-heading"><h2>Walk-ins without an account</h2><span class="muted">Last 30 days</span></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Date</th><th>#</th><th>Name</th><th>Service</th><th>Barber</th><th>Status</th><th>Paid</th></tr></thead>
            <tbody id="walkInRows"></tbody>
          </table>
        </div>
      </article>`;

    const $ = id => body.querySelector("#" + id);
    let list = [];

    async function loadCustomers() {
      list = await api(`/api/customers?search=${encodeURIComponent($("customerSearch").search.value)}`);
      $("customerCount").textContent = `${list.length} shown`;
      $("customerRows").innerHTML = list.length ? list.map(c => `
        <tr>
          <td><strong>${escapeHTML(c.name)}</strong></td>
          <td>${escapeHTML(c.email)}</td>
          <td>${escapeHTML(c.phone || "—")}</td>
          <td>${c.visits}</td>
          <td>${money(c.spent)}</td>
          <td>${escapeHTML(c.lastVisit || "—")}</td>
          <td class="row-actions">
            <button class="secondary-btn small" type="button" data-visits="${c.id}">Visits</button>
            <button class="secondary-btn small" type="button" data-reset="${c.id}">Reset password</button>
          </td>
        </tr>`).join("") : emptyRow(7, "No customer accounts found.");
    }

    async function loadWalkIns() {
      const visits = await api("/api/customers/walk-ins");
      $("walkInRows").innerHTML = visits.length ? visits.map(v => `
        <tr>
          <td>${escapeHTML(v.queueDate)}</td>
          <td>#${v.queueNumber}</td>
          <td>${escapeHTML(v.customerName)}</td>
          <td>${escapeHTML(v.service)}</td>
          <td>${escapeHTML(v.barberName || "—")}</td>
          <td>${statusPill(v.status)}</td>
          <td>${v.amountPaid != null ? money(v.amountPaid) : "—"}</td>
        </tr>`).join("") : emptyRow(7, "No walk-in visits in the last 30 days.");
    }

    $("customerSearch").addEventListener("submit", event => {
      event.preventDefault();
      loadCustomers().catch(error => setMessage($("customerMessage"), error.message, "error"));
    });

    actions.querySelector("#newCustomer").addEventListener("click", () => {
      const { element, close } = openDialog(`
        <form id="newCustomerForm">
          <h2>New customer account</h2>
          <p class="muted">Creates an account and a one-time password to give the customer.</p>
          <label for="ncName">Name *</label><input id="ncName" name="name" maxlength="60" required>
          <label for="ncEmail">Email *</label><input id="ncEmail" name="email" type="email" required>
          <label for="ncPhone">Phone</label><input id="ncPhone" name="phone" maxlength="20">
          <div class="form-actions">
            <button class="primary-btn" type="submit">Create account</button>
            <button class="secondary-btn" type="button" data-close>Cancel</button>
          </div>
          <p class="message" id="ncMessage"></p>
        </form>`);

      element.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.target;
        try {
          const result = await api("/api/customers", { method: "POST", body: { name: form.name.value, email: form.email.value, phone: form.phone.value } });
          close();
          App.showTemporaryPassword("Account created", result.name, result.temporaryPassword);
          await loadCustomers();
        } catch (error) {
          setMessage(element.querySelector("#ncMessage"), error.message, "error");
        }
      });
    });

    $("customerRows").addEventListener("click", async event => {
      const visitsId = event.target.closest("[data-visits]")?.dataset.visits;
      const resetId = event.target.closest("[data-reset]")?.dataset.reset;
      const customer = list.find(c => c.id === (visitsId || resetId));
      if (!customer) return;

      try {
        if (visitsId) {
          const visits = await api(`/api/customers/${visitsId}/visits`);
          openDialog(`
            <h2>${escapeHTML(customer.name)}'s visits</h2>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>Date</th><th>Service</th><th>Barber</th><th>Status</th><th>Paid</th></tr></thead>
                <tbody>${visits.length ? visits.map(v => `
                  <tr><td>${escapeHTML(v.queueDate)}</td><td>${escapeHTML(v.service)}</td><td>${escapeHTML(v.barberName || "—")}</td><td>${statusPill(v.status)}</td><td>${v.amountPaid != null ? money(v.amountPaid) : "—"}</td></tr>`).join("") : emptyRow(5, "No visits yet.")}
                </tbody>
              </table>
            </div>
            <div class="form-actions"><button class="secondary-btn" type="button" data-close>Close</button></div>`);
        } else if (confirm(`Reset the password for ${customer.name}?`)) {
          const result = await api(`/api/customers/${resetId}/reset-password`, { method: "POST" });
          App.showTemporaryPassword("Password reset", customer.name, result.temporaryPassword);
        }
      } catch (error) {
        setMessage($("customerMessage"), error.message, "error");
      }
    });

    await Promise.all([loadCustomers(), loadWalkIns()]);
  }

  // ---------- My account: change password ----------

  async function account(body, actions, user) {
    const staff = user && user.role !== "customer";

    body.innerHTML = `
      <form class="card form-card narrow" id="passwordForm">
        <h2>Change password</h2>
        <p class="muted">${staff
          ? "Use at least 10 characters with upper and lower case letters, a number and a symbol."
          : "Use at least 8 characters with letters and numbers."}</p>

        <label for="currentPassword">Current password</label>
        <input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required>

        <label for="newPassword">New password</label>
        <input id="newPassword" name="newPassword" type="password" autocomplete="new-password" required>

        <label for="confirmPassword">Confirm new password</label>
        <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required>

        <div class="form-actions"><button class="primary-btn" type="submit">Change password</button></div>
        <p class="message" id="passwordMessage" role="status"></p>
      </form>`;

    body.querySelector("#passwordForm").addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.target;
      const message = body.querySelector("#passwordMessage");

      if (form.newPassword.value !== form.confirmPassword.value) {
        setMessage(message, "The new passwords don't match.", "error");
        return;
      }

      try {
        await api("/api/auth/change-password", {
          method: "POST",
          body: { currentPassword: form.currentPassword.value, newPassword: form.newPassword.value }
        });
        form.reset();
        setMessage(message, "Password changed.", "success");
        document.getElementById("passwordBanner")?.classList.add("hidden");
      } catch (error) {
        setMessage(message, error.message, "error");
      }
    });
  }

  window.Desk = { queue, payments, customers, account, methodLabel, serviceOptions, emptyRow };
})();
