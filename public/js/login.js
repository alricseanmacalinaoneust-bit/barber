
document.addEventListener("DOMContentLoaded", () => {
  const adminTab = document.getElementById("adminTab");
  const customerTab = document.getElementById("customerTab");
  const adminForm = document.getElementById("adminForm");
  const customerForm = document.getElementById("customerForm");
  const formTitle = document.getElementById("formTitle");
  const formSubtitle = document.getElementById("formSubtitle");
  const loginNote = document.getElementById("loginNote");
  const loginMessage = document.getElementById("loginMessage");

  function showMessage(message, success = false) {
    loginMessage.textContent = message;
    loginMessage.classList.toggle("success", success);
  }

  function showAdmin() {
    adminForm.hidden = false;
    customerForm.hidden = true;
    adminTab.classList.add("active");
    customerTab.classList.remove("active");
    formTitle.textContent = "Welcome back";
    formSubtitle.textContent = "Sign in to access the admin dashboard.";
    loginNote.textContent =
      "Admin access requires your registered account. Complete MFA if requested.";
    showMessage("");
  }

  function showCustomer() {
    adminForm.hidden = true;
    customerForm.hidden = false;
    customerTab.classList.add("active");
    adminTab.classList.remove("active");
    formTitle.textContent = "Welcome!";
    formSubtitle.textContent =
      "Enter your name to access the customer dashboard.";
    loginNote.textContent =
      "Enter your name to continue to the customer queue.";
    showMessage("");
  }

  adminTab.addEventListener("click", showAdmin);
  customerTab.addEventListener("click", showCustomer);

  customerForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const nameInput = document.getElementById("customerName");
    const name = nameInput.value.trim();

    if (!name) {
      showMessage("Please enter your name.");
      nameInput.focus();
      return;
    }

    if (name.length > 60) {
      showMessage("Your name must be 60 characters or fewer.");
      nameInput.focus();
      return;
    }

    sessionStorage.setItem("customerName", name);
    window.location.href = "/dashboard.html";
  });

  adminForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = document.getElementById("adminEmail").value.trim();
    const password = document.getElementById("adminPassword").value;
    const submitButton = adminForm.querySelector('button[type="submit"]');

    showMessage("Signing in...");
    submitButton.disabled = true;

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || data.message || "Login failed.");
      }

      if (
        data.requiresMFA ||
        data.requires2FA ||
        data.requiresOTP ||
        data.requiresVerification
      ) {
        showMessage("Additional verification is required.", true);

        if (data.redirectUrl) {
          window.location.href = data.redirectUrl;
        }

        return;
      }

      if (data.user?.role && data.user.role !== "admin") {
        throw new Error("This account does not have administrator access.");
      }

      window.location.href = "/admin.html";
    } catch (error) {
      showMessage(error.message || "Unable to sign in.");
    } finally {
      submitButton.disabled = false;
    }
  });

  showAdmin();
});
