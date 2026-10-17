
document.addEventListener("DOMContentLoaded", () => {
  const sidebar = document.getElementById("sidebar");
  const pageContent = document.querySelector(".page-content");

  if (!sidebar || !pageContent) {
    alert("Navigation error: sidebar or page content is missing.");
    return;
  }

  // Keep the original Analytics HTML.
  const analyticsHTML = pageContent.innerHTML;

  const pages = {
    Dashboard: {
      title: "Dashboard",
      description: "Overview of your barbershop system."
    },
    Queue: {
      title: "Queue Management",
      description: "Manage customer queues and waiting times."
    },
    Customers: {
      title: "Customers",
      description: "View and manage customer information."
    },
    Barbers: {
      title: "Barbers",
      description: "Manage barber profiles and ratings."
    },
    Services: {
      title: "Services",
      description: "Manage barbershop services."
    },
    Inventory: {
      title: "Inventory",
      description: "Manage stock and products."
    },
    Analytics: {
      title: "Analytics",
      description: "View barbershop performance and key metrics."
    },
    Reports: {
      title: "Reports",
      description: "View and prepare barbershop reports."
    },
    Settings: {
      title: "Settings",
      description: "Manage system settings."
    }
  };

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function closeMobileSidebar() {
    if (window.innerWidth <= 760) {
      sidebar.classList.remove("open");
    }
  }

  function getBarberPhoto(value) {
    if (!value) return "";

    try {
      const url = new URL(value, window.location.origin);

      if (!["http:", "https:"].includes(url.protocol)) return "";

      if (
        url.origin !== window.location.origin &&
        url.protocol !== "https:"
      ) return "";

      return url.href;
    } catch {
      return "";
    }
  }

  function renderBarberCard(barber) {
    const name = escapeHTML(barber.name || "Barber");
    const specialty = escapeHTML(
      barber.specialty || "General Barber"
    );
    const bio = escapeHTML(
      barber.bio || "Welcome to our barbershop!"
    );

    const experience = Math.max(
      0,
      Number(barber.experienceYears) || 0
    );

    const ratingValue = Number(barber.averageRating);
    const rating = Number.isFinite(ratingValue)
      ? Math.min(5, Math.max(0, ratingValue))
      : 0;

    const reviews = Math.max(
      0,
      Number(barber.reviewCount) || 0
    );

    const photo = getBarberPhoto(barber.photoUrl);
    const available = barber.available === true;

    const stars =
      "★".repeat(Math.round(rating)) +
      "☆".repeat(5 - Math.round(rating));

    return `
      <article class="barber-card">
        <div class="barber-photo">
          ${
            photo
              ? `<img src="${escapeHTML(photo)}"
                     alt="${name}"
                     loading="lazy"
                     onerror="this.style.display='none';
                     this.nextElementSibling.style.display='grid';">
                 <div class="barber-avatar" style="display:none">
                   ${escapeHTML((barber.name || "B").charAt(0).toUpperCase())}
                 </div>`
              : `<div class="barber-avatar">
                   ${escapeHTML((barber.name || "B").charAt(0).toUpperCase())}
                 </div>`
          }
        </div>

        <div class="barber-info">
          <h3>${name}</h3>
          <p class="barber-specialty">${specialty}</p>
          <p class="barber-bio">${bio}</p>

          <p class="barber-experience">
            ${experience} year${experience === 1 ? "" : "s"} of experience
          </p>

          <div class="barber-rating">
            <span class="barber-stars">${stars}</span>
            <span class="barber-rating-text">
              ${rating.toFixed(1)} / 5 (${reviews} reviews)
            </span>
          </div>

          <span class="barber-status ${available ? "available" : "busy"}">
            ${available ? "Available" : "Currently busy"}
          </span>

          <button type="button"
            class="barber-rate-button"
            data-rate-barber="${escapeHTML(barber.id)}"
            data-barber-name="${name}">
            Rate this barber
          </button>
        </div>
      </article>
    `;
  }

  // BARBERS PAGE
  async function showBarbersPage() {
    pageContent.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>Barbers</h1>
          <p>Manage barber profiles, availability, and ratings.</p>
        </div>
      </div>

      <section class="barber-section">
        <div class="barber-section-header">
          <div>
            <h2>Barber Management</h2>
            <p>Add a barber or view existing profiles.</p>
          </div>
          <button type="button" id="showAddBarber">+ Add a Barber</button>
        </div>

        <form id="addBarberForm" class="barber-form hidden">
          <h3>Add a New Barber</h3>

          <div class="barber-form-grid">
            <label>
              Full name *
              <input name="name" required maxlength="80">
            </label>

            <label>
              Specialty *
              <input name="specialty" required maxlength="80"
                placeholder="e.g. Fade and classic haircut">
            </label>

            <label>
              Profile picture URL
              <input name="photoUrl" type="url"
                placeholder="https://example.com/photo.jpg">
            </label>

            <label>
              Years of experience
              <input name="experienceYears" type="number"
                min="0" max="60" value="0" required>
            </label>

            <label class="barber-full-width">
              Short biography
              <textarea name="bio" maxlength="500" rows="3"></textarea>
            </label>
          </div>

          <div class="barber-form-actions">
            <button type="submit" id="saveBarberButton">Save Barber</button>
            <button type="button" id="cancelAddBarber">Cancel</button>
          </div>

          <p id="addBarberMessage" role="status"></p>
        </form>

        <div id="barberMessage" role="status" aria-live="polite"></div>

        <div id="barberList" class="barber-grid">
          <p>Loading barbers...</p>
        </div>
      </section>

      <div id="ratingDialog" class="rating-dialog hidden">
        <form id="ratingForm" class="barber-form">
          <h3 id="ratingHeading">Rate a Barber</h3>
          <p>Ratings require a completed visit.</p>

          <label>
            Customer name *
            <input name="customerName" required maxlength="80">
          </label>

          <label>
            Queue number *
            <input name="queueNumber" type="number" min="1" required>
          </label>

          <label>
            Queue date *
            <input name="queueDate" type="date" required>
          </label>

          <label>
            Rating *
            <select name="rating" required>
              <option value="">Choose a rating</option>
              <option value="5">5 - Excellent</option>
              <option value="4">4 - Very good</option>
              <option value="3">3 - Good</option>
              <option value="2">2 - Fair</option>
              <option value="1">1 - Poor</option>
            </select>
          </label>

          <label>
            Comment (optional)
            <textarea name="comment" maxlength="500" rows="3"></textarea>
          </label>

          <div class="barber-form-actions">
            <button type="submit">Submit Rating</button>
            <button type="button" id="cancelRating">Cancel</button>
          </div>

          <p id="ratingMessage" role="status"></p>
        </form>
      </div>
    `;

    const list = document.getElementById("barberList");
    const message = document.getElementById("barberMessage");
    const addForm = document.getElementById("addBarberForm");
    const ratingDialog = document.getElementById("ratingDialog");
    const ratingForm = document.getElementById("ratingForm");

    let selectedBarberId = "";

    async function loadBarbers() {
      list.innerHTML = "<p>Loading barbers...</p>";
      message.textContent = "";

      try {
        const response = await fetch("/api/barbers", {
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        });

        if (!response.ok) {
          throw new Error("Unable to load barbers. Status: " + response.status);
        }

        const barbers = await response.json();

        if (!Array.isArray(barbers)) {
          throw new Error("Unexpected response from the barbers API.");
        }

        if (barbers.length === 0) {
          list.innerHTML = `
            <div class="barber-empty">
              <h3>No barbers added yet</h3>
              <p>Click “Add a Barber” to create the first profile.</p>
            </div>`;
          return;
        }

        list.innerHTML = barbers.map(renderBarberCard).join("");
      } catch (error) {
        console.error("Barbers error:", error);
        list.innerHTML = `
          <div class="barber-error">
            <h3>Unable to load barbers</h3>
            <p>Check your server connection and try again.</p>
          </div>`;
        message.textContent = error.message;
      }
    }

    document.getElementById("showAddBarber")
      .addEventListener("click", () => {
        addForm.classList.toggle("hidden");
      });

    document.getElementById("cancelAddBarber")
      .addEventListener("click", () => {
        addForm.reset();
        addForm.classList.add("hidden");
        document.getElementById("addBarberMessage").textContent = "";
      });

    addForm.addEventListener("submit", async event => {
      event.preventDefault();

      const saveButton = document.getElementById("saveBarberButton");
      const resultMessage = document.getElementById("addBarberMessage");
      const formData = new FormData(addForm);

      const data = {
        name: String(formData.get("name") || "").trim(),
        specialty: String(formData.get("specialty") || "").trim(),
        photoUrl: String(formData.get("photoUrl") || "").trim(),
        experienceYears: Number(formData.get("experienceYears")),
        bio: String(formData.get("bio") || "").trim()
      };

      if (
        !data.name ||
        !data.specialty ||
        !Number.isInteger(data.experienceYears) ||
        data.experienceYears < 0 ||
        data.experienceYears > 60
      ) {
        resultMessage.textContent = "Please check the required fields.";
        return;
      }

      saveButton.disabled = true;
      resultMessage.textContent = "Saving barber...";

      try {
        const response = await fetch("/api/barbers", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data)
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(result.error || "Could not save barber.");
        }

        resultMessage.textContent = "Barber saved successfully.";
        addForm.reset();
        addForm.classList.add("hidden");
        await loadBarbers();
      } catch (error) {
        resultMessage.textContent = error.message;
      } finally {
        saveButton.disabled = false;
      }
    });

    list.addEventListener("click", event => {
      const button = event.target.closest("[data-rate-barber]");
      if (!button) return;

      selectedBarberId = button.dataset.rateBarber;
      document.getElementById("ratingHeading").textContent =
        "Rate " + button.dataset.barberName;

      ratingForm.reset();
      document.getElementById("ratingMessage").textContent = "";
      ratingDialog.classList.remove("hidden");
    });

    document.getElementById("cancelRating")
      .addEventListener("click", () => {
        ratingDialog.classList.add("hidden");
        ratingForm.reset();
      });

    ratingForm.addEventListener("submit", async event => {
      event.preventDefault();

      const formData = new FormData(ratingForm);
      const resultMessage = document.getElementById("ratingMessage");

      const data = {
        customerName: String(formData.get("customerName") || "").trim(),
        queueNumber: Number(formData.get("queueNumber")),
        queueDate: String(formData.get("queueDate") || ""),
        rating: Number(formData.get("rating")),
        comment: String(formData.get("comment") || "").trim()
      };

      resultMessage.textContent = "Submitting rating...";

      try {
        const response = await fetch(
          "/api/barbers/" + encodeURIComponent(selectedBarberId) + "/ratings",
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
          }
        );

        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(result.error || "Could not submit rating.");
        }

        resultMessage.textContent =
          result.message || "Rating submitted successfully.";

        await loadBarbers();

        setTimeout(() => {
          ratingDialog.classList.add("hidden");
          ratingForm.reset();
        }, 1000);
      } catch (error) {
        resultMessage.textContent = error.message;
      }
    });

    await loadBarbers();
  }

  // NAVIGATION CONTROLLER
  function openPage(pageName) {
    const page = pages[pageName];
    if (!page) return;

    sidebar.querySelectorAll("[data-page]").forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.page === pageName
      );
    });

    if (pageName === "Analytics") {
      pageContent.innerHTML = analyticsHTML;

      if (typeof window.renderDashboard === "function") {
        const filter = document.getElementById("dateFilter");
        window.renderDashboard(filter?.value || "today");
      }

      if (window.lucide) window.lucide.createIcons();

      closeMobileSidebar();
      return;
    }

    if (pageName === "Barbers") {
      closeMobileSidebar();
      showBarbersPage();
      return;
    }

    pageContent.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>${escapeHTML(page.title)}</h1>
          <p>${escapeHTML(page.description)}</p>
        </div>
      </div>

      <section class="panel" style="padding:24px;">
        <h2>${escapeHTML(page.title)}</h2>
        <p>${escapeHTML(page.description)}</p>

        <div style="
          margin-top:20px;
          padding:18px;
          background:#f4f7fb;
          border-radius:8px;
        ">
          <strong>Navigation is working!</strong>
          <p>This section still needs to be connected to its actual system functions.</p>
        </div>

        <button type="button" id="returnAnalytics"
          style="margin-top:18px;padding:10px 16px;
          background:#2879df;color:white;border:0;
          border-radius:6px;cursor:pointer;">
          Return to Analytics
        </button>
      </section>
    `;

    document.getElementById("returnAnalytics")
      .addEventListener("click", () => openPage("Analytics"));

    if (window.lucide) window.lucide.createIcons();

    closeMobileSidebar();
  }

  // Handle clicks on sidebar buttons.
  sidebar.addEventListener("click", event => {
    const button = event.target.closest("button[data-page]");
    if (!button) return;

    event.preventDefault();
    openPage(button.dataset.page);
  });

  // Handle Analytics shortcuts such as View all.
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    const pageName = action.charAt(0).toUpperCase() + action.slice(1);

    openPage(pageName);
  });

  console.log("Sidebar navigation initialized.");
});
