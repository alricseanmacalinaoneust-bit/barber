document.addEventListener("DOMContentLoaded", () => {
  const name = (sessionStorage.getItem("customerName") || "").trim();

  if (!name) {
    window.location.replace("/login.html");
    return;
  }

  const $ = id => document.getElementById(id);

  const state = {
    ticket: null,
    barbers: [],
    selectedRating: 0,
    joining: false,
    loadingQueue: false
  };

  $("welcomeTitle").textContent = `Welcome, ${name}!`;
  $("customerGreeting").textContent = `Hi, ${name}`;

  function setMessage(id, text, type = "") {
    const element = $(id);
    if (!element) return;
    element.textContent = text;
    element.className = "message" + (type ? " " + type : "");
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function safePhoto(value) {
    if (!value) return "";

    try {
      const url = new URL(value, window.location.origin);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      if (url.protocol === "http:" && url.origin !== window.location.origin) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function getTicketFromResponse(data) {
    if (!data) return null;

    if (data.ticket && typeof data.ticket === "object") return data.ticket;
    if (data.queue && typeof data.queue === "object") return data.queue;

    if (Array.isArray(data.tickets)) {
      return data.tickets.find(ticket => isActiveTicket(ticket)) || data.tickets[0] || null;
    }

    if (Array.isArray(data.queue)) {
      return data.queue.find(ticket => isActiveTicket(ticket)) || data.queue[0] || null;
    }

    return data;
  }

  function isActiveTicket(ticket) {
    if (!ticket) return false;

    const status = String(ticket.status || "waiting").toLowerCase();

    return ![
      "completed", "served", "done", "cancelled",
      "canceled", "finished", "rejected"
    ].includes(status);
  }

  function hasQueueNumber(ticket) {
    return !!ticket && (
      ticket.queueNumber != null ||
      ticket.number != null ||
      ticket.queueNo != null
    );
  }

  function updateJoinControls(hasTicket) {
    const button = $("joinQueueBtn");
    const service = $("service");

    if (state.joining) {
      button.disabled = true;
      button.textContent = "Joining...";
      service.disabled = true;
      return;
    }

    button.disabled = hasTicket;
    button.textContent = hasTicket ? "Already in Queue" : "✂ Join Queue";
    service.disabled = hasTicket;
  }

  function displayQueue(ticket) {
    if (!ticket || !hasQueueNumber(ticket)) return;

    state.ticket = ticket;

    const number = ticket.queueNumber ?? ticket.number ?? ticket.queueNo;
    const wait = ticket.estimatedMinutes
      ?? ticket.estimatedWaitMinutes
      ?? ticket.waitingTime
      ?? ticket.estimatedWait;

    const status = ticket.status || "Waiting";
    const waitText = wait == null
      ? "Not available"
      : typeof wait === "number"
        ? `${wait} min`
        : String(wait);

    $("queueNumber").textContent = number;
    $("waitTime").textContent = waitText;
    $("queueStatus").textContent = status;

    $("queueNumber2").textContent = number;
    $("waitTime2").textContent = waitText;
    $("queueStatus2").textContent = status;

    const serviceText = ticket.service ? ` Service: ${ticket.service}.` : "";
    const info = `Queue number: ${number}. Status: ${status}.${serviceText}`;

    $("visitInfo").textContent = info;
    $("queueVisitInfo").textContent = info;

    if (ticket.service) $("service").value = ticket.service;

    updateJoinControls(true);
  }

  function clearQueue() {
    state.ticket = null;

    $("queueNumber").textContent = "—";
    $("waitTime").textContent = "—";
    $("queueStatus").textContent = "Not queued";

    $("queueNumber2").textContent = "—";
    $("waitTime2").textContent = "—";
    $("queueStatus2").textContent = "Not queued";

    $("visitInfo").textContent = "You haven't joined today's queue yet.";
    $("queueVisitInfo").textContent = "You haven't joined today's queue yet.";

    updateJoinControls(false);
  }

  async function loadQueue() {
    // Avoid overlapping queue lookups.
    if (state.loadingQueue) return;

    state.loadingQueue = true;

    try {
      const response = await fetch("/api/queue/mine", {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });

      // Do not clear the current ticket just because the server
      // reports an error or the customer is temporarily unauthorized.
      if (!response.ok) {
        if (response.status === 404 && !state.ticket) {
          clearQueue();
        } else {
          console.warn("Queue lookup returned HTTP", response.status);
        }
        return;
      }

      const data = await response.json();
      const ticket = getTicketFromResponse(data);

      if (hasQueueNumber(ticket)) {
        displayQueue(ticket);
      } else if (!state.ticket) {
        clearQueue();
      } else {
        // Preserve the displayed ticket if the API response is empty.
        updateJoinControls(true);
      }
    } catch (error) {
      console.error("Unable to load queue:", error);
      // Keep the existing ticket on screen if the network fails.
    } finally {
      state.loadingQueue = false;
    }
  }

  function openPage(page) {
    const pageNames = {
      dashboard: "Customer Dashboard",
      queue: "My Queue",
      barbers: "Our Barbers",
      visit: "My Visit",
      rating: "Rate a Barber"
    };

    const target = $(page + "Page");
    if (!pageNames[page] || !target) return;

    document.querySelectorAll(".page-section").forEach(section => {
      section.hidden = true;
    });

    target.hidden = false;

    document.querySelectorAll(".nav-link[data-page]").forEach(button => {
      button.classList.toggle("active", button.dataset.page === page);
    });

    $("pageTitle").textContent = pageNames[page];

    // Reload server data without resetting the ticket.
    if (page === "dashboard" || page === "queue" || page === "visit") {
      loadQueue();
    }

    if (page === "barbers") loadBarbers();

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  document.querySelectorAll(".nav-link[data-page]").forEach(button => {
    button.addEventListener("click", () => openPage(button.dataset.page));
  });

  // Join the queue.
  $("joinQueueBtn").addEventListener("click", async () => {
    if (state.ticket || state.joining) return;

    const service = $("service").value.trim();

    if (!service) {
      setMessage("queueMessage", "Please select a service.", "error");
      $("service").focus();
      return;
    }

    state.joining = true;
    updateJoinControls(false);
    setMessage("queueMessage", "");

    try {
      const response = await fetch("/api/queue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        credentials: "same-origin",
        body: JSON.stringify({
          name,
          customerName: name,
          service
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // If the server reports an existing ticket, attempt to load it.
        await loadQueue();
        throw new Error(
          data.error || data.message || "Unable to join the queue."
        );
      }

      const ticket = getTicketFromResponse(data);

      if (!hasQueueNumber(ticket)) {
        // The server may have created the ticket even if its response
        // shape differs. Look it up before allowing another submission.
        await loadQueue();

        if (!state.ticket) {
          throw new Error(
            "The API did not return a queue number. Check the response from routes/queue.js."
          );
        }
      } else {
        ticket.service = ticket.service || service;
        ticket.status = ticket.status || "waiting";
        ticket.estimatedMinutes = ticket.estimatedMinutes
          ?? data.estimatedMinutes;

        displayQueue(ticket);
      }

      setMessage(
        "queueMessage",
        `Successfully joined the queue! Service: ${service}.`,
        "success"
      );
    } catch (error) {
      console.error("Unable to join queue:", error);
      setMessage("queueMessage", error.message, "error");
    } finally {
      state.joining = false;
      updateJoinControls(!!state.ticket);
    }
  });

  async function loadBarbers() {
    $("barberList").innerHTML =
      '<div class="empty-state">Loading barber profiles...</div>';

    setMessage("barbersMessage", "");

    try {
      const response = await fetch("/api/barbers", {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });

      if (!response.ok) {
        throw new Error(`Could not load barbers (HTTP ${response.status}).`);
      }

      const data = await response.json();
      const barbers = Array.isArray(data) ? data : data.barbers;

      if (!Array.isArray(barbers)) {
        throw new Error("Unexpected response from /api/barbers.");
      }

      state.barbers = barbers;
      updateBarberSelect(barbers);

      if (!barbers.length) {
        $("barberList").innerHTML = `
          <div class="empty-state">
            <h2>No barber profiles yet</h2>
            <p>The barbershop owner needs to add barber profiles through the admin system.</p>
          </div>`;
        return;
      }

      $("barberList").innerHTML = barbers.map(barber => {
        const id = barber._id || barber.id || "";
        const barberName = barber.name || "Barber";
        const photo = safePhoto(
          barber.photoUrl || barber.profilePicture || barber.photo
        );

        const rating = Number(barber.averageRating ?? barber.rating ?? 0);
        const safeRating = Number.isFinite(rating)
          ? Math.min(5, Math.max(0, rating))
          : 0;

        const reviews = Math.max(0, Number(barber.reviewCount || 0));

        const availability =
          barber.available === true || barber.status === "available";

        const unavailable =
          barber.available === false || barber.status === "unavailable";

        const statusClass = unavailable
          ? "unavailable"
          : availability
            ? "available"
            : "busy";

        const statusText = unavailable
          ? "Unavailable"
          : availability
            ? "Available"
            : "Currently busy";

        const stars =
          "★".repeat(Math.round(safeRating)) +
          "☆".repeat(5 - Math.round(safeRating));

        const initial = escapeHTML(barberName.charAt(0).toUpperCase());

        return `
          <article class="barber-card">
            <div class="barber-photo">
              ${photo
                ? `<img src="${escapeHTML(photo)}" alt="${escapeHTML(barberName)}" loading="lazy" onerror="this.remove();">`
                : `<div class="barber-avatar">${initial}</div>`
              }
            </div>
            <div class="barber-info">
              <h2>${escapeHTML(barberName)}</h2>
              <p class="barber-specialty">${escapeHTML(barber.specialty || barber.expertise || "General Barber")}</p>
              <p class="barber-bio">${escapeHTML(barber.bio || barber.description || "Welcome to our barbershop!")}</p>
              <p><strong>Experience:</strong> ${escapeHTML(barber.experience || "Not specified")}</p>
              <p><strong>Services:</strong> ${escapeHTML(
                Array.isArray(barber.services)
                  ? barber.services.join(", ")
                  : barber.services || "Haircut and grooming"
              )}</p>
              <span class="barber-status ${statusClass}">${statusText}</span>
              <div class="barber-rating">
                <div class="stars">${stars}</div>
                <div class="rating-text">${safeRating.toFixed(1)} / 5 · ${reviews} review(s)</div>
              </div>
              <div class="barber-actions">
                <button class="primary-btn rate-this-barber" type="button" data-barber-id="${escapeHTML(id)}">★ Rate Barber</button>
              </div>
            </div>
          </article>`;
      }).join("");

      document.querySelectorAll(".rate-this-barber").forEach(button => {
        button.addEventListener("click", () => {
          $("ratingBarber").value = button.dataset.barberId;
          openPage("rating");
        });
      });
    } catch (error) {
      console.error("Unable to load barber profiles:", error);

      $("barberList").innerHTML = `
        <div class="empty-state">
          <h2>Unable to load barbers</h2>
          <p>Check that your server is running and the /api/barbers endpoint is working.</p>
        </div>`;

      setMessage("barbersMessage", error.message, "error");
    }
  }

  function updateBarberSelect(barbers) {
    const select = $("ratingBarber");
    const previousValue = select.value;

    select.innerHTML = '<option value="">Select a barber</option>';

    barbers.forEach(barber => {
      const option = document.createElement("option");
      option.value = barber._id || barber.id || "";
      option.textContent = barber.name || "Barber";
      select.appendChild(option);
    });

    if (previousValue) select.value = previousValue;
  }

  function chooseRating(value) {
    state.selectedRating = value;

    document.querySelectorAll("#starPicker button").forEach(button => {
      const selected = Number(button.dataset.rating) <= value;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });

    $("ratingHelp").textContent = value
      ? `${value} out of 5 stars selected.`
      : "Select 1 to 5 stars.";
  }

  document.querySelectorAll("#starPicker button").forEach(button => {
    button.addEventListener("click", () => {
      chooseRating(Number(button.dataset.rating));
    });
  });

  $("ratingForm").addEventListener("submit", async event => {
    event.preventDefault();

    const barberId = $("ratingBarber").value;
    const comment = $("ratingComment").value.trim();

    if (!barberId) {
      setMessage("ratingMessage", "Please choose a barber.", "error");
      return;
    }

    if (!state.selectedRating) {
      setMessage("ratingMessage", "Please select a star rating.", "error");
      return;
    }

    if (!state.ticket) {
      setMessage("ratingMessage", "Please join the queue and complete your visit before rating a barber.", "error");
      return;
    }

    const status = String(state.ticket.status || "").toLowerCase();

    if (!["completed", "served", "done"].includes(status)) {
      setMessage("ratingMessage", "You can submit a rating after your visit is marked completed by the barbershop.", "error");
      return;
    }

    const submit = $("submitRatingBtn");
    submit.disabled = true;
    submit.textContent = "Submitting...";

    try {
      const response = await fetch(
        `/api/barbers/${encodeURIComponent(barberId)}/ratings`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          credentials: "same-origin",
          body: JSON.stringify({
            rating: state.selectedRating,
            comment,
            customerName: name,
            queueTicketId: state.ticket._id || state.ticket.id
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || data.message || "Rating was not saved. Check the backend rating endpoint.");
      }

      setMessage("ratingMessage", "Thank you! Your rating was submitted.", "success");
      $("ratingComment").value = "";
      chooseRating(0);
      await loadBarbers();
    } catch (error) {
      console.error("Rating submission failed:", error);
      setMessage("ratingMessage", error.message, "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "Submit Rating";
    }
  });

  $("refreshBarbersBtn").addEventListener("click", loadBarbers);
  $("refreshQueueBtn").addEventListener("click", loadQueue);
  $("refreshVisitBtn").addEventListener("click", loadQueue);

  $("sidebarLogout").addEventListener("click", () => {
    sessionStorage.removeItem("customerName");
    window.location.replace("/login.html");
  });

  // Restore the customer's existing ticket when the dashboard opens.
  loadQueue();
});
