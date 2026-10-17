// Customer dashboard: join the queue, follow your turn, meet the barbers, rate a visit, see past visits.
(async function () {
  const { api, escapeHTML, money, setMessage, statusPill } = App;
  const $ = id => document.getElementById(id);

  // A customer with an account, or a guest who entered their name on the login page.
  let account = null;
  try {
    const { user } = await api("/api/auth/me");
    if (user.role !== "customer") {
      window.location.replace(App.HOME_PAGES[user.role] || "/login.html");
      return;
    }
    account = user;
  } catch {
    // Not signed in: continue as a guest.
  }

  const name = account ? account.name : (sessionStorage.getItem("customerName") || "").trim();
  if (!name) {
    window.location.replace("/login.html");
    return;
  }

  const state = {
    ticket: null,
    services: [],
    barbers: [],
    rating: 0,
    rateTicket: null,
    alerted: false
  };

  $("welcomeTitle").textContent = `Welcome, ${name}!`;
  $("customerGreeting").textContent = account ? `Hi, ${name}` : `Hi, ${name} (guest)`;

  // ---------- Pages ----------

  const titles = {
    dashboard: "Customer Dashboard",
    queue: "My Queue",
    barbers: "Our Barbers",
    rating: "Rate a Barber",
    visits: "My Visits"
  };

  function openPage(page) {
    if (!titles[page]) return;

    document.querySelectorAll(".page-section").forEach(section => {
      section.hidden = section.id !== page + "Page";
    });
    document.querySelectorAll(".nav-link[data-page]").forEach(button => {
      button.classList.toggle("active", button.dataset.page === page);
    });
    $("pageTitle").textContent = titles[page];
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (page === "dashboard" || page === "queue") loadQueue();
    if (page === "barbers") loadBarbers();
    if (page === "rating") prepareRating();
    if (page === "visits") loadVisits();
  }

  document.querySelectorAll(".nav-link[data-page]").forEach(button => {
    button.addEventListener("click", () => openPage(button.dataset.page));
  });

  $("sidebarLogout").addEventListener("click", App.logout);

  // ---------- Joining ----------

  async function loadOptions() {
    try {
      [state.services, state.barbers] = await Promise.all([api("/api/services"), api("/api/barbers")]);

      $("service").innerHTML = '<option value="">-- Select a service --</option>' + state.services.map(s =>
        `<option value="${s.id}">${escapeHTML(s.name)} · ${money(s.price)} · about ${s.durationMinutes} min</option>`
      ).join("");

      $("preferredBarber").innerHTML = '<option value="">Any barber (fastest)</option>' + state.barbers.map(b =>
        `<option value="${b.id}">${escapeHTML(b.name)}${b.status === "unavailable" ? " (off duty today)" : ""}</option>`
      ).join("");
    } catch (error) {
      setMessage($("queueMessage"), error.message, "error");
    }
  }

  function waitText(ticket) {
    if (ticket.status === "serving") return "Now";
    if (ticket.status !== "waiting") return "—";
    return ticket.peopleAhead === 0 ? "You're next" : `About ${ticket.estimatedMinutes} min`;
  }

  const statusText = {
    waiting: "Waiting",
    serving: "It's your turn",
    completed: "Completed",
    "no-show": "Missed (no-show)",
    cancelled: "Left the queue"
  };

  function renderTicket() {
    const t = state.ticket;
    const active = t && ["waiting", "serving"].includes(t.status);

    const number = t ? `#${t.queueNumber}` : "—";
    const wait = t ? waitText(t) : "—";
    const status = t ? statusText[t.status] || t.status : "Not queued";

    $("queueNumber").textContent = number;
    $("queueNumber2").textContent = number;
    $("waitTime").textContent = wait;
    $("waitTime2").textContent = wait;
    $("queueStatus").textContent = status;
    $("queueStatus2").textContent = status;
    $("aheadText").textContent = t && t.status === "waiting"
      ? `${t.peopleAhead} customer(s) ahead of you.`
      : "Based on the customers ahead of you.";

    if (!t) {
      $("visitDetails").textContent = "You haven't joined today's queue yet.";
    } else {
      const parts = [`${t.service} (${money(t.price)})`];
      if (t.barberName) parts.push(`with ${t.barberName}`);
      else if (t.preferredBarberName) parts.push(`you asked for ${t.preferredBarberName}`);
      else parts.push("first available barber");
      $("visitDetails").innerHTML = `${escapeHTML(parts.join(", "))}. ${statusPill(t.status)}${t.status === "completed" && !t.rated ? ' <button class="text-btn" type="button" id="rateNowBtn">Rate your barber</button>' : ""}`;
    }

    $("leaveQueueBtn").classList.toggle("hidden", !(t && t.status === "waiting"));

    $("joinQueueBtn").disabled = Boolean(active);
    $("joinQueueBtn").textContent = active ? "You're in the queue" : "✂ Join Queue";
    $("service").disabled = Boolean(active);
    $("preferredBarber").disabled = Boolean(active);

    // Alert once when the customer is called.
    if (t && t.status === "serving" && !state.alerted) {
      state.alerted = true;
      $("turnBarber").textContent = t.barberName || "your barber";
      $("turnAlert").classList.remove("hidden");
      document.title = "Your turn! | Renz Barbershop";
      beep();
    }
    if (!t || t.status !== "serving") state.alerted = false;
  }

  function beep() {
    try {
      const context = new AudioContext();
      [0, 0.4].forEach(offset => {
        const tone = context.createOscillator();
        const volume = context.createGain();
        tone.frequency.value = 880;
        volume.gain.value = 0.15;
        tone.connect(volume).connect(context.destination);
        tone.start(context.currentTime + offset);
        tone.stop(context.currentTime + offset + 0.25);
      });
    } catch {
      // Sound is optional.
    }
  }

  $("dismissAlert").addEventListener("click", () => {
    $("turnAlert").classList.add("hidden");
    document.title = "Customer Dashboard | Renz Barbershop";
  });

  async function loadQueue() {
    try {
      const { ticket } = await api("/api/queue/mine");
      state.ticket = ticket;
    } catch (error) {
      if (error.status !== 404) return; // Keep showing the last status if the server is unreachable.
      state.ticket = null;
    }
    renderTicket();
  }

  $("joinQueueBtn").addEventListener("click", async () => {
    const serviceId = $("service").value;
    if (!serviceId) {
      setMessage($("queueMessage"), "Please select a service.", "error");
      $("service").focus();
      return;
    }

    $("joinQueueBtn").disabled = true;
    setMessage($("queueMessage"), "Joining...");

    try {
      const { ticket } = await api("/api/queue", {
        method: "POST",
        body: { name, serviceId, preferredBarberId: $("preferredBarber").value }
      });
      state.ticket = ticket;
      setMessage($("queueMessage"), `You're #${ticket.queueNumber} in the queue for ${ticket.service}.`, "success");
    } catch (error) {
      setMessage($("queueMessage"), error.message, "error");
      await loadQueue();
    }
    renderTicket();
  });

  $("leaveQueueBtn").addEventListener("click", async () => {
    if (!confirm("Leave the queue? You'll lose your place.")) return;

    try {
      const result = await api("/api/queue/mine/leave", { method: "POST" });
      setMessage($("leaveMessage"), result.message, "success");
    } catch (error) {
      setMessage($("leaveMessage"), error.message, "error");
    }
    await loadQueue();
  });

  $("refreshQueueBtn").addEventListener("click", loadQueue);
  document.addEventListener("click", event => {
    if (event.target.id === "rateNowBtn") openPage("rating");
  });

  // ---------- Barbers ----------

  async function loadBarbers() {
    setMessage($("barbersMessage"), "");

    try {
      state.barbers = await api("/api/barbers");
      $("barberList").innerHTML = state.barbers.length
        ? state.barbers.map(b => App.barberCard(b)).join("")
        : '<div class="empty-state"><h2>No barber profiles yet</h2><p>Please check back soon.</p></div>';
    } catch (error) {
      $("barberList").innerHTML = '<div class="empty-state"><h2>Unable to load barbers</h2><p>Please try again.</p></div>';
      setMessage($("barbersMessage"), error.message, "error");
    }
  }

  $("refreshBarbersBtn").addEventListener("click", loadBarbers);

  // ---------- Rating ----------

  function chooseRating(value) {
    state.rating = value;
    document.querySelectorAll("#starPicker button").forEach(button => {
      const selected = Number(button.dataset.rating) <= value;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("ratingHelp").textContent = value ? `${value} out of 5 stars selected.` : "Select 1 to 5 stars.";
  }

  document.querySelectorAll("#starPicker button").forEach(button => {
    button.addEventListener("click", () => chooseRating(Number(button.dataset.rating)));
  });

  // Rates today's completed visit, or a past visit chosen from My Visits.
  function prepareRating(visit) {
    const t = visit || state.ticket;
    const canRate = t && t.status === "completed" && !t.rated && t.barberId;

    state.rateTicket = canRate ? t : null;
    $("ratingForm").classList.toggle("hidden", !canRate);
    $("ratingUnavailable").classList.toggle("hidden", Boolean(canRate));
    $("ratingUnavailable").textContent = t && t.rated
      ? "Thank you! You've already rated this visit."
      : "Finish a visit first, then come back here to rate the barber who served you.";

    if (canRate) {
      $("ratingFor").innerHTML = `Rating <strong>${escapeHTML(t.barberName)}</strong> for your ${escapeHTML(t.service)}${t.queueDate ? ` on ${escapeHTML(t.queueDate)}` : " today"}.`;
      chooseRating(0);
      setMessage($("ratingMessage"), "");
    }
  }

  $("ratingForm").addEventListener("submit", async event => {
    event.preventDefault();
    const t = state.rateTicket;
    if (!t) return;

    if (!state.rating) {
      setMessage($("ratingMessage"), "Please select a star rating.", "error");
      return;
    }

    $("submitRatingBtn").disabled = true;

    try {
      const result = await api(`/api/barbers/${t.barberId}/ratings`, {
        method: "POST",
        body: { rating: state.rating, comment: $("ratingComment").value.trim(), ticketId: t.id }
      });
      t.rated = true;
      if (state.ticket && state.ticket.id === t.id) state.ticket.rated = true;
      $("ratingComment").value = "";
      $("ratingForm").classList.add("hidden");
      $("ratingUnavailable").classList.remove("hidden");
      $("ratingUnavailable").textContent = result.message;
    } catch (error) {
      setMessage($("ratingMessage"), error.message, "error");
    } finally {
      $("submitRatingBtn").disabled = false;
    }
  });

  // ---------- Visits ----------

  async function loadVisits() {
    const box = $("visitsContent");

    if (!account) {
      box.innerHTML = `
        <div class="card">
          <h2>Keep track of your visits</h2>
          <p class="muted">You're using the queue as a guest. Create a free account to see your past visits and rate them any time.</p>
          <a class="primary-btn" href="/login.html#register">Create an account</a>
        </div>`;
      return;
    }

    try {
      const visits = await api("/api/queue/history");
      box.innerHTML = visits.length ? `
        <div class="card">
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Date</th><th>Service</th><th>Barber</th><th>Status</th><th>Paid</th><th></th></tr></thead>
              <tbody>${visits.map(v => `
                <tr>
                  <td>${escapeHTML(v.queueDate)}</td>
                  <td>${escapeHTML(v.service)}</td>
                  <td>${escapeHTML(v.barberName || "—")}</td>
                  <td>${statusPill(v.status)}</td>
                  <td>${v.amountPaid != null ? money(v.amountPaid) : "—"}</td>
                  <td>${v.status === "completed" && v.barberId
                    ? v.rated ? '<span class="muted small">Rated</span>' : `<button class="secondary-btn small" type="button" data-rate-visit="${v.id}">Rate</button>`
                    : ""}</td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>` : '<div class="empty-state">No visits yet. Join the queue to get started.</div>';

      box.querySelectorAll("[data-rate-visit]").forEach(button => {
        button.addEventListener("click", () => {
          const visit = visits.find(v => v.id === button.dataset.rateVisit);
          openPage("rating");
          prepareRating(visit);
        });
      });
    } catch (error) {
      box.innerHTML = `<div class="empty-state">${escapeHTML(error.message)}</div>`;
    }
  }

  // ---------- Start ----------

  await Promise.all([loadOptions(), loadQueue()]);
  setInterval(loadQueue, 10000);
})();
