// Shared helpers for every page, available as window.App.
(function () {
  const HOME_PAGES = { admin: "/admin.html", cashier: "/cashier.html", customer: "/dashboard.html" };

  // Shared page state: whether someone is signed in, and whether staff still have a one-time password.
  const state = { signedIn: false, mustChangePassword: false };

  const STATUS_LABELS = {
    waiting: "Waiting",
    serving: "Being served",
    completed: "Completed",
    "no-show": "No-show",
    expired: "Expired",
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

  // "just now", "12 min", "1 h 5 min"
  function waitedText(value) {
    const minutes = minutesSince(value);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function today() {
    return dateKey(new Date());
  }

  // fetch() wrapper: sends/receives JSON and throws an Error with the server's message.
  // If a signed-in session has ended, goes back to the login page.
  async function api(url, { method = "GET", body } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error("Can't reach the server. Check that it is running and try again.");
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401 && state.signedIn && !url.startsWith("/api/auth/")) {
        window.location.href = "/login.html#expired";
      }

      const error = new Error(data.error || `Request failed (${response.status}).`);
      error.status = response.status;
      error.code = data.code;
      throw error;
    }

    return data;
  }

  function setMessage(element, text, type = "") {
    if (!element) return;
    element.textContent = text;
    element.className = "message" + (type ? " " + type : "");
  }

  // A short notice in the corner, so feedback is visible wherever the user is on the page.
  function toast(message, type = "success") {
    let box = document.getElementById("toasts");
    if (!box) {
      box = document.createElement("div");
      box.id = "toasts";
      box.className = "toasts";
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      document.body.appendChild(box);
    }

    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = message;
    box.appendChild(item);

    setTimeout(() => {
      item.classList.add("leaving");
      setTimeout(() => item.remove(), 300);
    }, type === "error" ? 6000 : 3500);
  }

  // Disables the button while the action runs, so it can't be pressed twice.
  async function busy(button, action) {
    if (!button) return action();
    if (button.disabled) return undefined;

    button.disabled = true;
    button.classList.add("is-busy");
    try {
      return await action();
    } finally {
      button.disabled = false;
      button.classList.remove("is-busy");
    }
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
    const statusText = removed ? "Removed" : { available: "Available now", busy: "Busy", unavailable: "Off duty" }[barber.status] || "Off duty";

    return `
      <article class="barber-card${removed ? " removed" : ""}">
        <div class="barber-photo">
          ${photo
            ? `<img src="${escapeHTML(photo)}" alt="${name}" loading="lazy" data-initial="${initial}">`
            : `<div class="barber-avatar" aria-hidden="true">${initial}</div>`}
        </div>
        <div class="barber-info">
          <h2>${name}</h2>
          <p class="barber-specialty">${escapeHTML(barber.specialty || "General Barber")}</p>
          <p class="barber-bio">${escapeHTML(barber.bio || "Welcome to our barbershop!")}</p>
          <p class="barber-experience">${years ? `${years} year${years === 1 ? "" : "s"} of experience` : "Experience not specified"}</p>
          <span class="barber-status ${escapeHTML(statusClass)}">${statusText}</span>
          <div class="barber-rating" aria-label="Rated ${rating.toFixed(1)} out of 5">
            <div class="stars" aria-hidden="true">${stars}</div>
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
  // Keyboard focus stays inside while it's open and returns to where it was afterwards.
  function openDialog(innerHTML, { onClose } = {}) {
    const opener = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `<div class="card dialog" role="dialog" aria-modal="true">${innerHTML}</div>`;
    document.body.appendChild(backdrop);
    document.body.classList.add("dialog-open");

    const dialog = backdrop.querySelector(".dialog");
    const heading = dialog.querySelector("h2");
    if (heading) {
      heading.id = heading.id || "dialog-title-" + Date.now();
      dialog.setAttribute("aria-labelledby", heading.id);
    }

    function focusable() {
      return [...dialog.querySelectorAll("button, input, select, textarea, a[href]")].filter(el => !el.disabled && el.offsetParent !== null);
    }

    function onKey(event) {
      if (event.key === "Escape") close();
      if (event.key !== "Tab") return;

      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      if (!document.querySelector(".dialog-backdrop")) document.body.classList.remove("dialog-open");
      if (opener && document.contains(opener)) opener.focus();
      if (onClose) onClose();
    }

    backdrop.addEventListener("click", event => {
      if (event.target === backdrop || event.target.closest("[data-close]")) close();
    });
    document.addEventListener("keydown", onKey);
    (dialog.querySelector("input:not([type=radio]), select, textarea") || focusable()[0])?.focus();

    return { element: dialog, close };
  }

  // A styled yes/no question. Resolves to true when confirmed.
  function confirmDialog(message, { title = "Are you sure?", confirmText = "Yes", danger = false } = {}) {
    return new Promise(resolve => {
      let answered = false;
      const { element, close } = openDialog(`
        <h2>${escapeHTML(title)}</h2>
        <p class="muted">${escapeHTML(message)}</p>
        <div class="form-actions">
          <button class="${danger ? "danger-btn solid" : "primary-btn"}" type="button" data-confirm>${escapeHTML(confirmText)}</button>
          <button class="secondary-btn" type="button" data-close>Cancel</button>
        </div>`, { onClose: () => { if (!answered) resolve(false); } });

      const yes = element.querySelector("[data-confirm]");
      yes.focus();
      yes.addEventListener("click", () => {
        answered = true;
        close();
        resolve(true);
      });
    });
  }

  // Shows a one-time password that staff must hand to the account owner.
  function showTemporaryPassword(title, who, password) {
    openDialog(`
      <h2>${escapeHTML(title)}</h2>
      <p class="muted">Give this one-time password to ${escapeHTML(who)}. It is shown only once; they will be asked to change it after signing in.</p>
      <p class="temp-password">${escapeHTML(password)}</p>
      <div class="form-actions">
        <button class="secondary-btn" type="button" data-copy>Copy</button>
        <button class="primary-btn" type="button" data-close>Done</button>
      </div>
    `).element.querySelector("[data-copy]").addEventListener("click", async event => {
      try {
        await navigator.clipboard.writeText(password);
        event.target.textContent = "Copied";
      } catch {
        event.target.textContent = "Select and copy the password";
      }
    });
  }

  function downloadCSV(filename, rows) {
    const csv = rows.map(row => row.map(cell => {
      let text = String(cell ?? "");
      // Stop Excel from running text like "=HYPERLINK(...)" in a customer name as a formula.
      if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
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

  // "Show" buttons on password fields, added automatically wherever a password field appears.
  function enhancePasswords(root) {
    root.querySelectorAll?.("input[type=password]:not([data-has-toggle])").forEach(input => {
      input.dataset.hasToggle = "true";
      const wrapper = document.createElement("div");
      wrapper.className = "password-field";
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "password-toggle";
      button.textContent = "Show";
      button.setAttribute("aria-label", "Show password");
      button.addEventListener("click", () => {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        button.textContent = showing ? "Show" : "Hide";
        button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      });
      wrapper.appendChild(button);
    });
  }

  enhancePasswords(document);
  new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(node => {
      if (node.nodeType === 1) enhancePasswords(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });

  // On phones the sidebar becomes a top bar with a Menu button.
  function setupMobileMenu() {
    const sidebar = document.querySelector(".sidebar");
    const brand = sidebar?.querySelector(".brand");
    if (!brand || brand.querySelector(".menu-toggle")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-toggle";
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = '<span aria-hidden="true">☰</span> Menu';
    brand.appendChild(button);

    const setOpen = open => {
      sidebar.classList.toggle("menu-open", open);
      button.setAttribute("aria-expanded", String(open));
    };

    button.addEventListener("click", () => setOpen(!sidebar.classList.contains("menu-open")));
    sidebar.addEventListener("click", event => {
      if (event.target.closest(".nav-link")) setOpen(false);
    });
  }

  setupMobileMenu();

  // For staff pages: returns the signed-in user, or redirects anyone who shouldn't be here.
  async function requireStaff(roles) {
    try {
      const { user } = await api("/api/auth/me");

      if (!roles.includes(user.role)) {
        window.location.replace(HOME_PAGES[user.role] || "/login.html");
        return null;
      }

      state.signedIn = true;
      state.mustChangePassword = user.mustChangePassword;
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
    let firstOpen = true;

    async function open(requested) {
      // Staff with a one-time password must change it before using other pages.
      const allowed = state.mustChangePassword && pages.account ? "account" : requested;
      const key = pages[allowed] ? allowed : initial;
      const page = pages[key];

      if (typeof cleanup === "function") cleanup();
      cleanup = null;

      sidebar.querySelectorAll("[data-page]").forEach(button => {
        const active = button.dataset.page === key;
        button.classList.toggle("active", active);
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });

      title.textContent = page.title;
      document.title = `${page.title} | Renz Barbershop`;
      if (window.location.hash !== "#" + key) {
        // The first page replaces the history entry; later pages add one, so Back works.
        if (firstOpen) history.replaceState(null, "", "#" + key);
        else history.pushState(null, "", "#" + key);
      }
      firstOpen = false;
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
        <div class="page-body"><div class="loading">Loading…</div></div>`;

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

    // Back/forward buttons and links like #payments switch pages too.
    window.addEventListener("hashchange", () => open(window.location.hash.slice(1) || initial));

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
    waitedText,
    dateKey,
    today,
    api,
    setMessage,
    toast,
    busy,
    statusPill,
    safePhoto,
    barberCard,
    openDialog,
    confirmDialog,
    showTemporaryPassword,
    downloadCSV,
    logout,
    requireStaff,
    mountPages,
    state
  };
})();
