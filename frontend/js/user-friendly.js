(function () {
  const SIMPLE_TABS = ["requests", "details", "advanced"];
  let taskMode = "simple";

  function byId(id) {
    return document.getElementById(id);
  }

  function setBodyGroupVisibility() {
    const method = byId("tf-method");
    const group = byId("tf-body-group");
    if (!method || !group) return;
    group.style.display = method.value === "POST" ? "block" : "none";
  }

  function updateTaskModeButtons() {
    document.querySelectorAll("[data-task-mode]").forEach((button) => {
      const active = button.dataset.taskMode === taskMode;
      button.classList.toggle("btn-primary", active);
      button.classList.toggle("btn-ghost", !active);
    });
  }

  function applyTaskMode() {
    const modalBody = byId("task-modal")?.querySelector(".modal-body");
    if (!modalBody) return;

    modalBody.classList.toggle("task-simple-mode", taskMode === "simple");

    if (taskMode !== "simple") {
      updateTaskModeButtons();
      return;
    }

    const activeHiddenTab = SIMPLE_TABS.includes(
      document.querySelector("[data-tab-group='task'].active")?.dataset.tab,
    );

    if (activeHiddenTab) {
      document.querySelector('[data-tab="basic"][data-tab-group="task"]')?.click();
    }

    updateTaskModeButtons();
  }

  function setTaskMode(nextMode) {
    taskMode = nextMode === "advanced" ? "advanced" : "simple";
    applyTaskMode();
  }

  function suggestTaskName() {
    const urlInput = byId("tf-url");
    const nameInput = byId("tf-name");
    if (!urlInput || !nameInput || nameInput.value.trim()) return;

    try {
      const { hostname, pathname } = new URL(urlInput.value.trim());
      const lastPart = pathname.split("/").filter(Boolean).pop();
      const label = (lastPart || hostname)
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
      nameInput.value = `Парсер: ${label}`;
    } catch {
      // Ignore invalid URL while user is typing.
    }
  }

  function applyPreset(preset) {
    const engine = byId("tf-engine");
    const itemSelector = byId("tf-item-sel");
    const paginationEnabled = byId("tf-pagination-enabled");
    const scheduleEnabled = byId("tf-schedule-enabled");
    const cronSimple = byId("tf-cron-simple");

    const presets = {
      catalog: {
        engine: "static",
        itemSelector: "article, .product-card, .product-item",
        paginationEnabled: true,
      },
      news: {
        engine: "static",
        itemSelector: "article, .post, .news-item",
        paginationEnabled: true,
      },
      directory: {
        engine: "static",
        itemSelector: ".company-card, .listing-item, .directory-item",
        paginationEnabled: false,
      },
    };

    const config = presets[preset];
    if (!config) return;

    if (engine) engine.value = config.engine;
    if (itemSelector) itemSelector.value = config.itemSelector;
    if (paginationEnabled) paginationEnabled.checked = config.paginationEnabled;
    if (scheduleEnabled) scheduleEnabled.checked = false;
    if (cronSimple) cronSimple.value = "manual";

    document.querySelectorAll(".setup-preset").forEach((button) => {
      button.classList.toggle("active", button.dataset.preset === preset);
    });
  }

  function toggleMobileSidebar(force) {
    const shouldOpen =
      typeof force === "boolean"
        ? force
        : !document.body.classList.contains("sidebar-open");
    document.body.classList.toggle("sidebar-open", shouldOpen);
  }

  function initTaskMode() {
    document.querySelectorAll("[data-task-mode]").forEach((button) => {
      button.addEventListener("click", () => setTaskMode(button.dataset.taskMode));
    });

    document.querySelectorAll(".setup-preset").forEach((button) => {
      button.addEventListener("click", () => applyPreset(button.dataset.preset));
    });

    byId("tf-method")?.addEventListener("change", setBodyGroupVisibility);
    byId("tf-url")?.addEventListener("blur", suggestTaskName);

    byId("btn-new-task")?.addEventListener("click", () => {
      setTimeout(() => {
        setTaskMode("advanced");
        setBodyGroupVisibility();
      }, 0);
    });

    byId("btn-new-task-quick")?.addEventListener("click", () => {
      byId("btn-new-task")?.click();
      setTimeout(() => {
        setTaskMode("simple");
        applyPreset("catalog");
        suggestTaskName();
      }, 0);
    });
  }

  function initMobileNav() {
    byId("mobile-nav-toggle")?.addEventListener("click", () => toggleMobileSidebar());

    document.querySelectorAll("[data-page]").forEach((item) => {
      item.addEventListener("click", () => toggleMobileSidebar(false));
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTaskMode();
    initMobileNav();
    setBodyGroupVisibility();
    applyTaskMode();
  });
})();
