
document.addEventListener("DOMContentLoaded", () => {
  const verifyForm = document.getElementById("verifyForm");
  const verifyMessage = document.getElementById("verifyMessage");

  function showMessage(message, success = false) {
    verifyMessage.textContent = message;
    verifyMessage.classList.toggle("success", success);
  }

  verifyForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const code = document.getElementById("verifyCode").value.trim();
    const submitButton = verifyForm.querySelector('button[type="submit"]');

    if (!/^\d{6}$/.test(code)) {
      showMessage("Enter the 6-digit code from your email.");
      return;
    }

    showMessage("Verifying...");
    submitButton.disabled = true;

    try {
      const response = await fetch("/api/auth/verify-2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Verification failed.");
      }

      showMessage("Verified. Redirecting...", true);
      window.location.href = "/admin.html";
    } catch (error) {
      showMessage(error.message || "Unable to verify the code.");
    } finally {
      submitButton.disabled = false;
    }
  });
});
