/**
 * Web Parser Pro — Frontend Application
 * Single-page app powered by vanilla JS
 */

// ── Domain Profiles (localStorage) ───────────────────────────────────────
const DomainProfiles = (() => {
  const KEY = "parser_domain_profiles";
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch {
      return {};
    }
  };
  const save = (profiles) =>
    localStorage.setItem(KEY, JSON.stringify(profiles));

  const getHost = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  };

  const remember = (url, { selectors, pagination, engine, schedule }) => {
    const host = getHost(url);
    if (!host) return;
    const profiles = load();
    profiles[host] = {
      selectors,
      pagination,
      engine,
      schedule,
      savedAt: Date.now(),
    };
    save(profiles);
  };

  const get = (url) => {
    const host = getHost(url);
    return host ? load()[host] : null;
  };

  const list = () => load();

  return { remember, get, list, getHost };
})();

// ── UI helpers ────────────────────────────────────────────────────────────
const UI = (() => {
  let toastTimer = {};

  const toast = (msg, type = "info", duration = 4000) => {
    const container = document.getElementById("toast-container");
    const el = document.createElement("div");
    const icon =
      { success: "✓", error: "✗", warning: "⚠", info: "ℹ" }[type] || "•";
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
    container.appendChild(el);
    setTimeout(() => el.remove(), duration);
  };

  const show = (id) => document.getElementById(id)?.classList.remove("hidden");
  const hide = (id) => document.getElementById(id)?.classList.add("hidden");
  const setHtml = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };

  const loading = (btn, state) => {
    if (state) {
      btn.dataset.original = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span> Завантаження...';
      btn.disabled = true;
    } else {
      if (btn.dataset.original) btn.innerHTML = btn.dataset.original;
      btn.disabled = false;
    }
  };

  const confirm = (msg) => window.confirm(msg);

  const fmtDate = (d) => (d ? new Date(d).toLocaleString("uk-UA") : "—");
  const fmtDur = (ms) =>
    !ms
      ? "—"
      : ms < 1000
        ? `${ms}ms`
        : ms < 60000
          ? `${(ms / 1000).toFixed(1)}s`
          : `${(ms / 60000).toFixed(1)}m`;
  const statusLabels = {
    idle: "очікує",
    running: "виконується",
    completed: "завершено",
    error: "помилка",
    scheduled: "заплановано",
    active: "активний",
    inactive: "неактивний",
    banned: "заблоковано",
    unchecked: "не перевірено",
  };
  const badge = (status) =>
    `<span class="badge badge-${status}">${statusLabels[status] || status}</span>`;

  return {
    toast,
    show,
    hide,
    setHtml,
    loading,
    confirm,
    fmtDate,
    fmtDur,
    badge,
  };
})();

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  currentPage: "dashboard",
  tasks: [],
  proxies: [],
  selectedTaskId: null,
  taskPage: 1,
  proxyPage: 1,
  editingTask: null,
  fields: [], // list-level field rows
  detailFields: [], // detail-page field rows
  requests: [], // multi-request list
  results: [],
  exportFieldConfig: null,
  currentSubTask: { taskId: null, subTaskId: null }, // for history export
};

// ── Navigation ────────────────────────────────────────────────────────────
const navigate = (page) => {
  state.currentPage = page;

  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.page === page);
  });

  document.querySelectorAll(".page").forEach((el) => {
    el.classList.toggle("hidden", el.id !== `page-${page}`);
  });

  const loaders = {
    dashboard: loadDashboard,
    tasks: loadTasks,
    proxies: loadProxies,
    results: loadResults,
    monitor: loadMonitor,
    "site-auths": loadSiteAuths,
  };
  loaders[page]?.();
};

// ── Auth ──────────────────────────────────────────────────────────────────
const Auth = (() => {
  const init = async () => {
    const token = API.getToken();
    if (!token) {
      showLogin();
      return;
    }

    try {
      const { user } = await API.auth.me();
      document.getElementById("user-name").textContent = user.username;
      UI.hide("login-screen");
    } catch {
      API.clearToken();
      showLogin();
    }
  };

  const showLogin = () => UI.show("login-screen");

  const login = async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    UI.loading(btn, true);
    try {
      const email = document.getElementById("login-email").value;
      const password = document.getElementById("login-password").value;
      const { token, user } = await API.auth.login({ email, password });
      API.setToken(token);
      document.getElementById("user-name").textContent = user.username;
      UI.hide("login-screen");
      navigate("dashboard");
      UI.toast(`З поверненням, ${user.username}!`, "success");
    } catch (err) {
      UI.toast(err.message, "error");
    } finally {
      UI.loading(btn, false);
    }
  };

  const register = async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    UI.loading(btn, true);
    try {
      const username = document.getElementById("reg-username").value;
      const email = document.getElementById("reg-email").value;
      const password = document.getElementById("reg-password").value;
      const { token, user } = await API.auth.register({
        username,
        email,
        password,
      });
      API.setToken(token);
      document.getElementById("user-name").textContent = user.username;
      UI.hide("login-screen");
      navigate("dashboard");
      UI.toast(`Акаунт створено! Вітаємо, ${user.username}`, "success");
    } catch (err) {
      UI.toast(err.message, "error");
    } finally {
      UI.loading(btn, false);
    }
  };

  const logout = () => {
    API.clearToken();
    showLogin();
    UI.toast("Вихід виконано", "info");
  };

  return { init, login, register, logout };
})();

// ── Dashboard ─────────────────────────────────────────────────────────────
const loadDashboard = async () => {
  try {
    const [tasksData, proxyStats, queueData] = await Promise.allSettled([
      API.tasks.list({ limit: 100 }),
      API.proxies.stats(),
      API.tasks.queueStats(),
    ]);

    const tasks = tasksData.value?.items || [];
    const proxy = proxyStats.value || {};
    const queue = queueData.value?.queue || {};

    const running = tasks.filter((t) => t.status === "running").length;
    const scheduled = tasks.filter((t) => t.schedule?.enabled).length;
    const totalRecs = tasks.reduce(
      (s, t) => s + (t.stats?.totalRecords || 0),
      0,
    );

    UI.setHtml("stat-total-tasks", tasks.length);
    UI.setHtml("stat-running", running);
    UI.setHtml("stat-scheduled", scheduled);
    UI.setHtml("stat-total-records", totalRecs.toLocaleString());
    UI.setHtml("stat-proxies", proxy.byStatus?.active || 0);
    UI.setHtml("stat-queue", queue.active || 0);

    // Recent tasks table
    const rows = tasks
      .slice(0, 10)
      .map(
        (t) => `
      <tr>
        <td><strong>${escHtml(t.name)}</strong></td>
        <td>${UI.badge(t.status)}</td>
        <td>${(t.stats?.totalRecords || 0).toLocaleString()}</td>
        <td>${UI.fmtDate(t.stats?.lastRun || t.schedule?.lastRun || t.updatedAt)}</td>
        <td>${UI.fmtDur(t.stats?.lastDuration)}</td>
        <td>
          ${
            t.status === "running"
              ? `<button class="btn btn-sm btn-danger" onclick="stopTask('${t._id}')">■ Стоп</button>
                 <button class="btn btn-sm btn-ghost" onclick="openMonitor('${t._id}','${t.name.replace(/'/g, "\\'")}')">◉ Монітор</button>`
              : `<button class="btn btn-sm btn-primary" onclick="runTask('${t._id}')">▶ Запустити</button>`
          }
          <button class="btn btn-sm btn-ghost" onclick="showRunLog('${t._id}')">Лог</button>
        </td>
      </tr>
    `,
      )
      .join("");

    UI.setHtml(
      "dashboard-tasks",
      rows ||
        '<tr><td colspan="6" style="text-align:center;color:#94a3b8">Задач ще немає</td></tr>',
    );
  } catch (err) {
    UI.toast("Помилка завантаження дашборду: " + err.message, "error");
  }
};

// ── Monitor ───────────────────────────────────────────────────────────────

let _monitorRefreshTimer = null;
let _monitorCountdownTimer = null;

/** Format seconds as "2г 15хв 30с" */
const fmtCountdown = (sec) => {
  if (sec <= 0)
    return '<span style="color:var(--warning)">Очікує запуску…</span>';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h}г`);
  if (m || h) parts.push(`${m}хв`);
  parts.push(`${s}с`);
  return parts.join(" ");
};

const renderMonitorTask = (t, extra = "") => `
  <div class="flex-gap" style="padding:10px 16px;border-bottom:1px solid var(--border);align-items:center;gap:12px">
    <div style="flex:1;min-width:0">
      <div style="font-weight:500;font-size:13px">${escHtml(t.name)}</div>
      <div style="font-size:11px;color:var(--text-2);margin-top:2px">${escHtml((t.url || "").slice(0, 60))}</div>
    </div>
    ${extra}
    <div style="display:flex;gap:6px;flex-shrink:0">
      ${
        t.status === "running"
          ? `<button class="btn btn-xs btn-ghost" onclick="openMonitor('${t._id}','${escHtml(t.name.replace(/'/g, "\\'"))}')">◉ Монітор</button>
           <button class="btn btn-xs btn-danger" onclick="stopTask('${t._id}')">■ Стоп</button>`
          : t.status === "paused"
            ? `<button class="btn btn-xs btn-primary" onclick="resumeTask('${t._id}')">▶ Продовжити</button>
             <button class="btn btn-xs btn-danger" onclick="stopTask('${t._id}')">■ Стоп</button>`
            : `<button class="btn btn-xs btn-primary" onclick="runTask('${t._id}')">▶ Запустити</button>`
      }
    </div>
  </div>`;

const loadMonitor = async () => {
  clearInterval(_monitorRefreshTimer);
  clearInterval(_monitorCountdownTimer);

  try {
    const data = await API.monitor.get();
    const { runningTasks, pausedTasks, scheduledTasks, activeSubtasks } = data;

    // Running
    UI.setHtml("monitor-running-count", runningTasks.length);
    UI.setHtml(
      "monitor-running",
      runningTasks.length
        ? runningTasks
            .map((t) =>
              renderMonitorTask(
                t,
                `<span class="badge badge-warning" style="flex-shrink:0">▶ виконується</span>`,
              ),
            )
            .join("")
        : '<div class="empty-state" style="padding:16px">Немає активних задач</div>',
    );

    // Paused
    UI.setHtml("monitor-paused-count", pausedTasks.length);
    UI.setHtml(
      "monitor-paused",
      pausedTasks.length
        ? pausedTasks
            .map((t) =>
              renderMonitorTask(
                t,
                `<span class="badge badge-idle" style="flex-shrink:0">⏸ пауза</span>`,
              ),
            )
            .join("")
        : '<div class="empty-state" style="padding:16px">Немає призупинених</div>',
    );

    // Scheduled — render with countdown placeholders
    UI.setHtml("monitor-scheduled-count", scheduledTasks.length);
    UI.setHtml(
      "monitor-scheduled",
      scheduledTasks.length
        ? scheduledTasks
            .map((t) => {
              const nextRunTs = t.schedule?.nextRun
                ? new Date(t.schedule.nextRun).getTime()
                : null;
              return `
            <div class="flex-gap" style="padding:10px 16px;border-bottom:1px solid var(--border);align-items:center;gap:12px">
              <div style="flex:1;min-width:0">
                <div style="font-weight:500;font-size:13px">${escHtml(t.name)}</div>
                <div style="font-size:11px;color:var(--text-2);margin-top:2px">
                  cron: <span class="code">${escHtml(t.schedule?.cron || "")}</span>
                </div>
              </div>
              <div style="text-align:right;flex-shrink:0;font-size:12px">
                <div style="color:var(--text-2)">Запуск через</div>
                <div class="monitor-countdown" data-next="${nextRunTs || 0}" style="font-weight:600;color:var(--primary)">—</div>
              </div>
              <button class="btn btn-xs btn-primary" onclick="runTask('${t._id}')">▶ Зараз</button>
            </div>`;
            })
            .join("")
        : '<div class="empty-state" style="padding:16px">Немає запланованих задач</div>',
    );

    // Active subtasks
    UI.setHtml("monitor-subtasks-count", activeSubtasks.length);
    UI.setHtml(
      "monitor-subtasks",
      activeSubtasks.length
        ? activeSubtasks
            .map((st) => {
              const nextRunTs = st.schedule?.nextRun
                ? new Date(st.schedule.nextRun).getTime()
                : null;
              const statusCls =
                st.status === "running"
                  ? "warning"
                  : st.status === "error"
                    ? "danger"
                    : "success";
              return `
            <div class="flex-gap" style="padding:10px 16px;border-bottom:1px solid var(--border);align-items:center;gap:12px">
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;word-break:break-all">${escHtml((st.url || "").slice(0, 80))}</div>
                <div style="font-size:11px;color:var(--text-2);margin-top:2px">
                  Запусків: ${st.totalRuns} · Змін: ${st.changedRuns}
                </div>
              </div>
              <span class="badge badge-${statusCls}" style="flex-shrink:0">${st.status}</span>
              <div style="text-align:right;flex-shrink:0;font-size:12px;min-width:90px">
                <div style="color:var(--text-2)">Запуск через</div>
                <div class="monitor-countdown" data-next="${nextRunTs || 0}" style="font-weight:600;color:var(--primary)">—</div>
              </div>
              <button class="btn btn-xs btn-ghost" onclick="runSubTaskNow('${st.parentTaskId}','${st._id}',this)">▶</button>
            </div>`;
            })
            .join("")
        : '<div class="empty-state" style="padding:16px">Немає активних підзадач</div>',
    );

    // Live countdown ticker
    const tickCountdowns = () => {
      const now = Date.now();
      document
        .querySelectorAll("#page-monitor .monitor-countdown")
        .forEach((el) => {
          const next = parseInt(el.dataset.next);
          if (!next) {
            el.innerHTML = "—";
            return;
          }
          el.innerHTML = fmtCountdown(
            Math.max(0, Math.round((next - now) / 1000)),
          );
        });
    };
    tickCountdowns();
    _monitorCountdownTimer = setInterval(tickCountdowns, 1000);

    // Auto-refresh data every 15s
    _monitorRefreshTimer = setInterval(() => {
      if (
        document.getElementById("page-monitor")?.classList.contains("hidden")
      ) {
        clearInterval(_monitorRefreshTimer);
        clearInterval(_monitorCountdownTimer);
        return;
      }
      loadMonitor();
    }, 15000);
  } catch (err) {
    UI.toast("Помилка завантаження монітора: " + err.message, "error");
  }
};

// ── Tasks ─────────────────────────────────────────────────────────────────
const loadTasks = async () => {
  try {
    const data = await API.tasks.list({ page: state.taskPage, limit: 100 });
    state.tasks = data.items;
    renderTasksTable(data);
  } catch (err) {
    UI.toast("Не вдалося завантажити задачі: " + err.message, "error");
  }
};

