
document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);
  const loginMessage = $("loginMessage");

  const notes = {
    guestForm: "Walk-ins just need a name. You'll get your queue number on the next page.",
    customerLoginForm: "Accounts are optional. They keep a history of your visits.",
    registerForm: "Optional: an account keeps your visit history so you can rate visits any time. If you joined today on this device, that visit is added to your account.",
    staffForm: "For cashiers and admins. Admins confirm with an emailed code, which can be remembered on this device for 30 days."
  };

  function showMessage(message, success = false) {
    loginMessage.textContent = message;
    loginMessage.classList.toggle("success", success);
  }

  function showForm(formId) {
    ["guestForm", "customerLoginForm", "registerForm", "staffForm"].forEach(id => {
      $(id).hidden = id !== formId;
    });
    $("loginNote").textContent = notes[formId];
    showMessage("");
  }

  function showCustomer(formId = "guestForm") {
    $("customerPanel").hidden = false;
    $("customerTab").classList.add("active");
    $("staffTab").classList.remove("active");
    $("formTitle").textContent = "Welcome!";
    $("formSubtitle").textContent = "Join the queue or sign in to your account.";
    showForm(formId);
  }

  function showStaff() {
    $("customerPanel").hidden = true;
    $("staffTab").classList.add("active");
    $("customerTab").classList.remove("active");
    $("formTitle").textContent = "Welcome back";
    $("formSubtitle").textContent = "Sign in to the front desk or admin dashboard.";
    showForm("staffForm");
  }

  async function post(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  // Disables the form's button while a request runs.
  function handle(form, action) {
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      showMessage("Please wait...");

      try {
        await action();
      } catch (error) {
        showMessage(error.message || "Unable to continue.");
      } finally {
        button.disabled = false;
      }
    });
  }

  function signIn(email, password) {
    return post("/api/auth/login", { email, password }).then(data => {
      if (data.requires2FA) showMessage("Check your email for a verification code.", true);
      window.location.href = data.redirectUrl;
    });
  }

  $("customerTab").addEventListener("click", () => showCustomer());
  $("staffTab").addEventListener("click", showStaff);
  document.querySelectorAll("#customerPanel [data-form]").forEach(button => {
    button.addEventListener("click", () => showForm(button.dataset.form));
  });

  let deviceTicket = null;

  handle($("guestForm"), async () => {
    const name = $("guestName").value.trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 60) throw new Error("Your name must be 2 to 60 characters.");

    // The same person coming back keeps their ticket. Anyone else starts fresh, so a shared
    // device doesn't show the previous person's ticket or account.
    const samePerson = deviceTicket && deviceTicket.customerName.toLowerCase() === name.toLowerCase();
    if (!samePerson) await post("/api/auth/logout", {}).catch(() => {});

    sessionStorage.setItem("customerName", samePerson ? deviceTicket.customerName : name);
    window.location.href = "/dashboard.html";
  });

  handle($("customerLoginForm"), () => signIn($("customerEmail").value.trim(), $("customerPassword").value));
  handle($("staffForm"), () => signIn($("staffEmail").value.trim(), $("staffPassword").value));

  handle($("registerForm"), async () => {
    sessionStorage.removeItem("customerName");
    const data = await post("/api/auth/register", {
      name: $("registerName").value,
      email: $("registerEmail").value,
      phone: $("registerPhone").value,
      password: $("registerPassword").value
    });
    window.location.href = data.redirectUrl;
  });

  // Links such as /login.html#register open the right form (also when already on this page).
  function openFromHash() {
    const hash = window.location.hash.slice(1);
    if (hash === "staff") showStaff();
    else if (hash === "register") showCustomer("registerForm");
    else if (hash === "signin") showCustomer("customerLoginForm");
    else showCustomer();
    return hash;
  }

  window.addEventListener("hashchange", openFromHash);
  const start = openFromHash();

  if (start === "expired") showMessage("Your session has ended. Please sign in again.");
  if (start === "deleted") showMessage("Your account has been deleted.", true);

  // If this device is already signed in, or already has a ticket in today's queue, say so
  // instead of silently replacing it (a walk-in who closed the page can get back to their ticket).
  const notice = $("deviceNotice");

  function showNotice(html) {
    notice.innerHTML = html;
    notice.classList.remove("hidden");
  }

  async function checkDevice() {
    const me = await fetch("/api/auth/me", { credentials: "same-origin" }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (me?.user) {
      const home = { admin: "/admin.html", cashier: "/cashier.html", customer: "/dashboard.html" }[me.user.role];
      showNotice(`You're signed in as <strong>${App.escapeHTML(me.user.name)}</strong>. <a href="${home}">Continue</a> · <button class="link-btn" type="button" data-fresh>Sign out</button>`);
      return;
    }

    const mine = await fetch("/api/queue/mine", { credentials: "same-origin" }).then(r => r.ok ? r.json() : null).catch(() => null);
    const ticket = mine?.ticket;
    if (ticket && ["waiting", "serving"].includes(ticket.status)) {
      deviceTicket = ticket;
      showNotice(`You're in today's queue as <strong>#${ticket.queueNumber} ${App.escapeHTML(ticket.customerName)}</strong>. <a href="/dashboard.html">Go to my ticket</a> · <button class="link-btn" type="button" data-fresh>Not you? Start fresh</button>`);
    }
  }

  notice.addEventListener("click", async event => {
    if (!event.target.closest("[data-fresh]")) return;
    await post("/api/auth/logout", {}).catch(() => {});
    sessionStorage.removeItem("customerName");
    deviceTicket = null;
    notice.classList.add("hidden");
    showMessage("Signed out on this device.", true);
  });

  checkDevice();
});
