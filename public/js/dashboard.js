// Customer dashboard: join the queue, follow your turn, meet the barbers, rate a visit, see past visits.
(async function () {
  const { api, escapeHTML, money, setMessage, statusPill, toast, busy, confirmDialog } = App;
  const $ = id => document.getElementById(id);

  const state = {
    ticket: null,
    services: [],
    barbers: [],
    rating: 0,
    rateTicket: null,
    alerted: false,
    notify: false
  };

  // Who is this? A customer with an account, a guest who typed their name, or a guest coming back
  // to a ticket they already have on this device.
  let account = null;
  try {
    const { user } = await api("/api/auth/me");
    if (user.role !== "customer") {
      window.location.replace(App.HOME_PAGES[user.role] || "/login.html");
      return;
    }
    account = user;
    App.state.signedIn = true;
  } catch {
    // Not signed in: continue as a guest.
  }

  let name = account ? account.name : (sessionStorage.getItem("customerName") || "").trim();

  if (!account) {
    try {
      const { ticket } = await api("/api/queue/mine");
      state.ticket = ticket;
      if (!name) {
        name = ticket.customerName;
        sessionStorage.setItem("customerName", name);
      }
    } catch {
      // No ticket on this device yet.
    }
  }

  if (!name) {
    window.location.replace("/login.html");
    return;
  }

  $("welcomeTitle").textContent = `Welcome, ${name}!`;
  $("customerGreeting").textContent = account ? `Hi, ${name}` : `Hi, ${name} (walk-in)`;
  $("accountNav").classList.toggle("hidden", !account);
  $("passwordBanner").classList.toggle("hidden", !account?.mustChangePassword);

  // ---------- Pages ----------

  const titles = {
    dashboard: "Customer Dashboard",
    queue: "My Queue",
    barbers: "Our Barbers",
    rating: "Rate a Barber",
    visits: "My Visits",
    account: "My Account"
  };

  function openPage(page) {
    if (!titles[page]) return;

    document.querySelectorAll(".page-section").forEach(section => {
      section.hidden = section.id !== page + "Page";
    });
    document.querySelectorAll(".nav-link[data-page]").forEach(button => {
      const active = button.dataset.page === page;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $("pageTitle").textContent = titles[page];
    if (!state.alerted) document.title = `${titles[page]} | Renz Barbershop`;
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (page === "dashboard" || page === "queue") loadQueue();
    if (page === "barbers") loadBarbers();
    if (page === "rating") prepareRating();
    if (page === "visits") loadVisits();
    if (page === "account" && account) Desk.account($("accountContent"), null, account);
  }

  document.querySelectorAll(".nav-link[data-page]").forEach(button => {
    button.addEventListener("click", () => openPage(button.dataset.page));
  });

  $("changePasswordLink").addEventListener("click", () => openPage("account"));

  $("sidebarLogout").addEventListener("click", async () => {
    const t = state.ticket;
    if (!account && t && ["waiting", "serving"].includes(t.status)) {
      const ok = await confirmDialog(
        `You're still in the queue as #${t.queueNumber}. If you log out, this device won't show your ticket any more; you keep your place, so remember your number.`,
        { title: "Log out?", confirmText: "Log out anyway" }
      );
      if (!ok) return;
    }
    App.logout();
  });

  // ---------- Joining ----------

  async function loadOptions() {
    try {
      [state.services, state.barbers] = await Promise.all([api("/api/services"), api("/api/barbers")]);
      const chosenService = $("service").value;
      const chosenBarber = $("preferredBarber").value;

      $("service").innerHTML = '<option value="">-- Select a service --</option>' + state.services.map(s =>
        `<option value="${s.id}">${escapeHTML(s.name)} · ${money(s.price)} · about ${s.durationMinutes} min</option>`
      ).join("");

      $("preferredBarber").innerHTML = '<option value="">Any barber (fastest)</option>' + state.barbers.map(b =>
        `<option value="${b.id}">${escapeHTML(b.name)}${b.status === "unavailable" ? " (off duty today)" : b.status === "busy" ? " (busy now)" : ""}</option>`
      ).join("");

      $("service").value = chosenService;
      $("preferredBarber").value = chosenBarber;
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
    cancelled: "Left the queue",
    expired: "Expired"
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

    $("numberHelp").textContent = !t
      ? "You'll get a number when you join."
      : active ? "Listen for your number, or watch this page." : "Your last visit today.";
    $("aheadText").textContent = t?.status === "waiting"
      ? (t.peopleAhead ? `${t.peopleAhead} customer(s) ahead of you.` : "No one is ahead of you.")
      : t?.status === "serving" ? `Go to ${t.barberName || "your barber"}.` : "Based on the customers ahead of you.";
    $("statusHelp").textContent = active ? "This page updates by itself." : t?.status === "completed" ? (t.rated ? "Thanks for your rating!" : "You can rate your barber now.") : "Join the queue below.";

    // Today's visit details on the My Queue page.
    if (!t) {
      $("visitDetails").textContent = "You haven't joined today's queue yet.";
    } else {
      const parts = [`${t.service} (${money(t.price)})`];
      if (t.barberName) parts.push(`with ${t.barberName}`);
      else if (t.preferredBarberName) parts.push(`you asked for ${t.preferredBarberName}`);
      else parts.push("first available barber");
      $("visitDetails").innerHTML = `${escapeHTML(parts.join(", "))}. ${statusPill(t.status)}${t.status === "completed" && !t.rated && t.barberId ? ' <button class="text-btn" type="button" data-open="rating">Rate your barber</button>' : ""}`;
    }

    $("leaveQueueBtn").classList.toggle("hidden", !(t && t.status === "waiting"));
    $("leaveQueueBtn2").classList.toggle("hidden", !(t && t.status === "waiting"));

    // Dashboard: either the join form or the "you're in the queue" panel.
    $("joinPanel").classList.toggle("hidden", Boolean(active));
    $("inQueuePanel").classList.toggle("hidden", !active);
    if (active) {
      $("inQueueEyebrow").textContent = t.status === "serving" ? "IT'S YOUR TURN" : "YOU'RE IN THE QUEUE";
      $("inQueueTitle").textContent = t.status === "serving" ? `Please go to ${t.barberName || "your barber"}` : `You're #${t.queueNumber}`;
      $("inQueueText").textContent = t.status === "serving"
        ? `${t.service}. Pay at the counter when you're done.`
        : `${t.service} · ${t.preferredBarberName ? `with ${t.preferredBarberName}` : "first available barber"} · ${waitText(t).toLowerCase()}${t.peopleAhead ? ` (${t.peopleAhead} ahead)` : ""}`;
    }

    $("notifyBtn").classList.toggle("hidden", !(t?.status === "waiting" && "Notification" in window && Notification.permission !== "denied" && !state.notify));

    // Alert once when the customer is called.
    if (t && t.status === "serving" && !state.alerted) {
      state.alerted = true;
      $("turnBarber").textContent = t.barberName || "your barber";
      $("turnAlert").classList.remove("hidden");
      document.title = "Your turn! | Renz Barbershop";
      beep();
      // Phones only allow vibrating after the person has tapped the page.
      if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([300, 150, 300]);
      if (state.notify && Notification.permission === "granted") {
        try {
          new Notification("It's your turn!", { body: `Please go to ${t.barberName || "your barber"} at Renz Barbershop.`, icon: "/favicon.svg" });
        } catch {
          // Some browsers only allow notifications from a service worker.
        }
      }
    }
    if (!t || t.status !== "serving") {
      state.alerted = false;
      $("turnAlert").classList.add("hidden");
    }
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

  $("joinPanel").addEventListener("submit", async event => {
    event.preventDefault();
    const serviceId = $("service").value;
    if (!serviceId) {
      setMessage($("queueMessage"), "Please select a service.", "error");
      $("service").focus();
      return;
    }

    await busy($("joinQueueBtn"), async () => {
      setMessage($("queueMessage"), "");
      try {
        const { ticket } = await api("/api/queue", {
          method: "POST",
          body: { name, serviceId, preferredBarberId: $("preferredBarber").value }
        });
        state.ticket = ticket;
        toast(`You're #${ticket.queueNumber} in the queue for ${ticket.service}.`);
      } catch (error) {
        setMessage($("queueMessage"), error.message, "error");
        await loadQueue();
      }
      renderTicket();
    });
  });

  async function leaveQueue(button) {
    const ok = await confirmDialog("Leave the queue? You'll lose your place.", { title: "Leave the queue", confirmText: "Leave the queue", danger: true });
    if (!ok) return;

    await busy(button, async () => {
      try {
        const result = await api("/api/queue/mine/leave", { method: "POST" });
        toast(result.message);
      } catch (error) {
        toast(error.message, "error");
      }
      await loadQueue();
    });
  }

  $("leaveQueueBtn").addEventListener("click", event => leaveQueue(event.target));
  $("leaveQueueBtn2").addEventListener("click", event => leaveQueue(event.target));
  $("viewQueueBtn").addEventListener("click", () => openPage("queue"));
  $("refreshQueueBtn").addEventListener("click", event => busy(event.target, loadQueue));

  $("notifyBtn").addEventListener("click", async () => {
    const permission = await Notification.requestPermission();
    state.notify = permission === "granted";
    toast(state.notify ? "We'll notify you when it's your turn. Keep this page open." : "Notifications are blocked. Keep this page open and we'll beep instead.", state.notify ? "success" : "info");
    renderTicket();
  });

  document.addEventListener("click", event => {
    const target = event.target.closest("[data-open]");
    if (target) openPage(target.dataset.open);
  });

  // ---------- Barbers ----------

  async function loadBarbers() {
    setMessage($("barbersMessage"), "");
    const canChoose = !state.ticket || !["waiting", "serving"].includes(state.ticket.status);

    try {
      state.barbers = await api("/api/barbers");
      $("barberList").innerHTML = state.barbers.length
        ? state.barbers.map(b => App.barberCard(b, canChoose && b.status !== "unavailable"
          ? `<button class="primary-btn" type="button" data-choose="${b.id}">Choose ${escapeHTML(b.name)}</button>`
          : "")).join("")
        : '<div class="empty-state"><h2>No barber profiles yet</h2><p>Please check back soon.</p></div>';
    } catch (error) {
      $("barberList").innerHTML = '<div class="empty-state"><h2>Unable to load barbers</h2><p>Please try again.</p></div>';
      setMessage($("barbersMessage"), error.message, "error");
    }
  }

  // "Choose this barber" fills in the join form.
  $("barberList").addEventListener("click", event => {
    const id = event.target.closest("[data-choose]")?.dataset.choose;
    if (!id) return;
    openPage("dashboard");
    $("preferredBarber").value = id;
    $("service").focus();
    toast("Barber selected. Now choose your service and join the queue.", "info");
  });

  $("refreshBarbersBtn").addEventListener("click", event => busy(event.target, loadBarbers));

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

    if (t && t.rated) {
      $("ratingUnavailable").innerHTML = "Thank you! You've already rated this visit.";
    } else if (t && ["waiting", "serving"].includes(t.status)) {
      $("ratingUnavailable").innerHTML = "You can rate your barber after your haircut is finished and paid.";
    } else {
      $("ratingUnavailable").innerHTML = account
        ? 'No visit to rate right now. You can also rate past visits from <button class="text-btn" type="button" data-open="visits">My Visits</button>.'
        : "Finish a visit first, then come back here to rate the barber who served you.";
    }

    if (canRate) {
      $("ratingFor").innerHTML = `Rating <strong>${escapeHTML(t.barberName)}</strong> for your ${escapeHTML(t.service)}${t.queueDate ? ` on ${escapeHTML(t.queueDate)}` : " today"}.`;
      chooseRating(0);
      $("ratingComment").value = "";
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

    await busy($("submitRatingBtn"), async () => {
      try {
        const result = await api(`/api/barbers/${t.barberId}/ratings`, {
          method: "POST",
          body: { rating: state.rating, comment: $("ratingComment").value.trim(), ticketId: t.id }
        });
        t.rated = true;
        if (state.ticket && state.ticket.id === t.id) state.ticket.rated = true;
        $("ratingForm").classList.add("hidden");
        $("ratingUnavailable").classList.remove("hidden");
        $("ratingUnavailable").textContent = result.message;
        toast(result.message);
        renderTicket();
      } catch (error) {
        setMessage($("ratingMessage"), error.message, "error");
      }
    });
  });

  // ---------- Visits ----------

  async function loadVisits() {
    const box = $("visitsContent");

    if (!account) {
      box.innerHTML = `
        <div class="card narrow">
          <h2>Want to keep track of your visits?</h2>
          <p class="muted">You don't need an account to get a haircut. If you'd like to see your past visits and rate them any time, you can create a free account.${state.ticket ? " Today's visit will be added to it." : ""}</p>
          <a class="primary-btn" href="/login.html#register">Create an account (optional)</a>
        </div>`;
      return;
    }

    box.innerHTML = '<div class="loading">Loading…</div>';

    try {
      const visits = await api("/api/queue/history");
      box.innerHTML = visits.length ? `
        <div class="card">
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Date</th><th>Service</th><th>Barber</th><th>Status</th><th>Paid</th><th><span class="sr-only">Rating</span></th></tr></thead>
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

  renderTicket();
  await Promise.all([loadOptions(), loadQueue()]);
  setInterval(loadQueue, 10000);
})();