const renderTasksTable = ({ items, total, page, pages }) => {
  const rows = items
    .map(
      (t) => `
    <tr>
      <td><strong>${escHtml(t.name)}</strong><br><small class="code">${escHtml((t.url || "").slice(0, 50))}</small></td>
      <td>${UI.badge(t.status)}</td>
      <td>${t.engine}</td>
      <td>${(t.stats?.totalRecords || 0).toLocaleString()}</td>
      <td>${t.schedule?.enabled ? `<span class="code">${t.schedule.cron}</span>` : "—"}</td>
      <td>${UI.fmtDate(t.updatedAt)}</td>
      <td>
        <div class="flex-gap">
          ${
            t.status === "running"
              ? `<button class="btn btn-xs btn-danger" onclick="stopTask('${t._id}')">■ Стоп</button>
                 <button class="btn btn-xs btn-ghost" onclick="openMonitor('${t._id}','${t.name.replace(/'/g, "\\'")}')">◉</button>`
              : `<button class="btn btn-xs btn-primary" onclick="runTask('${t._id}')">▶</button>`
          }
          <button class="btn btn-xs btn-ghost"   onclick="viewResults('${t._id}')">Результати</button>
          <button class="btn btn-xs btn-ghost"   onclick="showRunLog('${t._id}')">Лог</button>
          <button class="btn btn-xs btn-ghost"   onclick="editTask('${t._id}')">Редагувати</button>
          <button class="btn btn-xs btn-danger"  onclick="deleteTask('${t._id}')">✕</button>
        </div>
      </td>
    </tr>
  `,
    )
    .join("");

  UI.setHtml(
    "tasks-tbody",
    rows ||
      '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:40px">Задач ще немає. Натисніть «Нова задача» для початку.</td></tr>',
  );
  UI.setHtml("tasks-count", `${total} задач`);
  renderPagination("tasks-pagination", page, pages, (p) => {
    state.taskPage = p;
    loadTasks();
  });
};

const runTask = async (id) => {
  // Get name from state before anything else
  const task = state.tasks?.find((t) => String(t._id) === String(id));
  const name = task?.name || "";
  // Open monitor BEFORE the API call so it's visible immediately
  // (when Redis is unavailable tasks run synchronously — the API only returns after parse finishes)
  LiveMonitor.open(id, name);
  try {
    await API.tasks.run(id);
    UI.toast("Задачу запущено!", "success");
    setTimeout(loadTasks, 1000);
  } catch (err) {
    LiveMonitor.close();
    document.getElementById("live-monitor-modal")?.classList.remove("open");
    UI.toast(err.message, "error");
  }
};

const openMonitor = (id, name) => {
  LiveMonitor.open(id, name);
};

const stopTask = async (id) => {
  try {
    await API.tasks.stop(id);
    UI.toast("Сигнал зупинки надіслано", "info");
    setTimeout(loadTasks, 1500);
  } catch (err) {
    UI.toast(err.message, "error");
  }
};

const resumeTask = async (id) => {
  try {
    await API.tasks.resume(id);
    UI.toast("Задачу відновлено", "success");
    setTimeout(loadMonitor, 800);
  } catch (err) {
    UI.toast(err.message, "error");
  }
};

const deleteTask = async (id) => {
  if (!UI.confirm("Видалити цю задачу та всі її результати?")) return;
  try {
    await API.tasks.delete(id);
    UI.toast("Задачу видалено", "success");
    loadTasks();
  } catch (err) {
    UI.toast(err.message, "error");
  }
};

const editTask = async (id) => {
  try {
    const { task } = await API.tasks.get(id);
    state.editingTask = task;
    openTaskModal(task);
  } catch (err) {
    UI.toast(err.message, "error");
  }
};

const viewResults = (taskId) => {
  state.selectedTaskId = taskId;
  navigate("results");
};

const triggerExportDownload = async (fmt) => {
  if (!state.selectedTaskId) return;
  try {
    const params = getExportParams();
    const { blob, filename } = await API.results.exportFile(
      state.selectedTaskId,
      fmt,
      undefined,
      params,
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    UI.toast("Помилка експорту: " + err.message, "error");
  }
};

// ── Task Modal ────────────────────────────────────────────────────────────
const openTaskModal = (task = null) => {
  state.editingTask = task;
  state.fields = [];
  state.parsedFieldNames = [];

  document.getElementById("task-modal-title").textContent = task
    ? "Редагувати задачу"
    : "Нова задача";

  // Populate form
  const f = (id, val = "") => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  f("tf-name", task?.name || "");
  f("tf-url", task?.url || "");
  f("tf-engine", task?.engine || "static");
  f("tf-item-sel", task?.selectors?.item || "");
  f("tf-key-field", task?.selectors?.keyField || "");
  f("tf-timeout", task?.options?.timeout || 30000);
  f("tf-retries", task?.options?.retries || 3);
  f("tf-delay", task?.options?.delay || 1000);
  f("tf-cron", task?.schedule?.cron || "");
  document.getElementById("tf-schedule-enabled").checked =
    task?.schedule?.enabled || false;
  document.getElementById("tf-proxy-enabled").checked =
    task?.proxy?.enabled || false;
  document.getElementById("tf-crawl-enabled").checked =
    task?.options?.crawl?.enabled || false;
  document.getElementById("tf-crawl-options").style.display = task?.options
    ?.crawl?.enabled
    ? "block"
    : "none";
  f("tf-crawl-url-template", task?.options?.crawl?.urlTemplate ?? "");
  f("tf-crawl-json-path", task?.options?.crawl?.jsonPath ?? "");
  f("tf-crawl-selector", task?.options?.crawl?.selector ?? "a[href]");
  f("tf-crawl-max-depth", task?.options?.crawl?.maxDepth ?? 3);
  f("tf-crawl-max-requests", task?.options?.crawl?.maxRequests ?? 0);
  document.getElementById("tf-crawl-same-origin").checked =
    task?.options?.crawl?.sameOrigin !== false;
  document.getElementById("tf-antibot").checked =
    task?.options?.antiBot ?? true;
  document.getElementById("tf-ajax-header").checked =
    task?.options?.ajaxHeader || false;
  f("tf-json-html-field", task?.options?.jsonHtmlField || "");
  f("tf-json-path", task?.options?.jsonPath || "");
  f("tf-pagination-type", task?.pagination?.type || "next-button");
  f("tf-pagination-selector", task?.pagination?.selector || "");
  f("tf-pagination-maxpages", task?.pagination?.maxPages || 10);
  f("tf-pagination-startpage", task?.pagination?.startPage ?? 1);
  f("tf-pagination-pagestep", task?.pagination?.pageStep ?? 1);
  const _paginOffsetRow = document.getElementById("tf-pagination-offset-row");
  if (_paginOffsetRow)
    _paginOffsetRow.style.display =
      (task?.pagination?.type || "next-button") === "url-pattern" ? "" : "none";
  document.getElementById("tf-pagination-enabled").checked =
    task?.pagination?.enabled || false;
  document.getElementById("tf-subtasks-enabled").checked =
    task?.subTasks?.enabled || false;
  f("tf-subtasks-interval", task?.subTasks?.intervalMinutes ?? 60);
  f("tf-subtasks-cron", task?.subTasks?.cron || "");

  // Notification webhook
  document.getElementById("tf-notification-enabled").checked =
    task?.notification?.enabled || false;
  document.getElementById("tf-notification-options").style.display = task
    ?.notification?.enabled
    ? "block"
    : "none";
  f("tf-notification-url", task?.notification?.url || "");
  f("tf-notification-method", task?.notification?.method || "POST");
  const notifHeaders = task?.notification?.headers;
  if (notifHeaders) {
    const notifHeadersStr =
      typeof notifHeaders === "string"
        ? notifHeaders
        : JSON.stringify(notifHeaders, null, 2);
    const headersTextarea = document.getElementById("tf-notification-headers");
    if (headersTextarea) headersTextarea.value = notifHeadersStr;
  }

  // Site auth dropdown
  const siteAuthId = typeof task?.siteAuth === 'object' ? task?.siteAuth?._id : task?.siteAuth;
  populateSiteAuthDropdown(siteAuthId || null);

  // Load fields
  const fieldsMap = task?.selectors?.fields || {};
  state.fields = Object.entries(fieldsMap).map(([name, cfg]) => ({
    name,
    ...cfg,
  }));
  renderFieldRows();

  // Load requests
  state.parsedFieldNames = [];
  state.requests = (task?.requests || []).map((r) => ({
    url: r.url || "",
    method: r.method || "GET",
    bodyFormat: r.body?.format || "json",
    bodyData: r.body?.data
      ? typeof r.body.data === "string"
        ? r.body.data
        : JSON.stringify(r.body.data, null, 2)
      : "",
  }));
  renderRequestRows();

  // Load actual parsed field names from existing results (async, non-blocking)
  if (task?._id && task?.stats?.totalRecords > 0) {
    API.results.list(task._id, { limit: 1 }).then((res) => {
      const sample = res.items?.[0]?.data;
      if (sample) {
        state.parsedFieldNames = Object.keys(sample);
        renderRequestRows();
      }
    }).catch(() => {});
  }

  // Load detail fields
  f("tf-link-selector", task?.selectors?.linkSelector || "");
  const detailFieldsMap = task?.selectors?.detailFields || {};
  state.detailFields = Object.entries(detailFieldsMap).map(([name, cfg]) => ({
    name,
    ...cfg,
  }));
  renderDetailFieldRows();

  document.getElementById("task-modal").classList.add("open");
  syncSimpleScheduleControl(task?.schedule?.cron || "");

  // При зміні URL — пропонуємо профіль домену (тільки для нової задачі)
  if (!task) {
    const urlInput = document.getElementById("tf-url");
    urlInput.addEventListener("blur", function onUrlBlur() {
      urlInput.removeEventListener("blur", onUrlBlur);
      const profile = DomainProfiles.get(urlInput.value);
      if (!profile) return;
      const host = DomainProfiles.getHost(urlInput.value);
      if (
        !UI.confirm(
          `Знайдено збережений профіль для "${host}". Завантажити селектори та пагінацію?`,
        )
      )
        return;
      applyDomainProfile(profile);
    });
  }
};

const syncSimpleScheduleControl = (cron) => {
  const select = document.getElementById("tf-cron-simple");
  const minutesInput = document.getElementById("tf-cron-simple-minutes");
  if (!select || !minutesInput) return;

  const known = {
    "*/1 * * * *": "every_minute",
    "0 * * * *": "every_hour",
    "0 0 * * *": "daily_midnight",
    "0 9 * * *": "daily_9am",
    "0 9 * * 1-5": "weekdays_9am",
  };

  if (!cron) {
    select.value = "manual";
    minutesInput.style.display = "none";
    return;
  }

  const everyN = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (everyN) {
    select.value = "every_n_minutes";
    minutesInput.value = everyN[1];
    minutesInput.style.display = "block";
    return;
  }

  if (known[cron]) {
    select.value = known[cron];
    minutesInput.style.display = "none";
    return;
  }

  select.value = "manual";
  minutesInput.style.display = "none";
};

const updateCronFromSimple = () => {
  const select = document.getElementById("tf-cron-simple");
  const minutesInput = document.getElementById("tf-cron-simple-minutes");
  const cronInput = document.getElementById("tf-cron");
  if (!select || !minutesInput || !cronInput) return;

  switch (select.value) {
    case "every_minute":
      minutesInput.style.display = "none";
      cronInput.value = "*/1 * * * *";
      break;
    case "every_hour":
      minutesInput.style.display = "none";
      cronInput.value = "0 * * * *";
      break;
    case "daily_midnight":
      minutesInput.style.display = "none";
      cronInput.value = "0 0 * * *";
      break;
    case "daily_9am":
      minutesInput.style.display = "none";
      cronInput.value = "0 9 * * *";
      break;
    case "weekdays_9am":
      minutesInput.style.display = "none";
      cronInput.value = "0 9 * * 1-5";
      break;
    case "every_n_minutes":
      minutesInput.style.display = "block";
      cronInput.value = `*/${parseInt(minutesInput.value, 10) || 15} * * * *`;
      break;
    default:
      minutesInput.style.display = "none";
      break;
  }
};

const renderDetailFieldRows = () => {
  const container = document.getElementById("detail-fields-container");
  if (!container) return;
  container.innerHTML = state.detailFields
    .map(
      (f, i) => `
    <div class="field-row" data-idx="${i}">
      <input class="form-control" placeholder="назва поля" value="${escHtml(f.name || "")}" oninput="updateDetailField(${i},'name',this.value)">
      <input class="form-control" placeholder="CSS-селектор" value="${escHtml(f.selector || "")}" oninput="updateDetailField(${i},'selector',this.value)">
      <input class="form-control" placeholder="атрибут (href, src…)" value="${escHtml(f.attr || "")}" oninput="updateDetailField(${i},'attr',this.value)">
      <input class="form-control" placeholder="трансформація" value="${escHtml(Array.isArray(f.transform) ? f.transform.join(",") : f.transform || "")}" oninput="updateDetailField(${i},'transform',this.value)">
      <span></span>
      <button class="btn btn-xs btn-danger" onclick="removeDetailField(${i})">✕</button>
    </div>
  `,
    )
    .join("");
};

const syncDetailFieldsFromDOM = () => {
  document
    .querySelectorAll("#detail-fields-container .field-row")
    .forEach((row, i) => {
      if (!state.detailFields[i]) return;
      const inputs = row.querySelectorAll("input");
      state.detailFields[i].name = inputs[0]?.value ?? "";
      state.detailFields[i].selector = inputs[1]?.value ?? "";
      state.detailFields[i].attr = inputs[2]?.value ?? "";
      state.detailFields[i].transform = inputs[3]?.value ?? "";
    });
};

const updateDetailField = (i, key, val) => {
  state.detailFields[i][key] = val;
};
const removeDetailField = (i) => {
  syncDetailFieldsFromDOM();
  state.detailFields.splice(i, 1);
  renderDetailFieldRows();
};
const renderRequestRows = () => {
  const container = document.getElementById("requests-container");
  if (!container) return;
  const fieldNames = [
    ...new Set([
      ...state.fields.map((f) => f.name).filter(Boolean),
      ...(state.parsedFieldNames || []),
    ]),
  ];
  const fieldBtns = fieldNames.length
    ? `<div class="request-field-tags">${fieldNames.map((n) => `<button type="button" class="badge" style="cursor:pointer" onclick="insertRequestField(this,'${escHtml(n)}')" title="Вставити {{${escHtml(n)}}}">{{${escHtml(n)}}}</button>`).join("")}</div>`
    : "";
  container.innerHTML = state.requests
    .map(
      (r, i) => `
    <div class="request-row" data-idx="${i}">
      <div class="request-row-top">
        <select class="form-control request-method" onchange="updateRequest(${i},'method',this.value)">
          <option value="GET" ${r.method === "GET" ? "selected" : ""}>GET</option>
          <option value="POST" ${r.method === "POST" ? "selected" : ""}>POST</option>
        </select>
        <input class="form-control request-url req-focusable" placeholder="URL — можна {{поле}}" value="${escHtml(r.url || "")}"
               oninput="updateRequest(${i},'url',this.value)"
               onfocus="markReqFocus(this)">
        <button class="btn btn-xs btn-danger" onclick="removeRequest(${i})">✕</button>
      </div>
      <div class="request-row-body">
        <select class="form-control request-format" onchange="updateRequest(${i},'bodyFormat',this.value)">
          <option value="json" ${r.bodyFormat === "json" ? "selected" : ""}>JSON</option>
          <option value="form" ${r.bodyFormat === "form" ? "selected" : ""}>Form</option>
          <option value="raw" ${r.bodyFormat === "raw" ? "selected" : ""}>Raw</option>
        </select>
        <div style="flex:1;display:flex;flex-direction:column;gap:4px">
          <textarea class="form-control request-body-ta req-focusable" data-req-idx="${i}" placeholder="Тіло запиту — можна {{поле}}" rows="2"
                    oninput="updateRequest(${i},'bodyData',this.value)"
                    onfocus="markReqFocus(this)">${escHtml(r.bodyData || "")}</textarea>
          ${fieldBtns}
        </div>
      </div>
    </div>
  `,
    )
    .join("");
};

// Track which URL/body input was last focused in request rows
let _lastReqFocused = null;
const markReqFocus = (el) => { _lastReqFocused = el; };

const insertRequestField = (btn, fieldName) => {
  const row = btn.closest(".request-row");
  if (!row) return;
  const idx = parseInt(row.dataset.idx);

  // Use last focused element inside this row, fallback to body textarea
  const target = (_lastReqFocused && row.contains(_lastReqFocused))
    ? _lastReqFocused
    : row.querySelector(".request-body-ta");
  if (!target) return;

  const val = `{{${fieldName}}}`;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  target.value = target.value.slice(0, start) + val + target.value.slice(end);
  target.selectionStart = target.selectionEnd = start + val.length;

  if (!isNaN(idx)) {
    if (target.classList.contains("request-url")) state.requests[idx].url = target.value;
    else state.requests[idx].bodyData = target.value;
  }
  target.focus();
};

const addRequest = () => {
  state.requests.push({
    url: "",
    method: "GET",
    bodyFormat: "json",
    bodyData: "",
  });
  renderRequestRows();
};

const removeRequest = (i) => {
  state.requests.splice(i, 1);
  renderRequestRows();
};

const updateRequest = (i, key, val) => {
  state.requests[i][key] = val;
};

const addDetailField = () => {
  syncDetailFieldsFromDOM();
  state.detailFields.push({
    name: "",
    selector: "",
    attr: null,
    transform: null,
  });
  renderDetailFieldRows();
};

const applyDomainProfile = (profile) => {
  const f = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.value = val;
  };
  f("tf-engine", profile.engine);
  f("tf-item-sel", profile.selectors?.item);
  f("tf-key-field", profile.selectors?.keyField);
  f("tf-link-selector", profile.selectors?.linkSelector);
  f("tf-pagination-type", profile.pagination?.type);
  // Для url-pattern: беремо суфікс (?p={page}) зі збереженого патерну,
  // але підставляємо URL поточної задачі, щоб не тягнути чужу категорію
  const savedPagSel = profile.pagination?.selector;
  let paginationSelector = savedPagSel;
  if (profile.pagination?.type === "url-pattern" && savedPagSel) {
    const qIdx = savedPagSel.indexOf("?");
    const hIdx = savedPagSel.indexOf("#");
    const splitAt = qIdx !== -1 ? qIdx : hIdx;
    const taskUrl = document.getElementById("tf-url")?.value.trim();
    if (splitAt !== -1 && taskUrl) {
      paginationSelector = taskUrl + savedPagSel.substring(splitAt);
    }
  }
  f("tf-pagination-selector", paginationSelector);
  f("tf-pagination-maxpages", profile.pagination?.maxPages);
  f("tf-pagination-startpage", profile.pagination?.startPage ?? 1);
  f("tf-pagination-pagestep", profile.pagination?.pageStep ?? 1);
  document.getElementById("tf-pagination-enabled").checked =
    profile.pagination?.enabled || false;

  const fieldsMap = profile.selectors?.fields || {};
  state.fields = Object.entries(fieldsMap).map(([name, cfg]) => ({
    name,
    ...cfg,
  }));
  renderFieldRows();

  const detailFieldsMap = profile.selectors?.detailFields || {};
  state.detailFields = Object.entries(detailFieldsMap).map(([name, cfg]) => ({
    name,
    ...cfg,
  }));
  renderDetailFieldRows();

  if (profile.schedule?.cron) {
    f("tf-cron", profile.schedule.cron);
    document.getElementById("tf-schedule-enabled").checked =
      profile.schedule.enabled || false;
    syncSimpleScheduleControl(profile.schedule.cron);
  }
};

const closeTaskModal = () => {
  document.getElementById("task-modal").classList.remove("open");
  state.editingTask = null;
};

const renderFieldRows = () => {
  const container = document.getElementById("fields-container");
  container.innerHTML = state.fields
    .map(
      (f, i) => `
    <div class="field-row" data-idx="${i}">
      <input class="form-control" placeholder="назва поля" value="${escHtml(f.name || "")}"
             oninput="updateField(${i},'name',this.value)">
      <select class="form-control" name="field-type" onchange="updateField(${i},'type',this.value)">
        <option value="">тип поля</option>
        <option value="назва" ${f.type === "назва" ? "selected" : ""}>назва</option>
        <option value="опис" ${f.type === "опис" ? "selected" : ""}>опис</option>
        <option value="ціна" ${f.type === "ціна" ? "selected" : ""}>ціна</option>
        <option value="валюта" ${f.type === "валюта" ? "selected" : ""}>валюта</option>
        <option value="артикул" ${f.type === "артикул" ? "selected" : ""}>артикул</option>
        <option value="посилання на картинку" ${f.type === "посилання на картинку" ? "selected" : ""}>посилання на картинку</option>
        <option value="лінк на іншу сторінку" ${f.type === "лінк на іншу сторінку" ? "selected" : ""}>лінк на іншу сторінку</option>
        <option value="інше" ${f.type === "інше" ? "selected" : ""}>інше</option>
      </select>
      <input class="form-control" placeholder="CSS-селектор" value="${escHtml(f.selector || "")}"
             oninput="updateField(${i},'selector',this.value)">
      <input class="form-control" placeholder="атрибут (напр. href)" value="${escHtml(f.attr || "")}"
             oninput="updateField(${i},'attr',this.value)">
      <input class="form-control" placeholder="трансформація (trim, number…)" value="${escHtml(Array.isArray(f.transform) ? f.transform.join(",") : f.transform || "")}"
             oninput="updateField(${i},'transform',this.value)">
      <label style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" ${f.monitor ? "checked" : ""} onchange="updateField(${i},'monitor',this.checked)"> монітор
      </label>
      <button class="btn btn-xs btn-ghost" onclick="openSelectorPicker(${i})" title="Вибрати елемент візуально">🎯</button>
      <button class="btn btn-xs btn-danger" onclick="removeField(${i})">✕</button>
    </div>
  `,
    )
    .join("");
};

const updateField = (i, key, val) => {
  state.fields[i][key] = val;
};

const syncFieldsFromDOM = () => {
  document
    .querySelectorAll("#fields-container .field-row")
    .forEach((row, i) => {
      if (!state.fields[i]) return;
      const inputs = row.querySelectorAll("input");
      state.fields[i].name = inputs[0]?.value ?? "";
      state.fields[i].selector = inputs[1]?.value ?? "";
      state.fields[i].attr = inputs[2]?.value ?? "";
      state.fields[i].transform = inputs[3]?.value ?? "";
      // Додамо type, якщо є
      const typeInput = row.querySelector("select[name='field-type']");
      state.fields[i].type = typeInput?.value ?? "";
      const monitorInput = row.querySelector("input[type='checkbox']");
      state.fields[i].monitor = monitorInput?.checked || false;
    });
};

const removeField = (i) => {
  syncFieldsFromDOM();
  state.fields.splice(i, 1);
  renderFieldRows();
};
const addField = () => {
  syncFieldsFromDOM();
  state.fields.push({
    name: "",
    selector: "",
    attr: null,
    transform: null,
    type: "",
    monitor: false,
  });
  renderFieldRows();
};

const openSelectorPicker = (fieldIdx) => {
  const url = document.getElementById("tf-url").value.trim();
  Selector.open(url, (selector, type) => {
    state.fields[fieldIdx].selector = selector;
    if (type && !state.fields[fieldIdx].name) {
      state.fields[fieldIdx].name = type;
    }
    if (type) {
      state.fields[fieldIdx].type = type;
    }
    renderFieldRows();
  });
};

const saveTask = async () => {
  const g = (id) => document.getElementById(id)?.value?.trim();
  const gc = (id) => document.getElementById(id)?.checked;

  // Build fields object — read directly from DOM
  const fieldsObj = {};
  document.querySelectorAll("#fields-container .field-row").forEach((row) => {
    const inputs = row.querySelectorAll("input");
    const name = inputs[0]?.value.trim();
    const selector = inputs[1]?.value.trim();
    const attr = inputs[2]?.value.trim();
    const transform = inputs[3]?.value.trim();
    const typeSelect = row.querySelector("select[name='field-type']");
    const type = typeSelect?.value.trim();
    const monitorCheckbox = row.querySelector("input[type='checkbox']");
    const monitor = monitorCheckbox?.checked || false;
    if (!name || !selector) return;
    fieldsObj[name] = {
      selector,
      selectorType: "css",
      attr: attr || null,
      transform: transform
        ? transform
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      multiple: false,
      type: type || null,
      monitor,
    };
  });

  const detailFieldsObj = {};
  document
    .querySelectorAll("#detail-fields-container .field-row")
    .forEach((row) => {
      const inputs = row.querySelectorAll("input");
      const name = inputs[0]?.value.trim();
      const selector = inputs[1]?.value.trim();
      const attr = inputs[2]?.value.trim();
      const transform = inputs[3]?.value.trim();
      if (!name || !selector) return;
      detailFieldsObj[name] = {
        selector,
        selectorType: "css",
        attr: attr || null,
        transform: transform
          ? transform
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
        multiple: false,
      };
    });

  const requestsList = state.requests
    .filter((r) => r.url.trim())
    .map((r) => ({
      url: r.url.trim(),
      method: r.method,
      body: { format: r.bodyFormat, data: r.bodyData || null },
    }));

  const body = {
    name: g("tf-name"),
    url: g("tf-url"),
    engine: g("tf-engine"),
    selectors: {
      item: g("tf-item-sel"),
      fields: fieldsObj,
      linkSelector: g("tf-link-selector") || null,
      detailFields: detailFieldsObj,
      keyField: g("tf-key-field") || null,
    },
    pagination: {
      enabled: gc("tf-pagination-enabled"),
      type: g("tf-pagination-type"),
      selector: g("tf-pagination-selector"),
      maxPages: parseInt(g("tf-pagination-maxpages")) || 10,
      startPage: parseInt(g("tf-pagination-startpage")) || 0,
      pageStep: parseInt(g("tf-pagination-pagestep")) || 1,
    },
    schedule: {
      enabled: gc("tf-schedule-enabled"),
      cron: g("tf-cron"),
    },
    requests: requestsList,
    proxy: { enabled: gc("tf-proxy-enabled"), rotate: true },
    siteAuth: g("tf-site-auth") || null,
    subTasks: {
      enabled: gc("tf-subtasks-enabled"),
      intervalMinutes: parseInt(g("tf-subtasks-interval")) || 60,
      cron: g("tf-subtasks-cron") || null,
    },
    options: {
      timeout: parseInt(g("tf-timeout")) || 30000,
      retries: parseInt(g("tf-retries")) || 3,
      delay: parseInt(g("tf-delay")) || 1000,
      antiBot: gc("tf-antibot"),
      crawl: {
        enabled: gc("tf-crawl-enabled"),
        urlTemplate: g("tf-crawl-url-template") || null,
        jsonPath: g("tf-crawl-json-path") || null,
        selector: g("tf-crawl-selector") || "a[href]",
        maxDepth: parseInt(g("tf-crawl-max-depth")) || 0,
        maxRequests: parseInt(g("tf-crawl-max-requests")) || 0,
        sameOrigin: gc("tf-crawl-same-origin"),
      },
      ajaxHeader: gc("tf-ajax-header"),
      jsonHtmlField: g("tf-json-html-field") || null,
      jsonPath: g("tf-json-path") || null,
    },
  };

  // Webhook notification
  const notificationEnabled = gc("tf-notification-enabled");
  if (notificationEnabled) {
    const notifUrl = g("tf-notification-url");
    const notifMethod = g("tf-notification-method");
    const notifHeadersStr = document
      .getElementById("tf-notification-headers")
      ?.value?.trim();

    let notifHeaders = {};
    if (notifHeadersStr) {
      try {
        notifHeaders = JSON.parse(notifHeadersStr);
      } catch (e) {
        UI.toast("Помилка у JSON заголовків вебхука", "error");
        return;
      }
    }

    body.notification = {
      enabled: true,
      url: notifUrl || null,
      method: notifMethod || "POST",
      headers: notifHeaders,
    };
  } else {
    body.notification = {
      enabled: false,
      url: null,
      method: "POST",
      headers: {},
    };
  }

  const btn = document.getElementById("btn-save-task");
  UI.loading(btn, true);
  try {
    if (state.editingTask) {
      await API.tasks.update(state.editingTask._id, body);
      UI.toast("Задачу оновлено!", "success");
    } else {
      await API.tasks.create(body);
      UI.toast("Задачу створено!", "success");
    }
    DomainProfiles.remember(body.url, {
      selectors: body.selectors,
      pagination: body.pagination,
      engine: body.engine,
      schedule: body.schedule,
    });
    closeTaskModal();
    loadTasks();
  } catch (err) {
    UI.toast(err.message, "error");
  } finally {
    UI.loading(btn, false);
  }
};

// ── Run Log Modal ─────────────────────────────────────────────────────────
const showRunLog = async (taskId) => {
  const modal = document.getElementById("run-log-modal");
  const body = document.getElementById("run-log-body");
  body.innerHTML =
    '<div style="text-align:center;padding:20px">Завантаження...</div>';
  modal.classList.add("open");

  try {
    const { runs } = await API.tasks.runs(taskId);
    if (!runs.length) {
      body.innerHTML = '<div class="empty-state">Запусків ще немає</div>';
      return;
    }

    body.innerHTML = runs
      .map((r) => {
        const statusIcon =
          r.status === "completed" ? "✓" : r.status === "error" ? "✗" : "…";
        const statusCls =
          r.status === "completed"
            ? "success"
            : r.status === "error"
              ? "danger"
              : "warning";
        const dur = r.duration ? UI.fmtDur(r.duration) : "—";
        const pages = (r.pages || [])
          .map(
            (p) => `
        <tr style="font-size:12px">
          <td>${p.page}</td>
          <td class="code" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(p.url || "")}">${escHtml((p.url || "").slice(0, 60))}</td>
          <td>${p.method || "GET"}</td>
          <td>${p.records}</td>
          <td>${p.durationMs ? p.durationMs + "ms" : "—"}</td>
          <td>${p.status === "ok" ? '<span style="color:var(--success)">✓</span>' : p.status === "error" ? `<span style="color:var(--danger)" title="${escHtml(p.error || "")}">✗</span>` : "—"}</td>
        </tr>`,
          )
          .join("");

        return `
        <div class="card" style="margin-bottom:12px">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <span>
              <span class="badge badge-${r.status === "completed" ? "idle" : r.status}" style="margin-right:8px">${statusIcon}</span>
              ${UI.fmtDate(r.startedAt)}
            </span>
            <span style="font-size:12px;color:var(--text-2)">
              ${r.totalPages} стор. · ${r.totalRecords} записів · ${dur}
            </span>
          </div>
          ${
            pages
              ? `<div class="table-wrap" style="max-height:200px;overflow-y:auto">
            <table><thead><tr><th>#</th><th>URL</th><th>Метод</th><th>Записів</th><th>Час</th><th>Статус</th></tr></thead>
            <tbody>${pages}</tbody></table>
          </div>`
              : ""
          }
          ${r.error ? `<div style="padding:8px 16px;font-size:12px;color:var(--danger)">${escHtml(r.error)}</div>` : ""}
        </div>`;
      })
      .join("");
  } catch (err) {
    body.innerHTML = `<div class="empty-state" style="color:var(--danger)">Помилка: ${escHtml(err.message)}</div>`;
  }
};

// ── Results ───────────────────────────────────────────────────────────────
const getResultsFilters = () => {
  const runId = document.getElementById("runs-select")?.value || undefined;
  const status =
    document.getElementById("results-filter-status")?.value || undefined;
  const changed = document.getElementById("results-filter-changed")?.checked
    ? "true"
    : undefined;
  const search = document.getElementById("results-filter-search")?.value.trim();
  return { runId, status, changed, search: search || undefined };
};

const filterResultsItems = (items, search) => {
  if (!search) return items;
  const needle = search.toLowerCase();

  const matches = (value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(needle);

  const matchObject = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    return Object.values(obj).some((value) => {
      if (value && typeof value === "object") return matchObject(value);
      return matches(value);
    });
  };

  return items.filter(
    (item) =>
      matches(item.url) ||
      matches(item.detailUrl) ||
      matches(item.runId) ||
      matchObject(item.data),
  );
};

const debounce = (fn, delay = 250) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

const loadExportFieldConfig = () => {
  if (state.exportFieldConfig) return state.exportFieldConfig;
  try {
    const stored = JSON.parse(localStorage.getItem("results_export_fields") || "null");
    state.exportFieldConfig = stored || { fields: [], labels: {}, fieldTypes: {}, uniqueField: null, aggregateFields: [] };
  } catch {
    state.exportFieldConfig = { fields: [], labels: {}, fieldTypes: {}, uniqueField: null, aggregateFields: [] };
  }
  return state.exportFieldConfig;
};

const saveExportFieldConfig = (config) => {
  state.exportFieldConfig = config;
  try { localStorage.setItem("results_export_fields", JSON.stringify(config)); } catch {}
};

const openExportFieldsModal = () => {
  const config = loadExportFieldConfig();
  const fieldKeys = [
    ...new Set([
      "_url", "_page", "_detailUrl",
      ...state.results.flatMap((r) => Object.keys(r.data || {})),
    ]),
  ];
  // Delta fields = fields that actually have changes in loaded results
  const deltaFieldKeys = [...new Set(
    state.results.flatMap((r) => (r.fieldChanges || []).map((c) => c.fieldName))
  )];
  const uniqueSel = `<select class="form-control" id="ef-unique-field" style="margin-bottom:12px">
    <option value="">— не вибрано —</option>
    ${fieldKeys.map((k) => `<option value="${escHtml(k)}" ${config.uniqueField === k ? "selected" : ""}>${escHtml(k)}</option>`).join("")}
  </select>`;
  const rows = fieldKeys.map((key) => {
    const checked = !config.fields?.length || config.fields.includes(key);
    const alias = config.labels?.[key] || key;
    const ftype = config.fieldTypes?.[key] || "text";
    const isAggr = (config.aggregateFields || []).includes(key);
    return `<div class="export-field-row" data-field="${escHtml(key)}" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <input type="checkbox" ${checked ? "checked" : ""} style="flex:0 0 16px" />
      <span style="flex:0 0 160px;font-size:13px;font-weight:600">${escHtml(key)}</span>
      <input type="text" class="form-control ef-label" value="${escHtml(alias)}" placeholder="${escHtml(key)}" style="flex:1;min-width:80px" />
      <select class="form-control ef-type" style="flex:0 0 90px">
        <option value="text" ${ftype === "text" ? "selected" : ""}>Текст</option>
        <option value="numeric" ${ftype === "numeric" ? "selected" : ""}>Число</option>
      </select>
      <label style="flex:0 0 80px;font-size:12px;display:flex;align-items:center;gap:4px">
        <input type="checkbox" class="ef-aggr" ${isAggr ? "checked" : ""} /> Сума
      </label>
    </div>`;
  }).join("");
  const isDelta = config.mode === "delta";
  const deltaFieldChecks = deltaFieldKeys.map((f) => {
    const checked = !config.deltaFields?.length || config.deltaFields.includes(f);
    return `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:4px">
      <input type="checkbox" class="ef-delta-field" value="${escHtml(f)}" ${checked ? "checked" : ""}/>
      ${escHtml(f)}
    </label>`;
  }).join("") || "<span style='color:#888;font-size:12px'>Немає змін у завантажених результатах</span>";

  document.getElementById("export-fields-list").innerHTML =
    `<div style="margin-bottom:8px"><label style="font-size:12px;font-weight:600">Унікальне поле (дедуплікація):</label>${uniqueSel}</div>
     <div style="display:flex;gap:6px;font-size:11px;font-weight:600;margin-bottom:4px;padding:0 2px">
       <span style="flex:0 0 16px"></span><span style="flex:0 0 160px">Поле</span>
       <span style="flex:1">Мітка</span><span style="flex:0 0 90px">Тип</span><span style="flex:0 0 80px">Агрег.</span>
     </div>${rows}
     <hr style="margin:12px 0"/>
     <div style="margin-bottom:8px">
       <label style="font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px">
         <input type="checkbox" id="ef-delta-mode" ${isDelta ? "checked" : ""}/>
         Delta-режим — розрахунок змін по полях
       </label>
     </div>
     <div id="ef-delta-section" style="display:${isDelta ? "block" : "none"};background:#f8f9ff;border-radius:6px;padding:10px;margin-bottom:8px">
       <div style="display:flex;gap:10px;margin-bottom:8px">
         <label style="flex:1;font-size:12px">Від<input type="date" id="ef-date-from" class="form-control" value="${escHtml(config.dateFrom||"")}" /></label>
         <label style="flex:1;font-size:12px">До<input type="date" id="ef-date-to" class="form-control" value="${escHtml(config.dateTo||"")}" /></label>
       </div>
       <div style="font-size:12px;font-weight:600;margin-bottom:6px">Поля для delta:</div>
       ${deltaFieldChecks}
     </div>`;

  document.getElementById("ef-delta-mode")?.addEventListener("change", (e) => {
    document.getElementById("ef-delta-section").style.display = e.target.checked ? "block" : "none";
  });
  document.getElementById("export-fields-modal").classList.add("open");
};

const applyExportFieldConfig = () => {
  const rows = Array.from(document.querySelectorAll("#export-fields-list .export-field-row"));
  const selected = [], labels = {}, fieldTypes = {}, aggregateFields = [];
  rows.forEach((row) => {
    const key = row.dataset.field;
    if (!key) return;
    const cb = row.querySelector("input[type='checkbox']");
    const labelInput = row.querySelector(".ef-label");
    const typeSelect = row.querySelector(".ef-type");
    const aggrCb = row.querySelector(".ef-aggr");
    if (cb?.checked) selected.push(key);
    const alias = labelInput?.value.trim();
    if (alias && alias !== key) labels[key] = alias;
    if (typeSelect?.value && typeSelect.value !== "text") fieldTypes[key] = typeSelect.value;
    if (aggrCb?.checked) aggregateFields.push(key);
  });
  const fieldKeys = rows.map((r) => r.dataset.field).filter(Boolean);
  if (!selected.length) selected.push(...fieldKeys);
  const uniqueField = document.getElementById("ef-unique-field")?.value || null;
  const isDelta = document.getElementById("ef-delta-mode")?.checked || false;
  const deltaFields = isDelta
    ? [...document.querySelectorAll(".ef-delta-field:checked")].map((cb) => cb.value)
    : [];
  const dateFrom = document.getElementById("ef-date-from")?.value || null;
  const dateTo = document.getElementById("ef-date-to")?.value || null;
  saveExportFieldConfig({ fields: selected, labels, fieldTypes, uniqueField: uniqueField || null, aggregateFields,
    mode: isDelta ? "delta" : null, deltaFields, dateFrom, dateTo });
  UI.toast("Налаштування полів збережено", "success");
  document.getElementById("export-fields-modal").classList.remove("open");
};

const getExportParams = () => {
  const config = loadExportFieldConfig();
  const params = {};
  if (config.fields?.length) params.fields = config.fields;
  const labels = Object.fromEntries(Object.entries(config.labels || {}).filter(([k, v]) => v && v !== k));
  if (Object.keys(labels).length) params.fieldLabels = JSON.stringify(labels);
  if (config.fieldTypes && Object.keys(config.fieldTypes).length) params.fieldTypes = JSON.stringify(config.fieldTypes);
  if (config.uniqueField) params.uniqueField = config.uniqueField;
  if (config.aggregateFields?.length) params.aggregateFields = config.aggregateFields;
  if (config.mode) params.mode = config.mode;
  if (config.deltaFields?.length) params.deltaFields = config.deltaFields;
  if (config.dateFrom) params.dateFrom = config.dateFrom;
  if (config.dateTo) params.dateTo = config.dateTo;
  const filters = getResultsFilters();
  if (filters.status) params.status = filters.status;
  if (filters.changed) params.changed = filters.changed;
  if (filters.search) params.search = filters.search;
  if (filters.runId) params.runId = filters.runId;
  return params;
};

const deSetPeriod = (preset) => {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const from = document.getElementById("de-filter-from");
  const to = document.getElementById("de-filter-to");
  if (!from || !to) return;
  if (preset === "clear") { from.value = ""; to.value = ""; return; }
  const now = new Date();
  const toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "today") { from.value = fmt(toDate); to.value = fmt(toDate); }
  else if (preset === "week") { const f = new Date(toDate); f.setDate(f.getDate() - 6); from.value = fmt(f); to.value = fmt(toDate); }
  else if (preset === "month") { const f = new Date(toDate); f.setDate(f.getDate() - 29); from.value = fmt(f); to.value = fmt(toDate); }
};

const _renderDomainFieldRows = (fields, savedTypes = {}, savedAggr = [], savedUnique = null) => {
  const uniqueOpts = `<option value="">— не вибрано —</option>` +
    fields.map((f) => `<option value="${escHtml(f)}" ${savedUnique === f ? "selected" : ""}>${escHtml(f)}</option>`).join("");
  const rows = fields.map((f) => {
    const ftype = savedTypes[f] || "text";
    const isAggr = savedAggr.includes(f);
    return `<div class="de-field-row" data-field="${escHtml(f)}" style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid #f0f0f0">
      <span style="flex:1;font-size:13px">${escHtml(f)}</span>
      <select class="form-control de-ftype" style="flex:0 0 100px;padding:2px 6px;font-size:12px">
        <option value="text" ${ftype==="text"?"selected":""}>Текст</option>
        <option value="numeric" ${ftype==="numeric"?"selected":""}>Число</option>
      </select>
      <label style="flex:0 0 70px;font-size:12px;display:flex;align-items:center;gap:4px;white-space:nowrap">
        <input type="checkbox" class="de-aggr-cb" ${isAggr?"checked":""}/> Сума
      </label>
    </div>`;
  }).join("");
  return { uniqueOpts, rows };
};

const openDomainExportModal = async () => {
  let modal = document.getElementById("domain-export-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "domain-export-modal";
    modal.className = "modal-overlay";
    modal.innerHTML = `<div class="modal" style="max-width:540px;max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-header"><h3>Експорт по домену</h3>
        <button onclick="document.getElementById('domain-export-modal').classList.remove('open')" class="btn-icon">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:12px;overflow-y:auto;flex:1">
        <div style="display:flex;gap:8px">
          <div style="flex:1">
            <label style="font-size:12px;font-weight:600">Домен</label>
            <select id="de-domain" class="form-control"></select>
          </div>
          <div style="flex:0 0 110px">
            <label style="font-size:12px;font-weight:600">Формат</label>
            <select id="de-format" class="form-control">
              <option value="json">JSON</option><option value="csv">CSV</option>
              <option value="excel">Excel</option><option value="txt">TXT</option>
            </select>
          </div>
        </div>
        <div id="de-tasks-info" style="font-size:12px;color:#666"></div>
        <div style="font-size:12px;font-weight:600">Унікальне поле (дедуплікація):</div>
        <select id="de-unique" class="form-control"></select>
        <div id="de-fields-section" style="display:none">
          <div style="font-size:12px;font-weight:600;margin-bottom:6px">Поля:</div>
          <div style="display:flex;gap:6px;font-size:11px;color:#888;margin-bottom:4px">
            <span style="flex:1">Назва</span><span style="flex:0 0 100px">Тип</span><span style="flex:0 0 70px">Агрег.</span>
          </div>
          <div id="de-fields-list"></div>
          <hr style="margin:12px 0"/>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:12px;font-weight:600">Фільтр за часом:</span>
            <span style="display:flex;gap:4px">
              <button type="button" class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="deSetPeriod('today')">Сьогодні</button>
              <button type="button" class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="deSetPeriod('week')">7 днів</button>
              <button type="button" class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="deSetPeriod('month')">30 днів</button>
              <button type="button" class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="deSetPeriod('clear')">✕</button>
            </span>
          </div>
          <div style="display:flex;gap:10px;margin-bottom:4px">
            <label style="flex:1;font-size:12px">Від<input type="date" id="de-filter-from" class="form-control"/></label>
            <label style="flex:1;font-size:12px">До<input type="date" id="de-filter-to" class="form-control"/></label>
          </div>
          <hr style="margin:12px 0"/>
          <label style="font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <input type="checkbox" id="de-delta-mode"/>
            Delta-режим (розрахунок змін: продажі / надходження)
          </label>
          <div id="de-delta-section" style="display:none;background:#f8f9ff;border-radius:6px;padding:10px">
            <div style="display:flex;gap:10px;margin-bottom:8px">
              <label style="flex:1;font-size:12px">Від<input type="date" id="de-date-from" class="form-control"/></label>
              <label style="flex:1;font-size:12px">До<input type="date" id="de-date-to" class="form-control"/></label>
            </div>
            <div style="font-size:12px;font-weight:600;margin-bottom:6px">Поля для delta (залиш порожнім = всі зі змінами):</div>
            <div id="de-delta-fields-list"></div>
          </div>
        </div>
        <div id="de-loading" style="display:none;text-align:center;padding:12px;color:#666">Завантаження полів...</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('domain-export-modal').classList.remove('open')">Скасувати</button>
        <button class="btn btn-primary" onclick="doDomainExport()">Завантажити</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

    document.getElementById("de-domain").addEventListener("change", async (e) => {
      const domain = e.target.value;
      if (!domain) return;
      document.getElementById("de-loading").style.display = "block";
      document.getElementById("de-fields-section").style.display = "none";
      document.getElementById("de-tasks-info").textContent = "";
      try {
        const { fields } = await API.results.getDomainFields(domain);
        document.getElementById("de-loading").style.display = "none";
        if (!fields.length) { document.getElementById("de-tasks-info").textContent = "Немає результатів для цього домену"; return; }
        const { uniqueOpts, rows } = _renderDomainFieldRows(fields);
        document.getElementById("de-unique").innerHTML = uniqueOpts;
        document.getElementById("de-fields-list").innerHTML = rows;
        document.getElementById("de-delta-fields-list").innerHTML = fields.map((f) =>
          `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:4px">
            <input type="checkbox" class="de-delta-field-cb" value="${escHtml(f)}"/> ${escHtml(f)}
          </label>`).join("");
        document.getElementById("de-fields-section").style.display = "block";
        document.getElementById("de-delta-mode").addEventListener("change", (e) => {
          document.getElementById("de-delta-section").style.display = e.target.checked ? "block" : "none";
        });
      } catch {
        document.getElementById("de-loading").style.display = "none";
        document.getElementById("de-tasks-info").textContent = "Помилка завантаження полів";
      }
    });
  }
  modal.classList.add("open");
  try {
    const { domains } = await API.results.getDomains();
    const sel = document.getElementById("de-domain");
    sel.innerHTML = `<option value="">— оберіть домен —</option>` +
      domains.map((d) => `<option value="${escHtml(d.domain)}">${escHtml(d.domain)} (${d.taskCount} задач)</option>`).join("");
    document.getElementById("de-unique").innerHTML = "<option value=''>— оберіть домен —</option>";
    document.getElementById("de-fields-list").innerHTML = "";
    document.getElementById("de-fields-section").style.display = "none";
  } catch { UI.toast("Помилка завантаження доменів", "error"); }
};

