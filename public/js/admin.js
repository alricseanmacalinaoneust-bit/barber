// Admin page: analytics, front desk, payments, customers, barbers, services, inventory, staff and account.
(async function () {
  const { api, escapeHTML, money, setMessage, openDialog } = App;
  const { emptyRow } = Desk;

  const user = await App.requireStaff(["admin"]);
  if (!user) return;

  function statCards(cards) {
    return cards.map(([label, value, help]) => `
      <article class="card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
        <div class="stat-help">${help}</div>
      </article>`).join("");
  }

  function barChart(points) {
    if (!points.some(p => p.count)) return '<div class="empty-state">No customers in this period yet.</div>';
    const max = Math.max(...points.map(p => p.count));

    return `<div class="bar-chart">${points.map(p => `
      <div class="bar-col" title="${escapeHTML(p.label)}: ${p.count}">
        <span class="bar-value">${p.count || ""}</span>
        <div class="bar" style="height:${(p.count / max) * 100}%"></div>
        <span class="bar-label">${escapeHTML(p.label.replace(" ", ""))}</span>
      </div>`).join("")}</div>`;
  }

  function hbarList(rows, empty) {
    if (!rows.length) return `<div class="empty-state">${empty}</div>`;
    const max = Math.max(...rows.map(r => r.value));

    return rows.map(r => `
      <div class="hbar">
        <div class="hbar-top"><span>${escapeHTML(r.label)}</span><strong>${escapeHTML(r.display ?? r.value)}</strong></div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${(r.value / max) * 100}%"></div></div>
      </div>`).join("");
  }

  // ---------- Analytics ----------

  async function analytics(body, actions) {
    actions.innerHTML = `
      <select class="select-input" id="rangeSelect" aria-label="Period">
        <option value="today">Today</option>
        <option value="yesterday">Yesterday</option>
        <option value="week">Last 7 days</option>
        <option value="month">This month</option>
      </select>`;
    const select = actions.querySelector("#rangeSelect");

    async function load() {
      const data = await api(`/api/analytics/summary?range=${select.value}`);
      const t = data.totals;
      const servedRate = t.customers ? Math.round((t.served / t.customers) * 100) : 0;

      body.innerHTML = `
        <section class="stats stats-5">
          ${statCards([
            ["Customers", t.customers, `${t.noShows} no-show · ${t.cancelled} cancelled`],
            ["Served", t.served, `${servedRate}% of customers`],
            ["Average wait", t.averageWaitMinutes == null ? "—" : `${t.averageWaitMinutes} min`, "From joining to being called"],
            ["Revenue", money(t.revenue), `Services ${money(t.serviceRevenue)} · Products ${money(t.productRevenue)}`],
            ["Low-stock items", t.lowStockItems, t.lowStockItems ? '<button class="text-btn" type="button" data-goto="inventory">Check inventory</button>' : "Stock levels are fine"]
          ])}
        </section>

        <section class="admin-grid two">
          <article class="card">
            <div class="card-heading"><h2>Customers throughout the day</h2><span class="muted">By time they joined</span></div>
            ${barChart(data.customersPerHour)}
          </article>
          <article class="card">
            <div class="card-heading"><h2>Popular services</h2><span class="muted">Bookings</span></div>
            ${hbarList(data.popularServices.map(s => ({ label: s.name, value: s.count })), "No bookings in this period yet.")}
          </article>
        </section>

        <section class="admin-grid three">
          <article class="card">
            <div class="card-heading"><h2>Top barbers</h2><button class="text-btn" type="button" data-goto="barbers">View all</button></div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>Barber</th><th>Served</th><th>Rating</th><th>Revenue</th></tr></thead>
                <tbody>${data.topBarbers.length ? data.topBarbers.map(b => `
                  <tr><td>${escapeHTML(b.name)}</td><td>${b.customers}</td><td>${b.averageRating == null ? "—" : `★ ${b.averageRating}`}</td><td>${money(b.revenue)}</td></tr>`).join("") : emptyRow(4, "No completed visits yet.")}
                </tbody>
              </table>
            </div>
          </article>

          <article class="card">
            <div class="card-heading"><h2>Peak hours</h2></div>
            ${hbarList(data.peakHours.map(h => ({ label: h.label, value: h.count, display: `${h.count} customer(s)` })), "No customers in this period yet.")}
          </article>

          <article class="card">
            <div class="card-heading"><h2>Most sold items</h2><button class="text-btn" type="button" data-goto="inventory">View all</button></div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>Product</th><th>Sold</th><th>Revenue</th></tr></thead>
                <tbody>${data.mostSoldItems.length ? data.mostSoldItems.map(i => `
                  <tr><td>${escapeHTML(i.name)}</td><td>${i.quantity}</td><td>${money(i.revenue)}</td></tr>`).join("") : emptyRow(3, "No product sales yet.")}
                </tbody>
              </table>
            </div>
          </article>
        </section>`;
    }

    select.addEventListener("change", () => load().catch(error => { body.innerHTML = `<div class="empty-state">${escapeHTML(error.message)}</div>`; }));
    await load();
  }

  // ---------- Barbers ----------

  async function barbers(body, actions) {
    actions.innerHTML = '<button class="primary-btn" type="button" id="addBarber">+ Add a barber</button>';
    body.innerHTML = '<p class="message" id="barberMessage" role="status"></p><div class="barber-grid" id="barberGrid"></div>';

    const message = body.querySelector("#barberMessage");
    let list = [];

    function cardActions(b) {
      if (!b.active) return `<button class="secondary-btn" type="button" data-restore="${b.id}">Restore</button>`;

      return `
        <button class="secondary-btn" type="button" data-edit="${b.id}">Edit</button>
        <button class="secondary-btn" type="button" data-reviews="${b.id}">Reviews (${b.reviewCount})</button>
        ${b.status !== "busy" ? `<button class="secondary-btn" type="button" data-duty="${b.id}">${b.available ? "Set off duty" : "Set on duty"}</button>` : ""}
        <button class="danger-btn" type="button" data-remove="${b.id}">Remove</button>`;
    }

    async function load() {
      list = await api("/api/barbers/all");
      body.querySelector("#barberGrid").innerHTML = list.length
        ? list.map(b => App.barberCard(b, cardActions(b))).join("")
        : '<div class="empty-state">No barbers yet. Click “Add a barber”.</div>';
    }

    function barberForm(barber) {
      const { element, close } = openDialog(`
        <form id="barberForm">
          <h2>${barber ? `Edit ${escapeHTML(barber.name)}` : "Add a barber"}</h2>
          <div class="form-grid">
            <div><label for="bfName">Full name *</label><input id="bfName" name="name" maxlength="60" required value="${escapeHTML(barber?.name || "")}"></div>
            <div><label for="bfSpecialty">Specialty</label><input id="bfSpecialty" name="specialty" maxlength="80" placeholder="e.g. Fades and classic cuts" value="${escapeHTML(barber?.specialty === "General Barber" ? "" : barber?.specialty || "")}"></div>
            <div><label for="bfPhoto">Photo URL (https)</label><input id="bfPhoto" name="photoUrl" type="url" value="${escapeHTML(barber?.photoUrl || "")}"></div>
            <div><label for="bfYears">Years of experience</label><input id="bfYears" name="experienceYears" type="number" min="0" max="60" value="${barber?.experienceYears || 0}"></div>
            <div class="full"><label for="bfBio">Short biography</label><textarea id="bfBio" name="bio" maxlength="500" rows="3">${escapeHTML(barber?.bio || "")}</textarea></div>
          </div>
          <div class="form-actions">
            <button class="primary-btn" type="submit">Save</button>
            <button class="secondary-btn" type="button" data-close>Cancel</button>
          </div>
          <p class="message" id="bfMessage"></p>
        </form>`);

      element.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const f = event.target;
        const data = {
          name: f.name.value,
          specialty: f.specialty.value,
          photoUrl: f.photoUrl.value,
          experienceYears: Number(f.experienceYears.value),
          bio: f.bio.value
        };

        try {
          await api(barber ? `/api/barbers/${barber.id}` : "/api/barbers", { method: barber ? "PATCH" : "POST", body: data });
          close();
          setMessage(message, barber ? "Barber updated." : "Barber added.", "success");
          await load();
        } catch (error) {
          setMessage(element.querySelector("#bfMessage"), error.message, "error");
        }
      });
    }

    async function reviews(barber) {
      const items = await api(`/api/barbers/${barber.id}/ratings`);
      const { element } = openDialog(`
        <h2>Reviews for ${escapeHTML(barber.name)}</h2>
        <p class="muted">Delete reviews that are fake or abusive.</p>
        <div class="review-list">${items.length ? items.map(r => `
          <div class="review" data-review="${r.id}">
            <div><span class="stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span> <strong>${escapeHTML(r.customerName)}</strong> <span class="muted small">${App.dateTime(r.createdAt)}</span></div>
            ${r.comment ? `<p>${escapeHTML(r.comment)}</p>` : ""}
            <button class="danger-btn small" type="button" data-delete-review="${r.id}">Delete</button>
          </div>`).join("") : '<div class="empty-state">No reviews yet.</div>'}
        </div>
        <div class="form-actions"><button class="secondary-btn" type="button" data-close>Close</button></div>`);

      element.addEventListener("click", async event => {
        const id = event.target.closest("[data-delete-review]")?.dataset.deleteReview;
        if (!id || !confirm("Delete this review?")) return;

        try {
          await api(`/api/barbers/ratings/${id}`, { method: "DELETE" });
          element.querySelector(`[data-review="${id}"]`).remove();
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
    }

    actions.querySelector("#addBarber").addEventListener("click", () => barberForm(null));

    body.addEventListener("click", async event => {
      const button = event.target.closest("button");
      if (!button) return;
      const id = button.dataset.edit || button.dataset.reviews || button.dataset.duty || button.dataset.remove || button.dataset.restore;
      const barber = list.find(b => b.id === id);
      if (!barber) return;

      try {
        if (button.dataset.edit) barberForm(barber);
        else if (button.dataset.reviews) await reviews(barber);
        else if (button.dataset.duty) {
          await api(`/api/barbers/${id}/availability`, { method: "PATCH", body: { available: !barber.available } });
          setMessage(message, `${barber.name} is now ${barber.available ? "off duty" : "on duty"}.`, "success");
          await load();
        } else if (button.dataset.remove && confirm(`Remove ${barber.name}? Their past visits and reviews are kept.`)) {
          await api(`/api/barbers/${id}`, { method: "DELETE" });
          setMessage(message, `${barber.name} removed.`, "success");
          await load();
        } else if (button.dataset.restore) {
          await api(`/api/barbers/${id}`, { method: "PATCH", body: { ...barber, active: true } });
          setMessage(message, `${barber.name} restored.`, "success");
          await load();
        }
      } catch (error) {
        setMessage(message, error.message, "error");
      }
    });

    await load();
  }

  // ---------- Services ----------

  async function services(body, actions) {
    actions.innerHTML = '<button class="primary-btn" type="button" id="addService">+ Add a service</button>';
    body.innerHTML = `
      <p class="message" id="serviceMessage" role="status"></p>
      <article class="card">
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Service</th><th>Price</th><th>Duration</th><th>Status</th><th></th></tr></thead>
            <tbody id="serviceRows"></tbody>
          </table>
        </div>
      </article>
      <p class="muted small spaced">Prices are charged by default at the front desk (the cashier can adjust them). Durations are used for wait-time estimates.</p>`;

    const message = body.querySelector("#serviceMessage");
    let list = [];

    async function load() {
      list = await api("/api/services/all");
      body.querySelector("#serviceRows").innerHTML = list.length ? list.map(s => `
        <tr class="${s.active ? "" : "inactive"}">
          <td><strong>${escapeHTML(s.name)}</strong></td>
          <td>${money(s.price)}</td>
          <td>${s.durationMinutes} min</td>
          <td>${s.active ? '<span class="status-pill completed">Offered</span>' : '<span class="status-pill cancelled">Hidden</span>'}</td>
          <td class="row-actions">
            <button class="secondary-btn small" type="button" data-edit="${s.id}">Edit</button>
            ${s.active
              ? `<button class="danger-btn small" type="button" data-hide="${s.id}">Hide</button>`
              : `<button class="secondary-btn small" type="button" data-show="${s.id}">Offer again</button>`}
          </td>
        </tr>`).join("") : emptyRow(5, "No services yet.");
    }

    function serviceForm(service) {
      const { element, close } = openDialog(`
        <form>
          <h2>${service ? `Edit ${escapeHTML(service.name)}` : "Add a service"}</h2>
          <label for="sfName">Name *</label><input id="sfName" name="name" maxlength="60" required value="${escapeHTML(service?.name || "")}">
          <div class="form-grid">
            <div><label for="sfPrice">Price (₱) *</label><input id="sfPrice" name="price" type="number" min="0" step="0.01" required value="${service?.price ?? ""}"></div>
            <div><label for="sfDuration">Duration (minutes) *</label><input id="sfDuration" name="durationMinutes" type="number" min="5" max="480" required value="${service?.durationMinutes ?? 30}"></div>
          </div>
          <div class="form-actions">
            <button class="primary-btn" type="submit">Save</button>
            <button class="secondary-btn" type="button" data-close>Cancel</button>
          </div>
          <p class="message" id="sfMessage"></p>
        </form>`);

      element.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const f = event.target;
        const data = { name: f.name.value, price: Number(f.price.value), durationMinutes: Number(f.durationMinutes.value) };

        try {
          await api(service ? `/api/services/${service.id}` : "/api/services", { method: service ? "PATCH" : "POST", body: data });
          close();
          setMessage(message, "Service saved.", "success");
          await load();
        } catch (error) {
          setMessage(element.querySelector("#sfMessage"), error.message, "error");
        }
      });
    }

    actions.querySelector("#addService").addEventListener("click", () => serviceForm(null));

    body.addEventListener("click", async event => {
      const button = event.target.closest("button");
      const service = button && list.find(s => s.id === (button.dataset.edit || button.dataset.hide || button.dataset.show));
      if (!service) return;

      try {
        if (button.dataset.edit) serviceForm(service);
        else if (button.dataset.hide && confirm(`Hide ${service.name} from customers?`)) {
          await api(`/api/services/${service.id}`, { method: "DELETE" });
          await load();
        } else if (button.dataset.show) {
          await api(`/api/services/${service.id}`, { method: "PATCH", body: { ...service, active: true } });
          await load();
        }
      } catch (error) {
        setMessage(message, error.message, "error");
      }
    });

    await load();
  }

  // ---------- Inventory ----------

  async function inventory(body, actions) {
    actions.innerHTML = '<button class="primary-btn" type="button" id="addItem">+ Add a product</button>';
    body.innerHTML = `
      <p class="message" id="itemMessage" role="status"></p>
      <article class="card">
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Product</th><th>Category</th><th>In stock</th><th>Minimum</th><th>Price</th><th>Status</th><th></th></tr></thead>
            <tbody id="itemRows"></tbody>
          </table>
        </div>
      </article>
      <article class="card spaced">
        <div class="card-heading"><h2>Products sold per month</h2><span class="muted">${new Date().getFullYear()}</span></div>
        <div id="monthlyChart"></div>
      </article>`;

    const message = body.querySelector("#itemMessage");
    let list = [];

    async function load() {
      const [items, monthly] = await Promise.all([api("/api/inventory"), api("/api/analytics/inventory-monthly")]);
      list = items;

      body.querySelector("#itemRows").innerHTML = list.length ? list.map(i => `
        <tr>
          <td><strong>${escapeHTML(i.name)}</strong></td>
          <td>${escapeHTML(i.category || "—")}</td>
          <td>${i.quantity}</td>
          <td>${i.minimumStock}</td>
          <td>${money(i.price)}</td>
          <td>${i.lowStock ? '<span class="status-pill no-show">Low stock</span>' : '<span class="status-pill completed">OK</span>'}</td>
          <td class="row-actions">
            <button class="secondary-btn small" type="button" data-edit="${i.id}">Edit</button>
            <button class="danger-btn small" type="button" data-delete="${i.id}">Delete</button>
          </td>
        </tr>`).join("") : emptyRow(7, "No products yet. Click “Add a product”.");

      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      body.querySelector("#monthlyChart").innerHTML = barChart(monthly.months.map(m => ({ label: months[m.month - 1], count: m.sold })))
        .replace("No customers in this period yet.", "No products sold this year yet.");
    }

    function itemForm(item) {
      const { element, close } = openDialog(`
        <form>
          <h2>${item ? `Edit ${escapeHTML(item.name)}` : "Add a product"}</h2>
          <div class="form-grid">
            <div><label for="ifName">Name *</label><input id="ifName" name="name" maxlength="100" required value="${escapeHTML(item?.name || "")}"></div>
            <div><label for="ifCategory">Category</label><input id="ifCategory" name="category" maxlength="60" placeholder="e.g. Hair products" value="${escapeHTML(item?.category || "")}"></div>
            <div><label for="ifQty">In stock *</label><input id="ifQty" name="quantity" type="number" min="0" required value="${item?.quantity ?? 0}"></div>
            <div><label for="ifMin">Minimum stock *</label><input id="ifMin" name="minimumStock" type="number" min="0" required value="${item?.minimumStock ?? 5}"></div>
            <div><label for="ifPrice">Selling price (₱) *</label><input id="ifPrice" name="price" type="number" min="0" step="0.01" required value="${item?.price ?? ""}"></div>
          </div>
          <div class="form-actions">
            <button class="primary-btn" type="submit">Save</button>
            <button class="secondary-btn" type="button" data-close>Cancel</button>
          </div>
          <p class="message" id="ifMessage"></p>
        </form>`);

      element.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const f = event.target;
        const data = {
          name: f.name.value,
          category: f.category.value,
          quantity: Number(f.quantity.value),
          minimumStock: Number(f.minimumStock.value),
          price: Number(f.price.value)
        };

        try {
          await api(item ? `/api/inventory/${item.id}` : "/api/inventory", { method: item ? "PATCH" : "POST", body: data });
          close();
          setMessage(message, "Product saved.", "success");
          await load();
        } catch (error) {
          setMessage(element.querySelector("#ifMessage"), error.message, "error");
        }
      });
    }

    actions.querySelector("#addItem").addEventListener("click", () => itemForm(null));

    body.addEventListener("click", async event => {
      const button = event.target.closest("button");
      const item = button && list.find(i => i.id === (button.dataset.edit || button.dataset.delete));
      if (!item) return;

      try {
        if (button.dataset.edit) itemForm(item);
        else if (confirm(`Delete ${item.name}?`)) {
          await api(`/api/inventory/${item.id}`, { method: "DELETE" });
          setMessage(message, `${item.name} deleted.`, "success");
          await load();
        }
      } catch (error) {
        setMessage(message, error.message, "error");
      }
    });

    await load();
  }

  // ---------- Staff ----------

  async function staff(body, actions) {
    actions.innerHTML = '<button class="primary-btn" type="button" id="addStaff">+ Add staff</button>';
    body.innerHTML = `
      <p class="message" id="staffMessage" role="status"></p>
      <article class="card">
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
            <tbody id="staffRows"></tbody>
          </table>
        </div>
      </article>
      <p class="muted small spaced">Cashiers run the front desk: queue, payments and customers. Admins can also manage barbers, services, inventory, staff and reports.</p>`;

    const message = body.querySelector("#staffMessage");
    let list = [];

    async function load() {
      list = await api("/api/staff");
      body.querySelector("#staffRows").innerHTML = list.map(s => `
        <tr class="${s.active ? "" : "inactive"}">
          <td><strong>${escapeHTML(s.name)}</strong>${s.isYou ? ' <span class="chip">You</span>' : ""}</td>
          <td>${escapeHTML(s.email)}</td>
          <td>${s.role === "admin" ? "Admin" : "Cashier"}</td>
          <td>${s.active ? '<span class="status-pill completed">Active</span>' : '<span class="status-pill cancelled">Deactivated</span>'}</td>
          <td class="row-actions">${s.isYou ? "" : `
            <button class="secondary-btn small" type="button" data-role="${s.id}">${s.role === "admin" ? "Make cashier" : "Make admin"}</button>
            <button class="secondary-btn small" type="button" data-reset="${s.id}">Reset password</button>
            <button class="${s.active ? "danger-btn" : "secondary-btn"} small" type="button" data-toggle="${s.id}">${s.active ? "Deactivate" : "Activate"}</button>`}
          </td>
        </tr>`).join("");
    }

    actions.querySelector("#addStaff").addEventListener("click", () => {
      const { element, close } = openDialog(`
        <form>
          <h2>Add staff</h2>
          <label for="stName">Name *</label><input id="stName" name="name" maxlength="60" required>
          <label for="stEmail">Email *</label><input id="stEmail" name="email" type="email" required>
          <label for="stRole">Role</label>
          <select id="stRole" name="role"><option value="cashier">Cashier</option><option value="admin">Admin</option></select>
          <div class="form-actions">
            <button class="primary-btn" type="submit">Create account</button>
            <button class="secondary-btn" type="button" data-close>Cancel</button>
          </div>
          <p class="message" id="stMessage"></p>
        </form>`);

      element.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const f = event.target;
        try {
          const result = await api("/api/staff", { method: "POST", body: { name: f.name.value, email: f.email.value, role: f.role.value } });
          close();
          App.showTemporaryPassword("Staff account created", result.name, result.temporaryPassword);
          await load();
        } catch (error) {
          setMessage(element.querySelector("#stMessage"), error.message, "error");
        }
      });
    });

    body.addEventListener("click", async event => {
      const button = event.target.closest("button");
      const member = button && list.find(s => s.id === (button.dataset.role || button.dataset.reset || button.dataset.toggle));
      if (!member) return;

      try {
        if (button.dataset.role) {
          const role = member.role === "admin" ? "cashier" : "admin";
          if (!confirm(`Make ${member.name} ${role === "admin" ? "an admin" : "a cashier"}?`)) return;
          await api(`/api/staff/${member.id}`, { method: "PATCH", body: { role } });
        } else if (button.dataset.reset) {
          if (!confirm(`Reset the password for ${member.name}?`)) return;
          const result = await api(`/api/staff/${member.id}/reset-password`, { method: "POST" });
          App.showTemporaryPassword("Password reset", member.name, result.temporaryPassword);
        } else {
          if (!confirm(`${member.active ? "Deactivate" : "Activate"} ${member.name}?`)) return;
          await api(`/api/staff/${member.id}`, { method: "PATCH", body: { active: !member.active } });
        }
        await load();
      } catch (error) {
        setMessage(message, error.message, "error");
      }
    });

    await load();
  }

  const router = App.mountPages({
    analytics: { title: "Analytics", eyebrow: "SHOP PERFORMANCE", description: "Live numbers from the queue and payments.", render: analytics },
    desk: { title: "Front Desk", eyebrow: "TODAY'S QUEUE", description: "Add walk-ins, call customers to free barbers, and take payment.", render: Desk.queue },
    payments: { title: "Payments & Reports", eyebrow: "FINANCE", description: "Sales for any date range, by payment method. Download as CSV for Excel.", render: Desk.payments },
    customers: { title: "Customers", eyebrow: "CUSTOMER RECORDS", description: "Customer accounts and walk-in visits.", render: Desk.customers },
    barbers: { title: "Barbers", eyebrow: "MEET THE TEAM", description: "Add, edit or remove barbers, set who is on duty, and moderate reviews.", render: barbers },
    services: { title: "Services", eyebrow: "SERVICES AND PRICES", description: "What customers can choose, with prices and durations.", render: services },
    inventory: { title: "Inventory", eyebrow: "STOCK", description: "Products in stock. Items at or below their minimum are flagged.", render: inventory },
    staff: { title: "Staff", eyebrow: "ACCOUNTS", description: "Cashier and admin accounts.", render: staff },
    account: { title: "My Account", eyebrow: "SECURITY", description: "Change your password.", render: (body, actions) => Desk.account(body, actions, user) }
  }, "analytics");

  // Shortcuts such as "View all" on the analytics page.
  document.getElementById("pageContent").addEventListener("click", event => {
    const target = event.target.closest("[data-goto]");
    if (target) router.open(target.dataset.goto);
  });
})();
