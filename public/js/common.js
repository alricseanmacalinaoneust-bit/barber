// Shared helpers for every page, available as window.App.
(function () {
  const HOME_PAGES = { admin: "/admin.html", cashier: "/cashier.html", customer: "/dashboard.html" };

  const STATUS_LABELS = {
    waiting: "Waiting",
    serving: "Being served",
    completed: "Completed",
    "no-show": "No-show",
    cancelled: "Cancelled"
  };

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function money(amount) {
    return "₱" + Number(amount || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function time(value) {
    return value ? new Date(value).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : "—";
  }

  function dateTime(value) {
    return value
      ? new Date(value).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "—";
  }

  function minutesSince(value) {
    return Math.max(0, Math.round((Date.now() - new Date(value)) / 60000));
  }

  function today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  // fetch() wrapper: sends/receives JSON and throws an Error with the server's message.
  async function api(url, { method = "GET", body } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }

    return data;
  }

  function setMessage(element, text, type = "") {
    if (!element) return;
    element.textContent = text;
    element.className = "message" + (type ? " " + type : "");
  }

  function statusPill(status) {
    return `<span class="status-pill ${escapeHTML(status)}">${escapeHTML(STATUS_LABELS[status] || status)}</span>`;
  }

  // Photos may only come from this site or https addresses.
  function safePhoto(value) {
    if (!value) return "";

    try {
      const url = new URL(value, window.location.origin);
      if (url.origin === window.location.origin || url.protocol === "https:") return url.href;
    } catch {
      // Not a valid address.
    }

    return "";
  }

  function barberCard(barber, actionsHTML = "") {
    const name = escapeHTML(barber.name);
    const initial = escapeHTML((barber.name || "B").charAt(0).toUpperCase());
    const photo = safePhoto(barber.photoUrl);
    const rating = Math.min(5, Math.max(0, Number(barber.averageRating) || 0));
    const stars = "★".repeat(Math.round(rating)) + "☆".repeat(5 - Math.round(rating));
    const years = Number(barber.experienceYears) || 0;
    const removed = barber.active === false;
    const statusClass = removed ? "unavailable" : barber.status;
    const statusText = removed ? "Removed" : { available: "Available", busy: "Busy", unavailable: "Unavailable" }[barber.status] || "Unavailable";

    return `
      <article class="barber-card${removed ? " removed" : ""}">
        <div class="barber-photo">
          ${photo
            ? `<img src="${escapeHTML(photo)}" alt="${name}" loading="lazy" data-initial="${initial}">`
            : `<div class="barber-avatar">${initial}</div>`}
        </div>
        <div class="barber-info">
          <h2>${name}</h2>
          <p class="barber-specialty">${escapeHTML(barber.specialty || "General Barber")}</p>
          <p class="barber-bio">${escapeHTML(barber.bio || "Welcome to our barbershop!")}</p>
          <p class="barber-experience">${years ? `${years} year${years === 1 ? "" : "s"} of experience` : "Experience not specified"}</p>
          <span class="barber-status ${escapeHTML(statusClass)}">${statusText}</span>
          <div class="barber-rating">
            <div class="stars">${stars}</div>
            <div class="rating-text">${rating.toFixed(1)} / 5 · ${barber.reviewCount || 0} review(s)</div>
          </div>
          ${actionsHTML ? `<div class="barber-actions">${actionsHTML}</div>` : ""}
        </div>
      </article>`;
  }

  // Broken photos fall back to the barber's initial. (Inline onerror handlers are blocked by the security policy.)
  document.addEventListener("error", event => {
    const img = event.target;
    if (img.tagName !== "IMG" || !img.closest(".barber-photo")) return;

    const avatar = document.createElement("div");
    avatar.className = "barber-avatar";
    avatar.textContent = img.dataset.initial || "B";
    img.replaceWith(avatar);
  }, true);

  // A pop-up dialog. Elements with data-close (or clicking outside, or Escape) close it.
  function openDialog(innerHTML) {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `<div class="card dialog" role="dialog" aria-modal="true">${innerHTML}</div>`;
    document.body.appendChild(backdrop);

    function onKey(event) {
      if (event.key === "Escape") close();
    }

    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    }

    backdrop.addEventListener("click", event => {
      if (event.target === backdrop || event.target.closest("[data-close]")) close();
    });
    document.addEventListener("keydown", onKey);
    backdrop.querySelector("input, select, textarea")?.focus();

    return { element: backdrop.querySelector(".dialog"), close };
  }

  // Shows a one-time password that staff must hand to the account owner.
  function showTemporaryPassword(title, who, password) {
    openDialog(`
      <h2>${escapeHTML(title)}</h2>
      <p class="muted">Give this one-time password to ${escapeHTML(who)}. It is shown only once; they should change it after signing in.</p>
      <p class="temp-password">${escapeHTML(password)}</p>
      <div class="form-actions"><button class="primary-btn" type="button" data-close>Done</button></div>
    `);
  }

  function downloadCSV(filename, rows) {
    const csv = rows.map(row => row.map(cell => {
      const text = String(cell ?? "");
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(",")).join("\r\n");

    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // Logging out locally still works if the server is unreachable.
    }

    sessionStorage.removeItem("customerName");
    window.location.href = "/login.html";
  }

  // For staff pages: returns the signed-in user, or redirects anyone who shouldn't be here.
  async function requireStaff(roles) {
    try {
      const { user } = await api("/api/auth/me");

      if (!roles.includes(user.role)) {
        window.location.replace(HOME_PAGES[user.role] || "/login.html");
        return null;
      }

      document.getElementById("userGreeting").textContent = `Hi, ${user.name}`;
      document.getElementById("passwordBanner")?.classList.toggle("hidden", !user.mustChangePassword);
      return user;
    } catch (error) {
      if (error.status === 401) window.location.replace("/login.html");
      else document.getElementById("pageContent").innerHTML = `<div class="empty-state">${escapeHTML(error.message)}</div>`;
      return null;
    }
  }

  // Sidebar navigation for the admin and cashier pages.
  // pages: { key: { title, eyebrow, description, render(body, actions) } }; render may return a cleanup function.
  function mountPages(pages, initial) {
    const sidebar = document.getElementById("sidebar");
    const content = document.getElementById("pageContent");
    const title = document.getElementById("pageTitle");
    let cleanup = null;

    async function open(requested) {
      const key = pages[requested] ? requested : initial;
      const page = pages[key];

      if (typeof cleanup === "function") cleanup();
      cleanup = null;

      sidebar.querySelectorAll("[data-page]").forEach(button => {
        button.classList.toggle("active", button.dataset.page === key);
      });

      title.textContent = page.title;
      history.replaceState(null, "", "#" + key);
      window.scrollTo(0, 0);

      content.innerHTML = `
        <div class="section-heading">
          <div>
            <div class="eyebrow">${escapeHTML(page.eyebrow)}</div>
            <h1>${escapeHTML(page.title)}</h1>
            <p class="muted">${escapeHTML(page.description)}</p>
          </div>
          <div class="heading-actions"></div>
        </div>
        <div class="page-body"></div>`;

      try {
        cleanup = await page.render(content.querySelector(".page-body"), content.querySelector(".heading-actions"));
      } catch (error) {
        content.querySelector(".page-body").innerHTML = `<div class="empty-state">${escapeHTML(error.message)}</div>`;
      }
    }

    sidebar.addEventListener("click", event => {
      const button = event.target.closest("[data-page]");
      if (button) open(button.dataset.page);
    });

    document.getElementById("logoutBtn")?.addEventListener("click", logout);
    document.getElementById("passwordBanner")?.addEventListener("click", event => {
      if (event.target.closest("[data-open-account]")) open("account");
    });

    open(window.location.hash.slice(1) || initial);
    return { open };
  }

  window.App = {
    HOME_PAGES,
    escapeHTML,
    money,
    time,
    dateTime,
    minutesSince,
    today,
    api,
    setMessage,
    statusPill,
    safePhoto,
    barberCard,
    openDialog,
    showTemporaryPassword,
    downloadCSV,
    logout,
    requireStaff,
    mountPages
  };
})();