const doDomainExport = async () => {
  const domain = document.getElementById("de-domain")?.value;
  if (!domain) return UI.toast("Оберіть домен", "error");
  const fmt = document.getElementById("de-format")?.value || "json";
  const uniqueField = document.getElementById("de-unique")?.value || null;
  const fieldTypes = {}, aggregateFields = [];
  document.querySelectorAll("#de-fields-list .de-field-row").forEach((row) => {
    const f = row.dataset.field;
    const t = row.querySelector(".de-ftype")?.value;
    if (t && t !== "text") fieldTypes[f] = t;
    if (row.querySelector(".de-aggr-cb")?.checked) aggregateFields.push(f);
  });
  const isDelta = document.getElementById("de-delta-mode")?.checked;
  const deltaFields = isDelta
    ? [...document.querySelectorAll(".de-delta-field-cb:checked")].map((cb) => cb.value)
    : [];
  const dateFrom = document.getElementById("de-date-from")?.value || null;
  const dateTo = document.getElementById("de-date-to")?.value || null;
  const filterFrom = document.getElementById("de-filter-from")?.value || null;
  const filterTo = document.getElementById("de-filter-to")?.value || null;
  try {
    UI.toast("Генерую файл...", "info");
    const extra = {};
    if (uniqueField) extra.uniqueField = uniqueField;
    if (aggregateFields.length) extra.aggregateFields = aggregateFields;
    if (Object.keys(fieldTypes).length) extra.fieldTypes = JSON.stringify(fieldTypes);
    if (isDelta) { extra.mode = "delta"; if (deltaFields.length) extra.deltaFields = deltaFields; }
    if (dateFrom) extra.dateFrom = dateFrom;
    if (dateTo) extra.dateTo = dateTo;
    if (filterFrom) extra.filterFrom = filterFrom;
    if (filterTo) extra.filterTo = filterTo;
    const { blob, filename } = await API.results.exportByDomain(domain, fmt, extra);
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: filename }).click();
    URL.revokeObjectURL(url);
    document.getElementById("domain-export-modal").classList.remove("open");
  } catch (e) { UI.toast(e.message, "error"); }
};

