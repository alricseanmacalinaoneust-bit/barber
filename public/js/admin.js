// Admin page: analytics, front desk, payments, customers, barbers, services, inventory, staff, activity and account.
(async function () {
  const { api, escapeHTML, money, setMessage, openDialog, confirmDialog, toast, busy } = App;
  const { emptyRow, statCards } = Desk;

  const user = await App.requireStaff(["admin"]);
  if (!user) return;

  function barChart(points, emptyText) {
    if (!points.some(p => p.count)) return `<div class="empty-state">${escapeHTML(emptyText)}</div>`;
    const max = Math.max(...points.map(p => p.count));

    return `<div class="bar-chart" role="img" aria-label="${escapeHTML(points.map(p => `${p.label}: ${p.count}`).join(", "))}">${points.map(p => `
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
      </select>
      <button class="secondary-btn" type="button" id="refreshAnalytics">Refresh</button>`;
    const select = actions.querySelector("#rangeSelect");

    async function load() {
      const data = await api(`/api/analytics/summary?range=${select.value}`);
      const t = data.totals;
      const servedRate = t.customers ? Math.round((t.served / t.customers) * 100) : 0;
      const period = select.selectedOptions[0].textContent.toLowerCase();

      body.innerHTML = `
        <section class="stats stats-5">
          ${statCards([
            ["Customers", t.customers, `${t.noShows} no-show · ${t.cancelled} cancelled`],
            ["Served", t.served, t.customers ? `${servedRate}% of customers` : `None ${period}`],
            ["Average wait", t.averageWaitMinutes == null ? "—" : `${t.averageWaitMinutes} min`, "From joining to being called"],
            ["Revenue", money(t.revenue), `Services ${money(t.serviceRevenue)} · Products ${money(t.productRevenue)}${t.discounts ? ` · Discounts ${money(t.discounts)}` : ""}`],
            ["Low-stock items", t.lowStockItems, t.lowStockItems ? '<button class="text-btn" type="button" data-goto="inventory">Check inventory</button>' : "Stock levels are fine"]
          ])}
        </section>

        <section class="admin-grid two">
          <article class="card">
            <div class="card-heading"><h2>Customers throughout the day</h2><span class="muted">By the time they joined</span></div>
            ${barChart(data.customersPerHour, `No customers ${period} yet.`)}
          </article>
          <article class="card">
            <div class="card-heading"><h2>Popular services</h2><span class="muted">Bookings</span></div>
            ${hbarList(data.popularServices.map(s => ({ label: s.name, value: s.count })), `No bookings ${period} yet.`)}
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
            ${hbarList(data.peakHours.map(h => ({ label: h.label, value: h.count, display: `${h.count} customer(s)` })), `No customers ${period} yet.`)}
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

    const reload = () => load().catch(error => toast(error.message, "error"));
    select.addEventListener("change", reload);
    actions.querySelector("#refreshAnalytics").addEventListener("click", event => busy(event.target, reload));
    await load();
  }

  // ---------- Barbers ----------

  async function barbers(body, actions) {
    actions.innerHTML = '<button class="primary-btn" type="button" id="addBarber">+ Add a barber</button>';
    body.innerHTML = '<div class="barber-grid" id="barberGrid"></div>';
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
        <form>
          <h2>${barber ? `Edit ${escapeHTML(barber.name)}` : "Add a barber"}</h2>
          <div class="form-grid">
            <div><label for="bfName">Full name *</label><input id="bfName" name="name" maxlength="60" required value="${escapeHTML(barber?.name || "")}"></div>
            <div><label for="bfSpecialty">Specialty</label><input id="bfSpecialty" name="specialty" maxlength="80" placeholder="e.g. Fades and classic cuts" value="${escapeHTML(barber?.specialty === "General Barber" ? "" : barber?.specialty || "")}"></div>
            <div><label for="bfPhoto">Photo URL (https)</label><input id="bfPhoto" name="photoUrl" type="url" placeholder="https://…" value="${escapeHTML(barber?.photoUrl || "")}"></div>
            <div><label for="bfYears">Years of experience</label><input id="bfYears" name="experienceYears" type="number" min="0" max="60" value="${barber?.experienceYears || 0}"></div>
            <div class="full"><label for="bfBio">Short biography</label><textarea id="bfBio" name="bio" maxlength="500" rows="3">${escapeHTML(barber?.bio || "")}</textarea></div>
          </div>
          <div class="form-actions">
            <button class="primary-btn" type="submit">${barber ? "Save changes" : "Add barber"}</button>
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

        await busy(event.submitter, async () => {
          try {
            await api(barber ? `/api/barbers/${barber.id}` : "/api/barbers", { method: barber ? "PATCH" : "POST", body: data });
            close();
            await load();
            toast(barber ? `${data.name} updated.` : `${data.name} added.`);
          } catch (error) {
            setMessage(element.querySelector("#bfMessage"), error.message, "error");
          }
        });
      });
    }

    async function reviews(barber) {
      const items = await api(`/api/barbers/${barber.id}/ratings`);
      const { element } = openDialog(`
        <h2>Reviews for ${escapeHTML(barber.name)}</h2>
        <p class="muted">Delete reviews that are fake or abusive. Deleting is recorded in the activity log.</p>
        <div class="review-list">${items.length ? items.map(r => `
          <div class="review" data-review="${r.id}">
            <div><span class="stars" aria-label="${r.rating} out of 5">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span> <strong>${escapeHTML(r.customerName)}</strong> <span class="muted small">${App.dateTime(r.createdAt)}</span></div>
            ${r.comment ? `<p>${escapeHTML(r.comment)}</p>` : '<p class="muted small">No comment.</p>'}
            <button class="danger-btn small" type="button" data-delete-review="${r.id}">Delete</button>
          </div>`).join("") : '<div class="empty-state">No reviews yet.</div>'}
        </div>
        <div class="form-actions"><button class="secondary-btn" type="button" data-close>Close</button></div>`);

      element.addEventListener("click", async event => {
        const button = event.target.closest("[data-delete-review]");
        if (!button) return;
        const id = button.dataset.deleteReview;
        if (!await confirmDialog("Delete this review? It can't be brought back.", { title: "Delete review", confirmText: "Delete", danger: true })) return;

        try {
          await api(`/api/barbers/ratings/${id}`, { method: "DELETE" });
          element.querySelector(`[data-review="${id}"]`)?.remove();
          await load();
          toast("Review deleted.");
        } catch (error) {
          toast(error.message, "error");
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
          await busy(button, () => api(`/api/barbers/${id}/availability`, { method: "PATCH", body: { available: !barber.available } }));
          await load();
          toast(`${barber.name} is now ${barber.available ? "off duty" : "on duty"}.`);
        } else if (button.dataset.remove) {
          if (!await confirmDialog(`Remove ${barber.name}? Customers waiting for them can then be served by anyone. Past visits and reviews are kept, and you can restore them later.`, { title: "Remove barber", confirmText: "Remove", danger: true })) return;
          const result = await api(`/api/barbers/${id}`, { method: "DELETE" });
          await load();
          toast(result.message);
        } else if (button.dataset.restore) {
          await busy(button, () => api(`/api/barbers/${id}`, { method: "PATCH", body: { ...barber, active: true } }));
          await load();
          toast(`${barber.name} restored.`);
        }
      } catch (error) {
        toast(error.message, "error");
      }
    });

    await load();
  }

  // ---------- Services ----------

  async function services(body, actions) {
    actions.innerHTML = '<button class="primary-btn" type="button" id="addService">+ Add a service</button>';
    body.innerHTML = `
      <article class="card">
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Service</th><th>Price</th><th>Duration</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody id="serviceRows"></tbody>
          </table>
        </div>
      </article>
      <p class="muted small spaced">The price is charged by default at the front desk (the cashier can adjust it, with a reason for discounts). Durations are used for wait-time estimates.</p>`;

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
            <button class="primary-btn" type="submit">${service ? "Save changes" : "Add service"}</button>
            <button class="secondary-btn" type="button" data-close>Cancel</button>
          </div>
          <p class="message" id="sfMessage"></p>
        </form>`);

      element.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const f = event.target;
        const data = { name: f.name.value, price: Number(f.price.value), durationMinutes: Number(f.durationMinutes.value) };

        await busy(event.submitter, async () => {
          try {
            await api(service ? `/api/services/${service.id}` : "/api/services", { method: service ? "PATCH" : "POST", body: { ...data, active: service ? service.active : true } });
            close();
            await load();
            toast(`${data.name} saved.`);
          } catch (error) {
            setMessage(element.querySelector("#sfMessage"), error.message, "error");
          }
        });
      });
    }

    actions.querySelector("#addService").addEventListener("click", () => serviceForm(null));

    body.addEventListener("click", async event => {
      const button = event.target.closest("button");
      const service = button && list.find(s => s.id === (button.dataset.edit || button.dataset.hide || button.dataset.show));
      if (!service) return;

      try {
        if (button.dataset.edit) serviceForm(service);
        else if (button.dataset.hide) {
          if (!await confirmDialog(`Hide ${service.name}? Customers won't be able to choose it. Past visits keep it, and you can offer it again later.`, { title: "Hide service", confirmText: "Hide", danger: true })) return;
          await api(`/api/services/${service.id}`, { method: "DELETE" });
          await load();
          toast(`${service.name} hidden.`);
        } else if (button.dataset.show) {
          await busy(button, () => api(`/api/services/${service.id}`, { method: "PATCH", body: { ...service, active: true } }));
          await load();
          toast(`${service.name} is offered again.`);
        }
      } catch (error) {
        toast(error.message, "error");
      }
    });

    await load();
  }

  // ---------- Inventory ----------

  async function inventory(body, actions) {
    actions.innerHTML = '<button class="primary-btn" type="button" id="addItem">+ Add a product</button>';
    body.innerHTML = `
      <article class="card">
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Product</th><th>Category</th><th>In stock</th><th>Minimum</th><th>Price</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody id="itemRows"></tbody>
          </table>
        </div>
      </article>
      <article class="card spaced">
        <div class="card-heading"><h2>Products sold per month</h2><span class="muted">${new Date().getFullYear()}</span></div>
        <div id="monthlyChart"></div>
      </article>`;

    let list = [];

    async function load() {
      const [items, monthly] = await Promise.all([api("/api/inventory"), api("/api/analytics/inventory-monthly")]);
      list = items;

      body.querySelector("#itemRows").innerHTML = list.length ? list.map(i => `
        <tr class="${i.lowStock ? "long-wait" : ""}">
          <td><strong>${escapeHTML(i.name)}</strong></td>
          <td>${escapeHTML(i.category || "—")}</td>
          <td>${i.quantity}</td>
          <td>${i.minimumStock}</td>
          <td>${money(i.price)}</td>
          <td>${i.quantity < 1 ? '<span class="status-pill no-show">Out of stock</span>' : i.lowStock ? '<span class="status-pill waiting">Low stock</span>' : '<span class="status-pill completed">OK</span>'}</td>
          <td class="row-actions">
            <button class="primary-btn small" type="button" data-restock="${i.id}">+ Stock</button>
            <button class="secondary-btn small" type="button" data-edit="${i.id}">Edit</button>
            <button class="danger-btn small" type="button" data-delete="${i.id}">Delete</button>
          </td>
        </tr>`).join("") : emptyRow(7, "No products yet. Click “Add a product”.");

      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      body.querySelector("#monthlyChart").innerHTML = barChart(monthly.months.map(m => ({ label: months[m.month - 1], count: m.sold })), "No products sold this year yet.");
    }

    async function saveItem(item, data) {
      return api(item ? `/api/inventory/${item.id}` : "/api/inventory", { method: item ? "PATCH" : "POST", body: data });
    }

    function itemForm(item) {
      const { element, close } = openDialog(`
        <form>
          <h2>${item ? `Edit ${escapeHTML(item.name)}` : "Add a product"}</h2>
          <div class="form-grid">
            <div><label for="ifName">Name *</label><input id="ifName" name="name" maxlength="100" required value="${escapeHTML(item?.name || "")}"></div>
            <div><label for="ifCategory">Category</label><input id="ifCategory" name="category" maxlength="60" placeholder="e.g. Hair products" value="${escapeHTML(item?.category || "")}"></div>
            <div><label for="ifQty">In stock *</label><input id="ifQty" name="quantity" type="number" min="0" required value="${item?.quantity ?? 0}"></div>
            <div><label for="ifMin">Warn when stock is at or below *</label><input id="ifMin" name="minimumStock" type="number" min="0" required value="${item?.minimumStock ?? 5}"></div>
            <div><label for="ifPrice">Selling price (₱) *</label><input id="ifPrice" name="price" type="number" min="0" step="0.01" required value="${item?.price ?? ""}"></div>
          </div>
          <div class="form-actions">
            <button class="primary-btn" type="submit">${item ? "Save changes" : "Add product"}</button>
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

        await busy(event.submitter, async () => {
          try {
            await saveItem(item, data);
            close();
            await load();
            toast(`${data.name} saved.`);
          } catch (error) {
            setMessage(element.querySelector("#ifMessage"), error.message, "error");
          }
        });
      });
    }

    // Quick restock: add delivered items without editing the whole product.
    function restockForm(item) {
      const { element, close } = openDialog(`
        <form>
          <h2>Add stock: ${escapeHTML(item.name)}</h2>
          <p class="muted">Currently ${item.quantity} in stock.</p>
          <label for="rsQty">How many arrived? *</label>
          <input id="rsQty" name="added" type="number" min="1" max="10000" required value="1">
          <div class="form-actions">
            <button class="primary-btn" type="submit">Add to stock</button>
            <button class="secondary-btn" type="button" data-close>Cancel</button>
          </div>
          <p class="message" id="rsMessage"></p>
        </form>`);

      element.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const added = Number(event.target.added.value);
        await busy(event.submitter, async () => {
          try {
            await saveItem(item, { name: item.name, category: item.category, quantity: item.quantity + added, minimumStock: item.minimumStock, price: item.price });
            close();
            await load();
            toast(`Added ${added} × ${item.name}. Now ${item.quantity + added} in stock.`);
          } catch (error) {
            setMessage(element.querySelector("#rsMessage"), error.message, "error");
          }
        });
      });
    }

    actions.querySelector("#addItem").addEventListener("click", () => itemForm(null));

    body.addEventListener("click", async event => {
      const button = event.target.closest("button");
      const item = button && list.find(i => i.id === (button.dataset.edit || button.dataset.delete || button.dataset.restock));
      if (!item) return;

      try {
        if (button.dataset.restock) restockForm(item);
        else if (button.dataset.edit) itemForm(item);
        else {
          if (!await confirmDialog(`Delete ${item.name}? Past sales stay in the reports.`, { title: "Delete product", confirmText: "Delete", danger: true })) return;
          await api(`/api/inventory/${item.id}`, { method: "DELETE" });
          await load();
          toast(`${item.name} deleted.`);
        }
      } catch (error) {
        toast(error.message, "error");
      }
    });

    await load();
  }

  // ---------- Staff ----------

  async function staff(body, actions) {
    actions.innerHTML = '<button class="primary-btn" type="button" id="addStaff">+ Add staff</button>';
    body.innerHTML = `
      <article class="card">
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody id="staffRows"></tbody>
          </table>
        </div>
      </article>
      <p class="muted small spaced">Cashiers run the front desk: queue, payments and customers. Admins can also manage barbers, services, inventory, staff, reports and the activity log. New staff must change their one-time password before they can do anything.</p>`;

    let list = [];

    async function load() {
      list = await api("/api/staff");
      body.querySelector("#staffRows").innerHTML = list.map(s => `
        <tr class="${s.active ? "" : "inactive"}">
          <td><strong>${escapeHTML(s.name)}</strong>${s.isYou ? ' <span class="chip">You</span>' : ""}</td>
          <td>${escapeHTML(s.email)}</td>
          <td>${s.role === "admin" ? "Admin" : "Cashier"}</td>
          <td>${s.active ? '<span class="status-pill completed">Active</span>' : '<span class="status-pill cancelled">Deactivated</span>'}</td>
          <td class="row-actions">${s.isYou ? '<span class="muted small">Change your own password under My Account</span>' : `
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
        await busy(event.submitter, async () => {
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
    });

    body.addEventListener("click", async event => {
      const button = event.target.closest("button");
      const member = button && list.find(s => s.id === (button.dataset.role || button.dataset.reset || button.dataset.toggle));
      if (!member) return;

      try {
        if (button.dataset.role) {
          const role = member.role === "admin" ? "cashier" : "admin";
          if (!await confirmDialog(`Make ${member.name} ${role === "admin" ? "an admin" : "a cashier"}? They will be signed out and must sign in again.`, { title: "Change role", confirmText: role === "admin" ? "Make admin" : "Make cashier" })) return;
          await api(`/api/staff/${member.id}`, { method: "PATCH", body: { role } });
          toast(`${member.name} is now ${role === "admin" ? "an admin" : "a cashier"}.`);
        } else if (button.dataset.reset) {
          if (!await confirmDialog(`Reset the password for ${member.name}? They will be signed out everywhere and get a one-time password.`, { title: "Reset password", confirmText: "Reset password" })) return;
          const result = await api(`/api/staff/${member.id}/reset-password`, { method: "POST" });
          App.showTemporaryPassword("Password reset", member.name, result.temporaryPassword);
        } else {
          const turnOff = member.active;
          if (!await confirmDialog(`${turnOff ? "Deactivate" : "Activate"} ${member.name}?${turnOff ? " They will be signed out immediately and can't sign in." : ""}`, { title: turnOff ? "Deactivate staff" : "Activate staff", confirmText: turnOff ? "Deactivate" : "Activate", danger: turnOff })) return;
          await api(`/api/staff/${member.id}`, { method: "PATCH", body: { active: !member.active } });
          toast(`${member.name} ${turnOff ? "deactivated" : "activated"}.`);
        }
        await load();
      } catch (error) {
        toast(error.message, "error");
      }
    });

    await load();
  }

  // ---------- Activity log ----------

  const ACTION_LABELS = {
    "login": "Signed in",
    "login.failed": "Failed sign-in",
    "login.code-failed": "Wrong email code",
    "password.changed": "Changed password",
    "sessions.ended": "Signed out other devices",
    "payment.discount": "Gave a discount",
    "payment.voided": "Voided a payment",
    "queue.no-show": "Marked a no-show",
    "queue.cancelled": "Cancelled a customer",
    "queue.cleared": "Cleared the queue",
    "customer.created": "Created a customer account",
    "customer.password-reset": "Reset a customer password",
    "customer.activated": "Activated a customer",
    "customer.deactivated": "Deactivated a customer",
    "staff.created": "Added staff",
    "staff.updated": "Changed staff account",
    "staff.password-reset": "Reset a staff password",
    "barber.removed": "Removed a barber",
    "barber.restored": "Restored a barber",
    "review.deleted": "Deleted a review",
    "service.created": "Added a service",
    "service.updated": "Changed a service",
    "service.hidden": "Hid a service",
    "inventory.created": "Added a product",
    "inventory.updated": "Changed a product",
    "inventory.deleted": "Deleted a product"
  };

  function detailsText(details) {
    return Object.entries(details || {})
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
      .join(" · ");
  }

  async function activity(body, actions) {
    actions.innerHTML = `
      <select class="select-input" id="activityFilter" aria-label="Filter activity">
        <option value="">All activity</option>
        <option value="login">Sign-ins (incl. failed)</option>
        <option value="payment">Discounts and voids</option>
        <option value="queue">No-shows and cancellations</option>
        <option value="staff">Staff accounts</option>
        <option value="customer">Customer accounts</option>
        <option value="inventory">Inventory</option>
        <option value="service">Services and prices</option>
      </select>
      <button class="secondary-btn" type="button" id="refreshActivity">Refresh</button>`;

    body.innerHTML = `
      <article class="card">
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody id="activityRows"></tbody>
          </table>
        </div>
      </article>
      <p class="muted small spaced">Shows the latest 300 entries. Failed sign-ins are highlighted; 5 in a row lock the account for 15 minutes.</p>`;

    const filter = actions.querySelector("#activityFilter");

    async function load() {
      const entries = await api(`/api/audit?action=${encodeURIComponent(filter.value)}`);
      body.querySelector("#activityRows").innerHTML = entries.length ? entries.map(e => `
        <tr class="${/failed/.test(e.action) ? "alert-row" : ""}">
          <td>${App.dateTime(e.at)}</td>
          <td>${escapeHTML(e.actorName || "—")}${e.actorRole ? ` <span class="muted small">${escapeHTML(e.actorRole)}</span>` : ""}</td>
          <td>${escapeHTML(ACTION_LABELS[e.action] || e.action)}</td>
          <td class="muted small details-cell">${escapeHTML(detailsText(e.details))}${e.ip ? ` · IP ${escapeHTML(e.ip)}` : ""}</td>
        </tr>`).join("") : emptyRow(4, "No activity yet.");
    }

    const reload = () => load().catch(error => toast(error.message, "error"));
    filter.addEventListener("change", reload);
    actions.querySelector("#refreshActivity").addEventListener("click", event => busy(event.target, reload));
    await load();
  }

  const router = App.mountPages({
    analytics: { title: "Analytics", eyebrow: "SHOP PERFORMANCE", description: "Live numbers from the queue and payments.", render: analytics },
    desk: { title: "Front Desk", eyebrow: "TODAY'S QUEUE", description: "Add walk-ins, call customers to free barbers, and take payment.", render: (body, actions) => Desk.queue(body, actions, user) },
    payments: { title: "Payments & Reports", eyebrow: "FINANCE", description: "Sales for any date range, by payment method. Download as CSV for Excel.", render: (body, actions) => Desk.payments(body, actions, user) },
    customers: { title: "Customers", eyebrow: "CUSTOMER RECORDS", description: "Optional customer accounts and walk-in visits.", render: (body, actions) => Desk.customers(body, actions, user) },
    barbers: { title: "Barbers", eyebrow: "MEET THE TEAM", description: "Add, edit or remove barbers, set who is on duty, and moderate reviews.", render: barbers },
    services: { title: "Services", eyebrow: "SERVICES AND PRICES", description: "What customers can choose, with prices and durations.", render: services },
    inventory: { title: "Inventory", eyebrow: "STOCK", description: "Products for sale. Items at or below their warning level are flagged.", render: inventory },
    staff: { title: "Staff", eyebrow: "ACCOUNTS", description: "Cashier and admin accounts.", render: staff },
    activity: { title: "Activity Log", eyebrow: "SECURITY", description: "Who did what: sign-ins, failed sign-ins, discounts, voids, no-shows and account changes.", render: activity },
    account: { title: "My Account", eyebrow: "SECURITY", description: "Change your password and manage signed-in devices.", render: (body, actions) => Desk.account(body, actions, user) }
  }, "analytics");

  // Shortcuts such as "View all" on the analytics page.
  document.getElementById("pageContent").addEventListener("click", event => {
    const target = event.target.closest("[data-goto]");
    if (target) router.open(target.dataset.goto);
  });
})();
