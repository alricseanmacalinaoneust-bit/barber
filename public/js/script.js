
document.addEventListener("DOMContentLoaded", () => {
  // Keep the original dashboard functions in this file.
  // Navigation is handled by navigation.js.

  // Send visitors without an admin session back to the login page.
  // (The API still checks every request; this only improves the experience.)
  fetch("/api/auth/me", { credentials: "same-origin" })
    .then(response => {
      if (response.status === 401) window.location.replace("/login.html");
    })
    .catch(() => {});

  // Mobile sidebar toggle.
  const sidebar = document.getElementById("sidebar");
  const menuToggle = document.getElementById("menuToggle");

  if (sidebar && menuToggle) {
    menuToggle.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });
  }

  // Admin profile dropdown.
  const profileBtn = document.getElementById("profileBtn");
  const profileMenu = document.getElementById("profileMenu");

  if (profileBtn && profileMenu) {
    profileBtn.addEventListener("click", event => {
      event.stopPropagation();
      profileMenu.classList.toggle("hidden");
    });

    document.addEventListener("click", event => {
      if (
        !profileMenu.contains(event.target) &&
        !profileBtn.contains(event.target)
      ) {
        profileMenu.classList.add("hidden");
      }
    });
  }

  // Logout buttons.
  async function logout() {
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin"
      });

      if (!response.ok && response.status !== 401) {
        alert("Logout failed. Please try again.");
        return;
      }

      window.location.href = "/login.html";
    } catch (error) {
      console.error("Logout error:", error);
      alert("Unable to contact the server. Please try again.");
    }
  }

  document.getElementById("logoutBtn")
    ?.addEventListener("click", logout);

  document.getElementById("profileLogout")
    ?.addEventListener("click", logout);

  // Notifications placeholder.
  document.getElementById("notificationBtn")
    ?.addEventListener("click", () => {
      alert("Notifications are not connected yet.");
    });

  // Initialize Lucide icons.
  if (window.lucide) {
    window.lucide.createIcons();
  }
});