const loadResults = async () => {
  if (!state.selectedTaskId) {
    UI.setHtml(
      "results-content-empty",
      '<div class="empty-state">Оберіть задачу у вкладці «Задачі» і натисніть «Результати»</div>',
    );
    UI.setHtml("results-thead", "");
    UI.setHtml("results-tbody", "");
    return;
  }

  try {
    const filters = getResultsFilters();
    const [resultsData, runsData, taskData] = await Promise.all([
      API.results.list(state.selectedTaskId, { limit: 100, ...filters }),
      API.results.runs(state.selectedTaskId),
      API.tasks.get(state.selectedTaskId),
    ]);

    const task = taskData.task;
    const items = resultsData.items;
    const runs = runsData.runs;
    const selectedRunId = filters.runId || "";

    state.results = items;
    const visibleItems = filterResultsItems(items, filters.search);

    document.getElementById("results-task-name").textContent = task.name;

    // Runs dropdown
    const runsOpts = runs
      .map(
        (r) =>
          `<option value="${r._id}"${
            r._id === selectedRunId ? " selected" : ""
          }>${new Date(r.createdAt).toLocaleString()} (${r.count} records)</option>`,
      )
      .join("");
    UI.setHtml(
      "runs-select",
      `<option value="">Всі запуски</option>${runsOpts}`,
    );

    renderResultsTable(visibleItems);
    UI.setHtml(
      "results-total",
      `${visibleItems.length} / ${resultsData.total} записів`,
    );

    // Load sub-tasks for this task
    loadSubTasks(state.selectedTaskId);
  } catch (err) {
    UI.toast("Не вдалося завантажити результати: " + err.message, "error");
  }
};

