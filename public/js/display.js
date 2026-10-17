// Queue screen for a TV in the shop. Refreshes every 5 seconds.
(function () {
  const { api, escapeHTML } = App;
  const $ = id => document.getElementById(id);

  function tick() {
    $("clock").textContent = new Date().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  }

  async function refresh() {
    try {
      const data = await api("/api/queue/public");

      $("servingList").innerHTML = data.serving.length ? data.serving.map(t => `
        <div class="display-ticket serving">
          <span class="display-number">#${t.queueNumber}</span>
          <span class="display-name">${escapeHTML(t.name)}</span>
          <span class="display-barber">${escapeHTML(t.barberName || "")}</span>
        </div>`).join("") : '<p class="display-empty">Waiting for the next customer</p>';

      $("waitingList").innerHTML = data.waiting.length ? data.waiting.slice(0, 10).map(t => `
        <div class="display-ticket">
          <span class="display-number">#${t.queueNumber}</span>
          <span class="display-name">${escapeHTML(t.name)}</span>
        </div>`).join("") : '<p class="display-empty">No one waiting — walk right in!</p>';

      $("waitInfo").textContent = data.waiting.length
        ? `${data.waiting.length} waiting · about ${data.estimatedMinutes} min for new customers`
        : "";
    } catch {
      $("waitInfo").textContent = "Reconnecting...";
    }
  }

  // For a TV: click once to go full screen; the mouse pointer hides when it isn't moving.
  const hint = document.createElement("button");
  hint.className = "fullscreen-hint";
  hint.type = "button";
  hint.textContent = "Click for full screen";
  document.body.appendChild(hint);
  hint.addEventListener("click", () => document.documentElement.requestFullscreen?.().catch(() => {}));
  document.addEventListener("fullscreenchange", () => hint.classList.toggle("hidden", Boolean(document.fullscreenElement)));

  let idleTimer;
  document.addEventListener("mousemove", () => {
    document.body.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add("idle"), 3000);
  });

  tick();
  refresh();
  setInterval(tick, 10000);
  setInterval(refresh, 5000);
})();