// ── Sub-tasks ─────────────────────────────────────────────────────────────

const loadSubTasks = async (taskId) => {
  const section = document.getElementById("subtasks-section");
  try {
    const { items } = await API.subtasks.list(taskId);
    if (!items.length) {
      section.style.display = "none";
      return;
    }

    section.style.display = "block";
    UI.setHtml("subtasks-count", `${items.length} підзадач`);
    UI.setHtml("subtasks-list", items.map(renderSubTaskRow).join(""));
  } catch {
    section.style.display = "none";
  }
};

const renderSubTaskRow = (st) => {
  const statusCls =
    st.status === "error"
      ? "danger"
      : st.status === "running"
        ? "warning"
        : "success";
  const lastParsed = st.lastParsedAt
    ? new Date(st.lastParsedAt).toLocaleString()
    : "—";
  const nextRun = st.schedule?.nextRun
    ? new Date(st.schedule.nextRun).toLocaleString()
    : "—";
  const enabled = st.schedule?.enabled;
  return `
    <div class="card" style="margin-bottom:8px;padding:12px 16px">
      <div class="flex-gap" style="align-items:flex-start;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;word-break:break-all">${escHtml(st.url)}</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:4px;display:flex;gap:16px;flex-wrap:wrap">
            <span>Статус: <span class="badge badge-${statusCls}">${st.status}</span></span>
            <span>Запусків: ${st.totalRuns} (змін: ${st.changedRuns})</span>
            <span>Останній: ${lastParsed}</span>
            <span>Наступний: ${nextRun}</span>
            <span>Інтервал: ${st.schedule?.intervalMinutes ?? 60} хв</span>
          </div>
        </div>
        <div class="flex-gap" style="flex-shrink:0;gap:6px">
          <button class="btn btn-xs btn-ghost" onclick="showSubTaskHistory('${st.parentTaskId}','${st._id}','${escHtml(st.url)}')">Історія</button>
          <button class="btn btn-xs btn-ghost" onclick="runSubTaskNow('${st.parentTaskId}','${st._id}',this)">▶ Запустити</button>
          <button class="btn btn-xs ${enabled ? "btn-ghost" : "btn-primary"}" onclick="toggleSubTask('${st.parentTaskId}','${st._id}',${!enabled},this)">${enabled ? "Пауза" : "Увімкнути"}</button>
        </div>
      </div>
    </div>`;
};

const showSubTaskHistory = async (taskId, subTaskId, url) => {
  state.currentSubTask = { taskId, subTaskId };
  document.getElementById("subtask-history-title").textContent =
    `Історія: ${url.slice(0, 60)}`;
  document.getElementById("subtask-history-body").innerHTML =
    '<div style="text-align:center;padding:20px">Завантаження…</div>';
  document.getElementById("subtask-history-modal").classList.add("open");

  try {
    const { history, totalRuns, changedRuns } = await API.subtasks.history(
      taskId,
      subTaskId,
    );
    document.getElementById("subtask-history-stats").innerHTML =
      `<span>Всього запусків: <b>${totalRuns}</b></span><span>Змін: <b>${changedRuns}</b></span>`;

    if (!history.length) {
      document.getElementById("subtask-history-body").innerHTML =
        '<div class="empty-state">Запусків ще немає</div>';
      return;
    }

    document.getElementById("subtask-history-body").innerHTML = history
      .map((h) => {
        const icon = h.error ? "✗" : h.changed ? "↑" : "=";
        const cls = h.error ? "danger" : h.changed ? "success" : "";
        const dataHtml = h.data
          ? `<pre style="font-size:11px;background:var(--bg-2);border-radius:4px;padding:8px;margin-top:6px;overflow:auto;max-height:200px">${escHtml(JSON.stringify(h.data, null, 2))}</pre>`
          : "";
        return `
        <div style="border-bottom:1px solid var(--border);padding:10px 0">
          <div class="flex-gap">
            <span class="badge badge-${cls}" style="width:20px;text-align:center">${icon}</span>
            <span style="font-size:13px">${new Date(h.parsedAt).toLocaleString()}</span>
            <span style="font-size:12px;color:var(--text-2)">${h.duration ? h.duration + " мс" : ""}</span>
            ${h.error ? `<span style="color:var(--danger);font-size:12px">${escHtml(h.error)}</span>` : ""}
            ${h.changed ? '<span style="font-size:12px;color:var(--success)">дані змінились</span>' : ""}
          </div>
          ${dataHtml}
        </div>`;
      })
      .join("");
  } catch (err) {
    document.getElementById("subtask-history-body").innerHTML =
      `<div style="color:var(--danger)">${err.message}</div>`;
  }
};

const exportSubTaskHistory = async (format) => {
  if (!state.currentSubTask.taskId || !state.currentSubTask.subTaskId) return;

  try {
    const { blob, filename } = await API.subtasks.exportHistory(
      state.currentSubTask.taskId,
      state.currentSubTask.subTaskId,
      format,
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    UI.toast(`Експортовано як ${format.toUpperCase()}`, "success");
  } catch (err) {
    UI.toast("Помилка експорту: " + err.message, "error");
  }
};

const runSubTaskNow = async (taskId, subTaskId, btn) => {
  UI.loading(btn, true);
  try {
    await API.subtasks.runNow(taskId, subTaskId);
    UI.toast("Підзадачу запущено", "success");
    loadSubTasks(taskId);
  } catch (err) {
    UI.toast(err.message, "error");
  } finally {
    UI.loading(btn, false);
  }
};

const toggleSubTask = async (taskId, subTaskId, enabled, btn) => {
  UI.loading(btn, true);
  try {
    await API.subtasks.update(taskId, subTaskId, { enabled });
    loadSubTasks(taskId);
  } catch (err) {
    UI.toast(err.message, "error");
  } finally {
    UI.loading(btn, false);
  }
};

const disableSubTask = async (taskId, subTaskId) => {
  if (!UI.confirm("Видалити цю підзадачу?")) return;
  try {
    await API.subtasks.disable(taskId, subTaskId);
    UI.toast("Підзадачу відключено", "success");
    loadSubTasks(taskId);
  } catch (err) {
    UI.toast(err.message, "error");
  }
};

// ── Live Monitor ──────────────────────────────────────────────────────────

const LiveMonitor = (() => {
  let source = null;
  let timer = null;
  let startTime = 0;
  let stats = { records: 0, pages: 0 };
  // pageKey → { el, detailsEl, records, done }
  const pages = new Map();

  const $ = (id) => document.getElementById(id);

  const open = (taskId, taskName) => {
    // Reset state
    pages.clear();
    stats = { records: 0, pages: 0, maxPages: 0, paginationEnabled: false };
    $("live-monitor-body").innerHTML = "";
    $("live-monitor-footer").innerHTML = "";
    $("live-monitor-title").textContent = taskName || "Моніторинг";
    $("live-monitor-indicator").style.background = "var(--warning)";
    $("live-monitor-modal").classList.add("open");

    // Start timer
    startTime = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - startTime) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      $("live-monitor-timer").textContent = `${mm}:${ss}`;
    }, 1000);

    // Connect SSE
    close();
    source = new EventSource(API.tasks.liveUrl(taskId));
    source.onmessage = (e) => handleEvent(JSON.parse(e.data));
    source.onerror = () => {
      setStatus("error");
      setFooter("З'єднання втрачено");
    };
  };

  const close = () => {
    source?.close();
    source = null;
  };

  const handleEvent = (ev) => {
    switch (ev.type) {
      case "connected":
        break;

      case "run:start":
        $("live-monitor-title").textContent = ev.taskName || "Моніторинг";
        stats.maxPages = ev.maxPages || 0;
        stats.paginationEnabled = !!ev.paginationEnabled;
        appendLine(
          `<span style="color:var(--text-2)">▶ Запуск  runId: ${(ev.runId || "").slice(0, 8)}…</span>`,
        );
        break;

      case "page:start": {
        const key = pageKey(ev);
        const el = appendPageRow(key, ev.method, ev.url, ev.page);
        pages.set(key, { el, detailsEl: null, records: 0, done: false });
        break;
      }

      case "page:fetch": {
        const entry = pages.get(pageKey(ev));
        if (entry) updatePageFetch(entry.el, ev.status);
        break;
      }

      case "page:done": {
        const key = pageKey(ev);
        const entry = pages.get(key);
        if (entry) {
          updatePageDone(entry.el, ev.records, ev.duration);
          entry.records = ev.records;
          entry.done = true;
        }
        stats.records += ev.records || 0;
        stats.pages++;
        updateFooter();
        break;
      }

      case "page:error": {
        const entry = pages.get(pageKey(ev));
        if (entry) updatePageError(entry.el, ev.error);
        break;
      }

      case "detail:start": {
        const pKey = pageKey(ev);
        const entry = pages.get(pKey);
        if (!entry) break;
        if (!entry.detailsEl) {
          entry.detailsEl = document.createElement("div");
          entry.detailsEl.style.cssText =
            "padding-left:20px;border-left:2px solid var(--border);margin-left:10px;margin-top:2px";
          entry.el.parentNode.insertBefore(
            entry.detailsEl,
            entry.el.nextSibling,
          );
        }
        const row = document.createElement("div");
        row.id = detailRowId(ev);
        row.style.cssText =
          "padding:2px 0;color:var(--text-2);display:flex;gap:8px;align-items:baseline";
        row.innerHTML = `<span>↳</span><span style="flex:1;word-break:break-all">${escHtml(trimUrl(ev.url))}</span><span class="badge">…</span>`;
        entry.detailsEl.appendChild(row);
        scrollBottom();
        break;
      }

      case "detail:done": {
        const row = document.getElementById(detailRowId(ev));
        if (!row) break;
        const previewStr = previewText(ev.preview);
        row.innerHTML = `
          <span>↳</span>
          <span style="flex:1;word-break:break-all">${escHtml(trimUrl(ev.url))}</span>
          <span class="badge badge-success">${ev.status}</span>
          ${previewStr ? `<span style="color:var(--text-2);font-size:11px">${escHtml(previewStr)}</span>` : ""}
          <span style="color:var(--text-2);font-size:11px">${ev.duration}ms</span>`;
        break;
      }

      case "detail:error": {
        const row = document.getElementById(detailRowId(ev));
        if (!row) break;
        row.innerHTML = `<span>↳</span><span style="flex:1;word-break:break-all">${escHtml(trimUrl(ev.url))}</span><span class="badge badge-danger">✗</span><span style="color:var(--danger);font-size:11px">${escHtml(ev.error || "")}</span>`;
        break;
      }

      case "page:pagination": {
        if (ev.reason === "next") {
          appendLine(
            `<span style="color:var(--text-2);font-size:11px">→ сторінка ${ev.currentPage + 1}: ${escHtml(trimUrl(ev.nextUrl))}</span>`,
          );
        } else if (ev.reason === "no-next") {
          appendLine(
            `<span style="color:var(--warning);font-size:11px">⊘ пагінація зупинена (кнопка «далі» не знайдена, сторінка ${ev.currentPage})</span>`,
          );
        } else if (ev.reason === "same-url") {
          appendLine(
            `<span style="color:var(--warning);font-size:11px">⊘ пагінація зупинена (URL не змінився, сторінка ${ev.currentPage})</span>`,
          );
        }
        break;
      }

      case "run:complete":
        close();
        clearInterval(timer);
        setStatus("success");
        updateFooter(ev.totalRecords, ev.pages, ev.duration);
        appendLine(
          `<span style="color:var(--success);font-weight:600">✓ Завершено — ${ev.totalRecords} записів, ${ev.pages} сторінок, ${msToSec(ev.duration)}</span>`,
        );
        break;

      case "run:error":
        close();
        clearInterval(timer);
        setStatus("error");
        appendLine(
          `<span style="color:var(--danger);font-weight:600">✗ Помилка: ${escHtml(ev.error || "")}</span>`,
        );
        break;

      case "subtask:request":
        const statusClass =
          ev.status >= 400 || ev.status === 0
            ? "badge-danger"
            : ev.status >= 300
              ? "badge-warning"
              : "badge-success";
        const statusText = ev.status === 0 ? "ERR" : ev.status;
        appendLine(
          `<span style="color:var(--text-2);font-size:11px">🔗 Підзапит: ${ev.method} ${escHtml(trimUrl(ev.url))} → <span class="badge ${statusClass}">${statusText}</span> (${ev.duration}ms)${ev.error ? ` <span style="color:var(--danger)">${escHtml(ev.error)}</span>` : ""}</span>`,
        );
        break;
    }
  };

  // ── DOM helpers ──────────────────────────────────────────────────────────

  const appendLine = (html) => {
    const d = document.createElement("div");
    d.style.cssText = "padding:3px 0;border-bottom:1px solid var(--border)";
    d.innerHTML = html;
    $("live-monitor-body").appendChild(d);
    scrollBottom();
    return d;
  };

  const appendPageRow = (key, method, url, page) => {
    const d = appendLine(`
      <div style="display:flex;gap:8px;align-items:baseline" id="${CSS.escape("page-" + key)}">
        <span style="color:var(--text-2)">[${page}]</span>
        <span class="badge">${method}</span>
        <span style="flex:1;word-break:break-all">${escHtml(trimUrl(url))}</span>
        <span class="badge" id="${CSS.escape("ps-" + key)}">⏳</span>
      </div>`);
    return d;
  };

  const updatePageFetch = (el, status) => {
    const badge =
      el.querySelector(`[id^="ps-"]`) || el.querySelector(".badge:last-child");
    if (!badge) return;
    const cls =
      status >= 400
        ? "badge-danger"
        : status >= 300
          ? "badge-warning"
          : "badge-success";
    badge.className = `badge ${cls}`;
    badge.textContent = status;
  };

  const updatePageDone = (el, records, duration) => {
    // Find the status badge (last badge in row)
    const inner = el.querySelector("div") || el;
    const span = document.createElement("span");
    span.style.cssText = "color:var(--text-2);font-size:11px;margin-left:4px";
    span.textContent = `${records} записів  ${msToSec(duration)}`;
    inner.appendChild(span);
  };

  const updatePageError = (el, error) => {
    const badge = el.querySelector(".badge:last-child");
    if (badge) {
      badge.className = "badge badge-danger";
      badge.textContent = "✗";
    }
    const span = document.createElement("span");
    span.style.cssText = "color:var(--danger);font-size:11px";
    span.textContent = error || "error";
    (el.querySelector("div") || el).appendChild(span);
  };

  const setStatus = (s) => {
    $("live-monitor-indicator").style.background =
      s === "success"
        ? "var(--success)"
        : s === "error"
          ? "var(--danger)"
          : "var(--warning)";
  };

  const setFooter = (text) => {
    $("live-monitor-footer").textContent = text;
  };

  const updateFooter = (rec, pg, dur) => {
    const pages = pg ?? stats.pages;
    const pagesStr = stats.paginationEnabled && stats.maxPages > 0
      ? `${pages} / ${stats.maxPages}`
      : `${pages}`;
    $("live-monitor-footer").innerHTML =
      `<span>Записів: <b>${rec ?? stats.records}</b></span>` +
      `<span>Сторінок: <b>${pagesStr}</b></span>` +
      (dur != null ? `<span>Час: <b>${msToSec(dur)}</b></span>` : "");
  };

  const scrollBottom = () => {
    const b = $("live-monitor-body");
    b.scrollTop = b.scrollHeight;
  };

  // ── Utilities ────────────────────────────────────────────────────────────

  const pageKey = (ev) => `${ev.runId || ""}|${ev.url}|${ev.page || 0}`;
  const detailRowId = (ev) =>
    `dr-${(ev.runId || "").slice(0, 6)}-${ev.itemIndex}`;
  const trimUrl = (url) => {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  };
  const previewText = (obj) =>
    obj
      ? Object.entries(obj)
          .slice(0, 3)
          .map(([k, v]) => `${k}: ${v}`)
          .join("  ")
      : "";
  const msToSec = (ms) => (ms != null ? (ms / 1000).toFixed(1) + "s" : "");

  return { open, close };
})();

// ── Results selection ─────────────────────────────────────────────────────
const getSelectedResultIds = () =>
  [...document.querySelectorAll(".result-select:checked")].map((cb) => cb.dataset.id);

const selectChangedResults = () => {
  document.querySelectorAll(".result-select").forEach((cb) => {
    const row = document.getElementById(`result-row-${cb.dataset.id}`);
    cb.checked = row?.classList.contains("row-changed") || false;
  });
  updateForwardSelectionInfo();
};

const updateForwardSelectionInfo = () => {
  const count = getSelectedResultIds().length;
  const info = document.getElementById("forward-selection-info");
  if (info) {
    info.textContent = count
      ? `Вибрано ${count} запис(ів) для відправки`
      : "Виберіть рядки у таблиці (або натисніть «☑ Виділити зміни»)";
    info.style.color = count ? "var(--success)" : "var(--text-2)";
  }
};

const renderResultsTable = (items) => {
  if (!items.length) {
    UI.setHtml("results-tbody", "");
    UI.setHtml("results-thead", "");
    UI.setHtml(
      "results-content-empty",
      '<div class="empty-state">Результатів ще немає — спочатку запустіть задачу</div>',
    );
    return;
  }

  UI.setHtml("results-content-empty", "");
  const keys = [...new Set(items.flatMap((r) => Object.keys(r.data || {})))];
  const hasApiResponse = items.some((r) => r.apiResponse != null);

  const selectAllCb = `<input type="checkbox" id="results-select-all" title="Виділити всі" onchange="document.querySelectorAll('.result-select').forEach(cb=>cb.checked=this.checked);updateForwardSelectionInfo()">`;
  const head = `<tr><th style="width:28px">${selectAllCb}</th><th>#</th><th>URL</th>${keys.map((k) => `<th>${escHtml(k)}</th>`).join("")}<th>Зміни</th>${hasApiResponse ? "<th>API відповідь</th>" : ""}<th></th></tr>`;

  const body = items
    .map((r, i) => {
      const changes = r.fieldChanges || [];
      const hasChanges = changes.length > 0;
      const changeTime = hasChanges ? new Date(changes[0].changedAt).toLocaleString() : null;
      const changesBadge = hasChanges
        ? `<div style="display:flex;align-items:center;gap:4px">
             <button class="btn btn-xs btn-warning" onclick="showResultChangeHistory('${r._id}')" title="${escHtml(changes.map((c) => `${c.fieldName}: ${c.oldValue} → ${c.newValue}`).join("\n"))}">↕ ${changes.length}</button>
             ${changeTime ? `<small style="color:var(--text-2);font-size:10px">${escHtml(changeTime)}</small>` : ""}
           </div>`
        : `<span style="color:var(--text-2);font-size:12px">—</span>`;

      const apiCell = hasApiResponse
        ? r.apiResponse != null
          ? `<span class="badge badge-success" title="${escHtml(JSON.stringify(r.apiResponse).slice(0, 300))}">✓ ${UI.fmtDate(r.apiSentAt)}</span>`
          : r.apiError
            ? `<span class="badge badge-danger" title="${escHtml(r.apiError)}">✗ помилка</span>`
            : `<span style="color:var(--text-2)">—</span>`
        : "";

      const rowClass = hasChanges ? "row-changed" : "";

      return `
    <tr id="result-row-${r._id}" class="${rowClass}">
      <td><input type="checkbox" class="result-select" data-id="${r._id}" onchange="updateForwardSelectionInfo()"></td>
      <td>${i + 1}</td>
      <td><small class="code" title="${escHtml(r.url || "")}">${escHtml((r.url || "").slice(0, 38))}</small></td>
      ${keys.map((k) => `<td>${escHtml(String(r.data?.[k] ?? "—"))}</td>`).join("")}
      <td>${changesBadge}</td>
      ${hasApiResponse ? `<td>${apiCell}</td>` : ""}
      <td><button class="btn btn-xs btn-danger" onclick="deleteResult('${r._id}')">✕</button></td>
    </tr>`;
    })
    .join("");

  UI.setHtml("results-thead", head);
  UI.setHtml("results-tbody", body);
};

// ── Forward to external API ───────────────────────────────────────────────

const openForwardApiModal = () => {
  const ids = getSelectedResultIds();
  const modal = document.getElementById("forward-api-modal");

  // Populate field tag pills from current results
  const fieldNames = [...new Set(state.results.flatMap((r) => Object.keys(r.data || {})))];
  const tagContainer = document.getElementById("fwd-field-tags");
  if (tagContainer) {
    tagContainer.innerHTML = fieldNames
      .map((n) => `<button type="button" class="badge" style="cursor:pointer" onclick="insertFwdField('${escHtml(n)}')" title="Вставити {{${escHtml(n)}}}">{{${escHtml(n)}}}</button>`)
      .join("");
  }

  updateForwardSelectionInfo();
  document.getElementById("fwd-result-summary").style.display = "none";
  modal?.classList.add("open");
};

const insertFwdField = (fieldName) => {
  const ta = document.getElementById("fwd-body-template");
  if (!ta) return;
  const val = `{{${fieldName}}}`;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + val + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + val.length;
  ta.focus();
};

const doForwardToApi = async () => {
  const resultIds = getSelectedResultIds();
  if (!resultIds.length) {
    UI.toast("Виберіть хоча б один запис", "warning");
    return;
  }

  const apiUrl = document.getElementById("fwd-url")?.value.trim();
  if (!apiUrl) { UI.toast("Введіть URL API", "warning"); return; }

  const method = document.getElementById("fwd-method")?.value || "POST";
  const bodyTemplate = document.getElementById("fwd-body-template")?.value.trim() || null;
  let headers = {};
  const headersStr = document.getElementById("fwd-headers")?.value.trim();
  if (headersStr) {
    try { headers = JSON.parse(headersStr); }
    catch { UI.toast("Помилка у JSON заголовків", "error"); return; }
  }

  const btn = document.getElementById("btn-do-forward");
  UI.loading(btn, true);
  const summary = document.getElementById("fwd-result-summary");
  if (summary) { summary.style.display = "none"; }

  try {
    const data = await API.results.forward(state.selectedTaskId, {
      resultIds, apiUrl, method, headers, bodyTemplate,
    });
    const cls = data.failed ? "warning" : "success";
    if (summary) {
      summary.style.display = "block";
      summary.className = `badge-${cls}`;
      summary.style.cssText = `display:block;padding:8px 12px;border-radius:6px;font-size:13px;background:${data.failed ? "#fef3c7" : "#dcfce7"};color:${data.failed ? "#92400e" : "#166534"}`;
      summary.textContent = `✓ Відправлено: ${data.sent}, помилок: ${data.failed}`;
    }
    UI.toast(`Відправлено ${data.sent} з ${resultIds.length}`, data.failed ? "warning" : "success");
    // Reload results to show apiResponse column
    await loadResults();
  } catch (err) {
    UI.toast("Помилка: " + err.message, "error");
  } finally {
    UI.loading(btn, false);
  }
};

const showResultChangeHistory = (resultId) => {
  const result = state.results.find((r) => r._id === resultId);
  if (!result) {
    return UI.toast("Результат не знайдено", "error");
  }

  const changes = result.fieldChanges || [];
  const body = document.getElementById("result-change-history-body");
  document.getElementById("result-change-history-title").textContent =
    `Історія змін — ${result.url?.slice(0, 80) || result._id}`;
  if (!body) return;

  if (!changes.length) {
    body.innerHTML = '<div class="empty-state">Змін немає</div>';
  } else {
    body.innerHTML = changes
      .map((change) => {
        const date = change.changedAt
          ? new Date(change.changedAt).toLocaleString()
          : "—";
        return `
          <div style="border-bottom:1px solid var(--border);padding:10px 0">
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
              <strong>${escHtml(change.fieldName)}</strong>
              <span style="color:var(--text-2);font-size:12px">${escHtml(date)}</span>
            </div>
            <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap">
              <div style="flex:1;min-width:140px">
                <div style="font-size:12px;color:var(--text-2)">Було</div>
                <div>${escHtml(String(change.oldValue ?? ""))}</div>
              </div>
              <div style="flex:1;min-width:140px">
                <div style="font-size:12px;color:var(--text-2)">Стало</div>
                <div>${escHtml(String(change.newValue ?? ""))}</div>
              </div>
            </div>
          </div>`;
      })
      .join("");
  }

  document.getElementById("result-change-history-modal").classList.add("open");
};

const deleteResult = async (resultId) => {
  if (!UI.confirm("Видалити цей запис?")) return;
  try {
    await API.results.deleteOne(state.selectedTaskId, resultId);
    document.getElementById(`result-row-${resultId}`)?.remove();
    const total = document.getElementById("results-total");
    if (total) {
      const n = parseInt(total.textContent) - 1;
      total.textContent = `${n} записів`;
    }
  } catch (err) {
    UI.toast(err.message, "error");
  }
};

const deleteAllResults = async () => {
  if (!state.selectedTaskId) return;
  const runId = document.getElementById("runs-select")?.value || undefined;
  const msg = runId
    ? "Видалити всі результати цього запуску?"
    : "Видалити ВСІ результати цієї задачі?";
  if (!UI.confirm(msg)) return;
  try {
    await API.results.delete(state.selectedTaskId, runId ? { runId } : {});
    UI.toast("Результати видалено", "success");
    loadResults();
  } catch (err) {
    UI.toast(err.message, "error");
  }
};

// ── Proxies ───────────────────────────────────────────────────────────────
const loadProxies = async () => {
  try {
    const [data, statsData] = await Promise.all([
      API.proxies.list({ page: state.proxyPage, limit: 100 }),
      API.proxies.stats(),
    ]);

    state.proxies = data.items;
    renderProxiesTable(data);

    const s = statsData;
    UI.setHtml("proxy-stat-total", s.total || 0);
    UI.setHtml("proxy-stat-active", s.byStatus?.active || 0);
    UI.setHtml("proxy-stat-banned", s.byStatus?.banned || 0);
    UI.setHtml("proxy-stat-avgtime", (s.avgResponseTime || 0) + "ms");
  } catch (err) {
    UI.toast("Не вдалося завантажити проксі: " + err.message, "error");
  }
};

const renderProxiesTable = ({ items, total, page, pages }) => {
  const rows = items
    .map(
      (p) => `
    <tr>
      <td><code>${p.protocol.toUpperCase()}://${p.host}:${p.port}</code></td>
      <td><strong>${p.country ? p.country : "—"}</strong></td>
      <td><span style="color:${p.responseTime < 1000 ? "#22c55e" : p.responseTime < 5000 ? "#eab308" : "#ef4444"}">${p.responseTime ? p.responseTime + "ms" : "—"}</span></td>
      <td>${UI.badge(p.status)}</td>
      <td style="font-size:12px;color:#94a3b8">${p.useCount || 0}</td>
      <td style="font-size:12px;color:#94a3b8">${p.failCount || 0}</td>
      <td style="font-size:11px;color:#94a3b8">${UI.fmtDate(p.lastChecked)}</td>
      <td>
        <div class="flex-gap">
          <button class="btn btn-xs btn-primary" onclick="checkProxy('${p._id}')" title="Перевірити">✓</button>
          <button class="btn btn-xs btn-danger" onclick="deleteProxy('${p._id}')">✕</button>
        </div>
      </td>
    </tr>
  `,
    )
    .join("");

  UI.setHtml(
    "proxies-tbody",
    rows ||
      '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:40px">Проксі відсутні. Імпортуйте, щоб розпочати.</td></tr>',
  );
  UI.setHtml("proxies-count", `${total} проксі`);
  renderPagination("proxies-pagination", page, pages, (p) => {
    state.proxyPage = p;
    loadProxies();
  });
};

const checkProxy = async (id) => {
  const btn = event?.target;
  if (btn) UI.loading(btn, true);
  try {
    const result = await API.proxies.check(id);
    if (result.ok) {
      const details = `Час: ${result.responseTime}ms${result.ip ? ` | IP: ${result.ip}` : ""}${result.country ? ` | ${result.country}` : ""}`;
      UI.toast(`✓ Проксі OK | ${details}`, "success");
    } else {
      UI.toast(`✗ ${result.error}`, "error");
    }
    loadProxies();
  } catch (err) {
    UI.toast(err.message, "error");
  } finally {
    if (btn) UI.loading(btn, false);
  }
};

const deleteProxy = async (id) => {
  if (!UI.confirm("Видалити цей проксі?")) return;
  try {
    await API.proxies.delete(id);
    UI.toast("Проксі видалено", "success");
    loadProxies();
  } catch (err) {
    UI.toast(err.message, "error");
  }
};

const importProxies = async () => {
  const text = document.getElementById("proxy-import-text").value.trim();
  const protocol = document.getElementById("proxy-import-protocol").value;
  const username = document
    .getElementById("proxy-import-username")
    .value.trim();
  const password = document
    .getElementById("proxy-import-password")
    .value.trim();

  if (!text) return UI.toast("Введіть список проксі", "warning");

  const btn = document.getElementById("btn-import-proxies");
  UI.loading(btn, true);
  try {
    const result = await API.proxies.import({
      text,
      protocol,
      username,
      password,
    });
    UI.toast(`Імпортовано ${result.imported} проксі`, "success");
    document.getElementById("proxy-modal").classList.remove("open");
    loadProxies();
  } catch (err) {
    UI.toast(err.message, "error");
  } finally {
    UI.loading(btn, false);
  }
};

// ── Pagination helper ─────────────────────────────────────────────────────
const renderPagination = (containerId, page, pages, onPage) => {
  const el = document.getElementById(containerId);
  if (!el || pages <= 1) {
    if (el) el.innerHTML = "";
    return;
  }

  el.innerHTML = `
    <button onclick="(${onPage})(${page - 1})" ${page <= 1 ? "disabled" : ""}>‹ Попередня</button>
    <span class="current">${page} / ${pages}</span>
    <button onclick="(${onPage})(${page + 1})" ${page >= pages ? "disabled" : ""}>Наступна ›</button>
  `;
};

// ── Tabs ──────────────────────────────────────────────────────────────────
const initTabs = () => {
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const group = tab.closest("[data-tabs]") || tab.parentElement;
      const panes =
        tab.closest(".tab-container") ||
        document.querySelector(`[data-panes="${tab.dataset.tabGroup}"]`);

      group
        .querySelectorAll("[data-tab]")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      document.querySelectorAll(`[data-pane]`).forEach((p) => {
        if (p.dataset.tabGroup === tab.dataset.tabGroup) {
          p.classList.toggle("active", p.dataset.pane === tab.dataset.tab);
        }
      });
    });
  });
};

// ── Site Auths ────────────────────────────────────────────────────────────

let _siteAuths = []; // cached list for dropdowns
let _editingSiteAuth = null;
let _saExtraFields = []; // extra form fields list

const loadSiteAuths = async () => {
  try {
    const { items } = await API.siteAuths.list();
    _siteAuths = items || [];
    renderSiteAuthsTable();
  } catch (err) {
    UI.toast("Помилка завантаження авторизацій: " + err.message, "error");
  }
};

const renderSiteAuthsTable = () => {
  const statusLabel = { pending: "Очікує", active: "Активна", error: "Помилка" };
  const statusClass = { pending: "badge-idle", active: "badge-running", error: "badge-error" };
  const typeLabel = { form: "Авто (форма)", manual: "Ручні cookie" };

  const rows = _siteAuths.map((a) => `
    <tr>
      <td><strong>${escHtml(a.name)}</strong></td>
      <td style="font-size:12px;color:var(--text-2)">${escHtml(a.loginUrl)}</td>
      <td>${escHtml(typeLabel[a.type] || a.type)}</td>
      <td><span class="badge ${statusClass[a.status] || 'badge-idle'}">${statusLabel[a.status] || a.status}</span></td>
      <td style="font-size:12px">${a.cookiesUpdatedAt ? UI.fmtDate(a.cookiesUpdatedAt) : "—"}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-xs btn-ghost" onclick="editSiteAuth('${a._id}')">Редагувати</button>
          ${a.type === 'form' ? `<button class="btn btn-xs btn-primary" onclick="runSiteAuth('${a._id}')">↻ Авторизація</button>` : ''}
          <button class="btn btn-xs btn-danger" onclick="deleteSiteAuth('${a._id}')">Видалити</button>
        </div>
      </td>
    </tr>
  `).join('');

  UI.setHtml('site-auths-tbody', rows || '<tr><td colspan="6" style="text-align:center;color:var(--text-2)">Авторизацій ще немає</td></tr>');
};

const openSiteAuthModal = (auth = null) => {
  _editingSiteAuth = auth;
  _saExtraFields = auth?.formConfig?.extraFields ? [...auth.formConfig.extraFields] : [];

  document.getElementById('site-auth-modal-title').textContent = auth ? 'Редагувати авторизацію' : 'Нова авторизація';
  document.getElementById('sa-name').value = auth?.name || '';
  document.getElementById('sa-type').value = auth?.type || 'form';
  document.getElementById('sa-login-url').value = auth?.loginUrl || '';
  document.getElementById('sa-username-sel').value = auth?.formConfig?.usernameSelector || '';
  document.getElementById('sa-username-val').value = auth?.credentials?.username || '';
  document.getElementById('sa-password-sel').value = auth?.formConfig?.passwordSelector || '';
  document.getElementById('sa-password-val').value = auth?.credentials?.password || '';
  document.getElementById('sa-submit-sel').value = auth?.formConfig?.submitSelector || '';
  document.getElementById('sa-success-sel').value = auth?.formConfig?.successSelector || '';
  document.getElementById('sa-cookies-manual').value = auth?.cookies || '';

  const statusRow = document.getElementById('sa-status-row');
  const statusText = document.getElementById('sa-status-text');
  if (auth?.lastError) {
    statusRow.style.display = '';
    statusRow.style.background = 'var(--danger, #fee2e2)';
    statusText.textContent = 'Помилка: ' + auth.lastError;
  } else if (auth?.cookiesUpdatedAt) {
    statusRow.style.display = '';
    statusRow.style.background = 'var(--bg-2)';
    statusText.textContent = 'Cookies оновлено: ' + UI.fmtDate(auth.cookiesUpdatedAt);
  } else {
    statusRow.style.display = 'none';
  }

  renderSaExtraFields();
  toggleSaTypeView();
  document.getElementById('site-auth-modal').classList.add('open');
};

const toggleSaTypeView = () => {
  const type = document.getElementById('sa-type').value;
  document.getElementById('sa-form-config').style.display = type === 'form' ? '' : 'none';
  document.getElementById('sa-manual-config').style.display = type === 'manual' ? '' : 'none';
};

const renderSaExtraFields = () => {
  const container = document.getElementById('sa-extra-fields-container');
  if (!container) return;
  container.innerHTML = _saExtraFields.map((f, i) => `
    <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px;margin-bottom:6px;align-items:center">
      <input class="form-control" style="font-size:13px" value="${escHtml(f.selector)}"
        placeholder="CSS селектор" onchange="updateSaExtraField(${i},'selector',this.value)" />
      <input class="form-control" style="font-size:13px" value="${escHtml(f.value)}"
        placeholder="Значення" onchange="updateSaExtraField(${i},'value',this.value)" />
      <button class="btn btn-xs btn-danger" onclick="removeSaExtraField(${i})">✕</button>
    </div>
  `).join('');
};

const updateSaExtraField = (i, key, val) => { _saExtraFields[i][key] = val; };
const removeSaExtraField = (i) => { _saExtraFields.splice(i, 1); renderSaExtraFields(); };

const closeSiteAuthModal = () =>
  document.getElementById('site-auth-modal').classList.remove('open');

const saveSiteAuth = async () => {
  const name = document.getElementById('sa-name').value.trim();
  const loginUrl = document.getElementById('sa-login-url').value.trim();
  const type = document.getElementById('sa-type').value;
  if (!name || !loginUrl) { UI.toast('Назва та URL обовʼязкові', 'error'); return; }

  const body = {
    name, loginUrl, type,
    formConfig: {
      usernameSelector: document.getElementById('sa-username-sel').value.trim() || null,
      passwordSelector: document.getElementById('sa-password-sel').value.trim() || null,
      submitSelector:   document.getElementById('sa-submit-sel').value.trim() || null,
      successSelector:  document.getElementById('sa-success-sel').value.trim() || null,
      extraFields: _saExtraFields.filter((f) => f.selector),
    },
    credentials: {
      username: document.getElementById('sa-username-val').value || null,
      password: document.getElementById('sa-password-val').value || null,
    },
  };

  if (type === 'manual') {
    body.cookies = document.getElementById('sa-cookies-manual').value.trim() || null;
    if (body.cookies) { body.status = 'active'; body.cookiesUpdatedAt = new Date().toISOString(); }
  }

  const btn = document.getElementById('btn-save-site-auth');
  UI.loading(btn, true);
  try {
    if (_editingSiteAuth) {
      await API.siteAuths.update(_editingSiteAuth._id, body);
      UI.toast('Авторизацію оновлено', 'success');
    } else {
      await API.siteAuths.create(body);
      UI.toast('Авторизацію створено', 'success');
    }
    closeSiteAuthModal();
    await loadSiteAuths();
  } catch (err) {
    UI.toast(err.message, 'error');
  } finally {
    UI.loading(btn, false);
  }
};

const editSiteAuth = async (id) => {
  const auth = _siteAuths.find((a) => a._id === id);
  if (auth) openSiteAuthModal(auth);
};

const deleteSiteAuth = async (id) => {
  if (!UI.confirm('Видалити авторизацію?')) return;
  try {
    await API.siteAuths.delete(id);
    UI.toast('Видалено', 'success');
    await loadSiteAuths();
  } catch (err) {
    UI.toast(err.message, 'error');
  }
};

const runSiteAuth = async (id) => {
  const btn = document.querySelector(`[onclick="runSiteAuth('${id}')"]`);
  if (btn) UI.loading(btn, true);
  try {
    await API.siteAuths.authenticate(id);
    UI.toast('Авторизацію виконано! Cookies збережено.', 'success');
    await loadSiteAuths();
  } catch (err) {
    UI.toast('Помилка авторизації: ' + err.message, 'error');
  } finally {
    if (btn) UI.loading(btn, false);
  }
};

// Populate site-auth dropdown in task modal
const populateSiteAuthDropdown = async (selectedId = null) => {
  try {
    if (!_siteAuths.length) await loadSiteAuths();
    const sel = document.getElementById('tf-site-auth');
    if (!sel) return;
    const opts = _siteAuths.map((a) =>
      `<option value="${a._id}" ${a._id === selectedId ? 'selected' : ''}>${escHtml(a.name)} (${a.type === 'form' ? 'авто' : 'cookie'})</option>`
    ).join('');
    sel.innerHTML = '<option value="">— Без авторизації —</option>' + opts;
    if (selectedId) sel.value = selectedId;
  } catch { /* silently ignore */ }
};

// ── Utils ─────────────────────────────────────────────────────────────────
const escHtml = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Selector panel
  Selector.init();

  // Auth
  document.getElementById("login-form")?.addEventListener("submit", Auth.login);
  document
    .getElementById("register-form")
    ?.addEventListener("submit", Auth.register);
  document.getElementById("btn-logout")?.addEventListener("click", Auth.logout);

  // Auto-logout on token expiry (any 401 from the API)
  window.addEventListener("auth:expired", () => {
    UI.toast("Сесія завершилась — увійдіть знову", "error");
    Auth.logout();
  });

  // Nav
  document.querySelectorAll("[data-page]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.page));
  });

  // Task modal
  document
    .getElementById("btn-new-task")
    ?.addEventListener("click", () => openTaskModal());
  document
    .getElementById("btn-close-task-modal")
    ?.addEventListener("click", closeTaskModal);
  document.getElementById("btn-save-task")?.addEventListener("click", saveTask);
  document
    .getElementById("tf-cron-simple")
    ?.addEventListener("change", updateCronFromSimple);
  document
    .getElementById("tf-cron-simple-minutes")
    ?.addEventListener("input", () => {
      if (
        document.getElementById("tf-cron-simple")?.value === "every_n_minutes"
      ) {
        updateCronFromSimple();
      }
    });
  document.getElementById("tf-cron")?.addEventListener("input", () => {
    const select = document.getElementById("tf-cron-simple");
    const minutesInput = document.getElementById("tf-cron-simple-minutes");
    if (select) select.value = "manual";
    if (minutesInput) minutesInput.style.display = "none";
  });
  document
    .getElementById("btn-close-live-monitor")
    ?.addEventListener("click", () => {
      LiveMonitor.close();
      document.getElementById("live-monitor-modal").classList.remove("open");
    });
  const updatePaginationOffsetRow = () => {
    const type = document.getElementById("tf-pagination-type")?.value;
    const row = document.getElementById("tf-pagination-offset-row");
    if (row) row.style.display = type === "url-pattern" ? "" : "none";
  };
  document
    .getElementById("tf-pagination-type")
    ?.addEventListener("change", updatePaginationOffsetRow);
  updatePaginationOffsetRow();
  document
    .getElementById("tf-crawl-enabled")
    ?.addEventListener("change", (e) => {
      document.getElementById("tf-crawl-options").style.display = e.target
        .checked
        ? "block"
        : "none";
    });
  document
    .getElementById("tf-notification-enabled")
    ?.addEventListener("change", (e) => {
      document.getElementById("tf-notification-options").style.display = e
        .target.checked
        ? "block"
        : "none";
    });
  document
    .getElementById("btn-add-request")
    ?.addEventListener("click", addRequest);
  document.getElementById("btn-add-field")?.addEventListener("click", addField);
  document
    .getElementById("btn-add-detail-field")
    ?.addEventListener("click", addDetailField);
  document
    .getElementById("btn-open-selector")
    ?.addEventListener("click", () => {
      const url = document.getElementById("tf-url").value.trim();
      Selector.open(url, (sel) => {
        document.getElementById("tf-item-sel").value = sel;
      });
    });
  document.getElementById("btn-scan-fields")?.addEventListener("click", () => {
    const url = document.getElementById("tf-url").value.trim();
    const itemSel = document.getElementById("tf-item-sel").value.trim();
    if (!itemSel) {
      UI.toast("Спочатку оберіть селектор контейнера", "warning");
      return;
    }
    Selector.open(
      url,
      (fields) => {
        // fields is array of {name, selector, type}
        state.fields = fields.map((f) => ({
          name: f.name,
          selector: f.selector,
          attr: null,
          transform: null,
          type: f.type,
        }));
        renderFieldRows();
        UI.toast("Поля скановано: " + fields.length, "success");
      },
      "fields",
      itemSel,
    );
  });

  // Proxy modal
  document
    .getElementById("btn-import-proxy-open")
    ?.addEventListener("click", () => {
      document.getElementById("proxy-modal").classList.add("open");
    });
  document
    .getElementById("btn-close-proxy-modal")
    ?.addEventListener("click", () => {
      document.getElementById("proxy-modal").classList.remove("open");
    });
  document
    .getElementById("btn-import-proxies")
    ?.addEventListener("click", importProxies);
  document
    .getElementById("btn-check-all-proxies")
    ?.addEventListener("click", async () => {
      await API.proxies.checkAll();
      UI.toast("Перевірку проксі розпочато...", "info");
      // Оновлюємо таблицю кожні 3с поки відкрита сторінка проксі
      const pollInterval = setInterval(async () => {
        if (state.currentPage !== "proxies") {
          clearInterval(pollInterval);
          return;
        }
        await loadProxies();
      }, 3000);
      // Зупиняємо через 3 хвилини
      setTimeout(() => clearInterval(pollInterval), 3 * 60 * 1000);
    });

  // Results run selector
  document
    .getElementById("runs-select")
    ?.addEventListener("change", async () => {
      if (!state.selectedTaskId) return;
      await loadResults();
    });

  document.getElementById("results-filter-search")?.addEventListener(
    "input",
    debounce(() => loadResults(), 300),
  );
  document
    .getElementById("results-filter-status")
    ?.addEventListener("change", () => loadResults());
  document
    .getElementById("results-filter-changed")
    ?.addEventListener("change", () => loadResults());
  document
    .getElementById("btn-open-export-fields")
    ?.addEventListener("click", (e) => {
      e.preventDefault(); closeExportMenu();
      openExportFieldsModal();
    });
  document
    .getElementById("btn-reset-results-filters")
    ?.addEventListener("click", () => {
      const search = document.getElementById("results-filter-search");
      const status = document.getElementById("results-filter-status");
      const changed = document.getElementById("results-filter-changed");
      if (search) search.value = "";
      if (status) status.value = "";
      if (changed) changed.checked = false;
      loadResults();
    });

  // Export dropdown toggle
  document.getElementById("btn-export-dropdown")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = document.getElementById("export-menu");
    if (menu) menu.classList.toggle("open");
  });
  document.addEventListener("click", () => {
    document.getElementById("export-menu")?.classList.remove("open");
  });

  document.getElementById("btn-domain-export")?.addEventListener("click", () => {
    document.getElementById("export-menu")?.classList.remove("open");
    openDomainExportModal();
  });
  document.getElementById("btn-forward-api")?.addEventListener("click", openForwardApiModal);
  document.getElementById("btn-select-changed")?.addEventListener("click", selectChangedResults);
  document.getElementById("btn-close-forward-modal")?.addEventListener("click", () =>
    document.getElementById("forward-api-modal")?.classList.remove("open"));
  document.getElementById("btn-close-forward-modal-2")?.addEventListener("click", () =>
    document.getElementById("forward-api-modal")?.classList.remove("open"));
  document.getElementById("btn-do-forward")?.addEventListener("click", doForwardToApi);

  document.getElementById("btn-open-analytics")?.addEventListener("click", () => {
    const sec = document.getElementById("analytics-section");
    if (!sec) return;
    if (sec.style.display === "none") {
      sec.style.display = "";
      loadAnalytics();
    } else {
      sec.style.display = "none";
    }
  });

  document.getElementById("btn-open-search")?.addEventListener("click", () => {
    const sec = document.getElementById("search-section");
    if (!sec) return;
    sec.style.display = sec.style.display === "none" ? "" : "none";
  });

  document.getElementById("search-field")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchByField();
  });
  document.getElementById("search-value")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchByField();
  });
  document.getElementById("analytics-days")?.addEventListener("change", loadAnalytics);

  const closeExportMenu = () => document.getElementById("export-menu")?.classList.remove("open");
  // Export buttons
  document.getElementById("btn-export-json")?.addEventListener("click", (e) => {
    e.preventDefault(); closeExportMenu();
    triggerExportDownload("json");
  });
  document.getElementById("btn-export-csv")?.addEventListener("click", (e) => {
    e.preventDefault(); closeExportMenu();
    triggerExportDownload("csv");
  });
  document
    .getElementById("btn-export-excel")
    ?.addEventListener("click", (e) => {
      e.preventDefault(); closeExportMenu();
      triggerExportDownload("excel");
    });
  const TXT_KEY = "txt_export_settings";
  const loadTxtSettings = () => {
    try {
      const s = JSON.parse(localStorage.getItem(TXT_KEY) || "{}");
      if (s.template !== undefined)
        document.getElementById("txt-template").value = s.template;
      if (s.fieldSep !== undefined)
        document.getElementById("txt-field-sep").value = s.fieldSep;
      if (s.recordSep !== undefined)
        document.getElementById("txt-record-sep").value = s.recordSep;
      if (s.includeHeader !== undefined)
        document.getElementById("txt-include-header").checked = s.includeHeader;
    } catch {}
  };
  const saveTxtSettings = () => {
    try {
      localStorage.setItem(
        TXT_KEY,
        JSON.stringify({
          template: document.getElementById("txt-template").value,
          fieldSep: document.getElementById("txt-field-sep").value,
          recordSep: document.getElementById("txt-record-sep").value,
          includeHeader: document.getElementById("txt-include-header").checked,
        }),
      );
    } catch {}
  };
  document.getElementById("btn-export-txt")?.addEventListener("click", (e) => {
    e.preventDefault(); closeExportMenu();
    loadTxtSettings();
    document.getElementById("txt-export-modal").classList.add("open");
  });
  const closeTxtModal = () =>
    document.getElementById("txt-export-modal").classList.remove("open");
  document
    .getElementById("btn-close-txt-modal")
    ?.addEventListener("click", closeTxtModal);
  document
    .getElementById("btn-close-txt-modal-2")
    ?.addEventListener("click", closeTxtModal);
  document
    .getElementById("btn-close-export-fields-modal")
    ?.addEventListener("click", () => {
      document.getElementById("export-fields-modal").classList.remove("open");
    });
  document
    .getElementById("btn-close-export-fields-modal-2")
    ?.addEventListener("click", () => {
      document.getElementById("export-fields-modal").classList.remove("open");
    });
  document
    .getElementById("btn-save-export-fields")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      applyExportFieldConfig();
    });
  document
    .getElementById("btn-do-export-txt")
    ?.addEventListener("click", async () => {
      if (!state.selectedTaskId) return;
      saveTxtSettings();
      const template = document.getElementById("txt-template").value;
      const fieldSep = document.getElementById("txt-field-sep").value;
      const recordSep = document.getElementById("txt-record-sep").value;
      const includeHeader =
        document.getElementById("txt-include-header").checked;
      const runId = document.getElementById("runs-select")?.value || undefined;
      const btn = document.getElementById("btn-do-export-txt");
      UI.loading(btn, true);
      try {
        const exportParams = {
          ...getExportParams(),
          fieldSep,
          recordSep,
          template: template || undefined,
          includeHeader: String(includeHeader),
        };
        const { blob, filename } = await API.results.exportFile(
          state.selectedTaskId,
          "txt",
          undefined,
          exportParams,
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        closeTxtModal();
      } catch (err) {
        UI.toast("Помилка TXT експорту: " + err.message, "error");
      } finally {
        UI.loading(btn, false);
      }
    });

  // Site auths page + modal
  document.getElementById('btn-new-site-auth')?.addEventListener('click', () => openSiteAuthModal());
  document.getElementById('btn-close-site-auth-modal')?.addEventListener('click', closeSiteAuthModal);
  document.getElementById('btn-cancel-site-auth-modal')?.addEventListener('click', closeSiteAuthModal);
  document.getElementById('btn-save-site-auth')?.addEventListener('click', saveSiteAuth);
  document.getElementById('sa-type')?.addEventListener('change', toggleSaTypeView);
  document.getElementById('btn-add-sa-extra-field')?.addEventListener('click', () => {
    _saExtraFields.push({ selector: '', value: '' });
    renderSaExtraFields();
  });

  // Tabs
  initTabs();

  // Check auth and navigate
  await Auth.init();
  if (API.getToken()) navigate("dashboard");

  // Auto-refresh dashboard every 30s
  setInterval(() => {
    if (state.currentPage === "dashboard") loadDashboard();
    if (state.currentPage === "tasks") loadTasks();
  }, 30000);
});

// ── Analytics ─────────────────────────────────────────────────────────────
let _analyticsChart = null;

const loadAnalytics = async () => {
  const taskId = state.selectedTaskId;
  if (!taskId) return;
  const days = parseInt(document.getElementById("analytics-days")?.value || "7");
  const cardsEl = document.getElementById("analytics-stat-cards");
  const canvasEl = document.getElementById("analytics-chart");
  if (!cardsEl || !canvasEl) return;

  cardsEl.innerHTML = '<span style="color:var(--text-2);font-size:13px">Завантаження...</span>';

  try {
    const data = await API.analytics.get(taskId, { days });
    const fields = data.fields || {};
    const labels = data.labels || [];

    // Stat cards
    cardsEl.innerHTML = "";
    const fieldNames = Object.keys(fields);
    if (!fieldNames.length) {
      cardsEl.innerHTML = '<span style="color:var(--text-2);font-size:13px">Немає даних про зміни за цей період</span>';
    }
    for (const fname of fieldNames) {
      const s = fields[fname];
      const card = document.createElement("div");
      card.style.cssText = "background:var(--surface-2,#f5f5f5);border-radius:8px;padding:12px 18px;min-width:160px;flex:1 1 160px;";
      card.innerHTML = `
        <div style="font-size:11px;color:var(--text-2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">${fname}</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div><div style="font-size:20px;font-weight:700">${s.total}</div><div style="font-size:11px;color:var(--text-2)">змін</div></div>
          ${s.sold > 0 ? `<div><div style="font-size:20px;font-weight:700;color:#e05">${s.sold}</div><div style="font-size:11px;color:var(--text-2)">продажі</div></div>` : ""}
          ${s.restock > 0 ? `<div><div style="font-size:20px;font-weight:700;color:#0a0">${s.restock}</div><div style="font-size:11px;color:var(--text-2)">надходження</div></div>` : ""}
        </div>`;
      cardsEl.appendChild(card);
    }

    // Chart
    if (_analyticsChart) { _analyticsChart.destroy(); _analyticsChart = null; }
    if (!fieldNames.length) return;

    const palette = ["#4e79a7","#f28e2b","#e15759","#76b7b2","#59a14f","#edc948","#b07aa1","#ff9da7","#9c755f","#bab0ac"];
    const datasets = [];
    fieldNames.forEach((fname, i) => {
      const s = fields[fname];
      if (s.byDay.some(d => d.sold > 0)) {
        datasets.push({
          label: `${fname} продажі`,
          data: s.byDay.map(d => d.sold),
          backgroundColor: palette[i % palette.length] + "cc",
          stack: fname,
        });
      }
      if (s.byDay.some(d => d.restock > 0)) {
        datasets.push({
          label: `${fname} надходж.`,
          data: s.byDay.map(d => d.restock),
          backgroundColor: palette[i % palette.length] + "55",
          borderColor: palette[i % palette.length],
          borderWidth: 1,
          stack: fname + "_r",
        });
      }
      if (!s.byDay.some(d => d.sold > 0) && !s.byDay.some(d => d.restock > 0)) {
        datasets.push({
          label: fname,
          data: s.byDay.map(d => d.count),
          backgroundColor: palette[i % palette.length] + "99",
          stack: fname,
        });
      }
    });

    _analyticsChart = new Chart(canvasEl, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "top" } },
        scales: {
          x: { stacked: false },
          y: { beginAtZero: true },
        },
      },
    });
  } catch (e) {
    cardsEl.innerHTML = `<span style="color:var(--danger,#e05);font-size:13px">Помилка: ${e.message}</span>`;
  }
};

// ── Help Modal ────────────────────────────────────────────────────────────
const showHelp = () => {
  document.getElementById("help-modal").classList.add("open");
};

const hideHelp = () => {
  document.getElementById("help-modal").classList.remove("open");
};

// Expose functions used in inline onclick/oninput handlers
Object.assign(window, {
  runTask,
  stopTask,
  resumeTask,
  loadMonitor,
  openMonitor,
  deleteTask,
  editTask,
  viewResults,
  showRunLog,
  updateField,
  removeField,
  addField,
  openSelectorPicker,
  updateRequest,
  removeRequest,
  addRequest,
  insertRequestField,
  updateDetailField,
  removeDetailField,
  deleteResult,
  deleteAllResults,
  checkProxy,
  deleteProxy,
  showSubTaskHistory,
  runSubTaskNow,
  toggleSubTask,
  disableSubTask,
  showHelp,
  hideHelp,
  exportSubTaskHistory,
  loadAnalytics,
  searchByField,
  copySearchUrl,
});

// ── Search by field tester ────────────────────────────────────────────────
async function searchByField() {
  const field = document.getElementById("search-field")?.value?.trim();
  const value = document.getElementById("search-value")?.value ?? "";
  const limit = parseInt(document.getElementById("search-limit")?.value) || 100;
  const taskId = state.selectedTaskId;

  if (!taskId) return;
  if (!field || value === "") {
    UI.toast("Вкажіть назву поля та значення", "warning");
    return;
  }

  const params = new URLSearchParams({ field, value, limit });
  const url = `${location.origin}/api/tasks/${taskId}/results/search?${params}`;
  document.getElementById("search-url-input").value = url;
  document.getElementById("search-url-row").style.display = "";

  const btn = document.getElementById("btn-do-search");
  UI.loading(btn, true);
  document.getElementById("search-result-wrap").style.display = "none";

  try {
    const data = await API.results.search(taskId, field, value, limit);
    const count = data.total ?? data.items?.length ?? 0;
    document.getElementById("search-result-count").textContent = `${count} збігів`;
    document.getElementById("search-result-pre").textContent =
      JSON.stringify(data.items ?? data, null, 2);
    document.getElementById("search-result-wrap").style.display = "";
  } catch (err) {
    UI.toast("Помилка пошуку: " + err.message, "error");
  } finally {
    UI.loading(btn, false);
  }
}

function copySearchUrl() {
  const url = document.getElementById("search-url-input")?.value;
  if (!url) return;
  navigator.clipboard.writeText(url)
    .then(() => UI.toast("URL скопійовано", "success"))
    .catch(() => UI.toast("Не вдалось скопіювати", "error"));
}
