/**
 * API client — thin wrapper around fetch with JWT auth and error handling
 */
const API = (() => {
  const BASE = "/api";

  const getToken = () => localStorage.getItem("token");

  const headers = (extra = {}) => ({
    "Content-Type": "application/json",
    ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    ...extra,
  });

  const request = async (method, path, body) => {
    const opts = { method, headers: headers() };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const resp = await fetch(BASE + path, opts);
    const data = await resp
      .json()
      .catch(() => ({ success: false, message: "Invalid response" }));

    if (!resp.ok) {
      if (resp.status === 401) {
        localStorage.removeItem("token");
        window.dispatchEvent(new CustomEvent("auth:expired"));
      }
      throw Object.assign(new Error(data.message || "Request failed"), {
        status: resp.status,
        data,
      });
    }
    return data;
  };

  // ── Auth ──────────────────────────────────────────────────────────
  const auth = {
    login: (body) => request("POST", "/auth/login", body),
    register: (body) => request("POST", "/auth/register", body),
    me: () => request("GET", "/auth/me"),
  };

  // ── Tasks ─────────────────────────────────────────────────────────
  const tasks = {
    list: (params = {}) =>
      request("GET", "/tasks?" + new URLSearchParams(params)),
    get: (id) => request("GET", `/tasks/${id}`),
    create: (body) => request("POST", "/tasks", body),
    update: (id, body) => request("PUT", `/tasks/${id}`, body),
    delete: (id) => request("DELETE", `/tasks/${id}`),
    run: (id) => request("POST", `/tasks/${id}/run`),
    stop: (id) => request("POST", `/tasks/${id}/stop`),
    pause: (id) => request("POST", `/tasks/${id}/pause`),
    resume: (id) => request("POST", `/tasks/${id}/resume`),
    queueStats: () => request("GET", "/tasks/queue/stats"),
    runs: (id) => request("GET", `/tasks/${id}/runs`),
    liveUrl: (id) =>
      `${BASE}/tasks/${id}/live?token=${encodeURIComponent(getToken() || "")}`,
  };

  // ── Results ───────────────────────────────────────────────────────
  const results = {
    list: (taskId, p) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(p || {}))
        if (v !== undefined && v !== null) q.set(k, v);
      return request("GET", `/tasks/${taskId}/results?` + q);
    },
    runs: (taskId) => request("GET", `/tasks/${taskId}/results/runs`),
    search: (taskId, field, value, limit = 1000) => {
      const q = new URLSearchParams({ field, value, limit });
      return fetch(`${BASE}/tasks/${taskId}/results/search?${q}`)
        .then((r) => r.json());
    },
    count: (taskId) => request("GET", `/tasks/${taskId}/results/count`),
    delete: (taskId, p) =>
      request(
        "DELETE",
        `/tasks/${taskId}/results?` + new URLSearchParams(p || {}),
      ),
    deleteOne: (taskId, resultId) =>
      request("DELETE", `/tasks/${taskId}/results/${resultId}`),
    forward: (taskId, body) => request("POST", `/tasks/${taskId}/results/forward`, body),
    getDomains: () => request("GET", "/export/domains"),
    getDomainFields: (domain) => request("GET", `/export/domain/fields?domain=${encodeURIComponent(domain)}`),

    exportByDomain: async (domain, fmt, extra = {}) => {
      const params = { domain, format: fmt, ...extra };
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) value.forEach((v) => searchParams.append(key, v));
        else if (value !== undefined && value !== null) searchParams.append(key, String(value));
      }
      const resp = await fetch(`${BASE}/export/domain?${searchParams}`, {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
      });
      if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.message || "Export failed"); }
      const blob = await resp.blob();
      const disposition = resp.headers.get("Content-Disposition") || "";
      const ext = fmt === "excel" ? "xlsx" : fmt;
      const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      const asciiMatch = disposition.match(/filename="([^"]+)"/);
      const filename = utf8Match ? decodeURIComponent(utf8Match[1].trim()) : asciiMatch ? asciiMatch[1] : `domain_export.${ext}`;
      return { blob, filename };
    },

    exportFile: async (taskId, fmt, runId, extra = {}) => {
      const params = { ...(runId ? { runId } : {}), ...extra };
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
          value.forEach((item) => searchParams.append(key, item));
        } else if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      }
      const q = searchParams.toString() ? `?${searchParams.toString()}` : "";
      const resp = await fetch(`${BASE}/tasks/${taskId}/export/${fmt}${q}`, {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.message || "Export failed");
      }
      const blob = await resp.blob();
      const disposition = resp.headers.get("Content-Disposition") || "";
      const ext = fmt === "excel" ? "xlsx" : fmt;
      const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      const asciiMatch = disposition.match(/filename="([^"]+)"/);
      const filename = utf8Match
        ? decodeURIComponent(utf8Match[1].trim())
        : asciiMatch
          ? asciiMatch[1]
          : `export.${ext}`;
      return { blob, filename };
    },
  };

  // ── SubTasks ──────────────────────────────────────────────────────
  const subtasks = {
    list: (taskId) => request("GET", `/tasks/${taskId}/subtasks`),
    get: (taskId, id) => request("GET", `/tasks/${taskId}/subtasks/${id}`),
    history: (taskId, id) =>
      request("GET", `/tasks/${taskId}/subtasks/${id}/history`),
    update: (taskId, id, b) =>
      request("PATCH", `/tasks/${taskId}/subtasks/${id}`, b),
    runNow: (taskId, id) =>
      request("POST", `/tasks/${taskId}/subtasks/${id}/run`),
    disable: (taskId, id) =>
      request("DELETE", `/tasks/${taskId}/subtasks/${id}`),
    exportHistory: async (taskId, id, fmt) => {
      const resp = await fetch(
        `${BASE}/tasks/${taskId}/subtasks/${id}/export/${fmt}`,
        {
          headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
        },
      );
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.message || "Export failed");
      }
      const blob = await resp.blob();
      const disposition = resp.headers.get("Content-Disposition") || "";
      const ext = fmt === "excel" ? "xlsx" : fmt;
      const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      const asciiMatch = disposition.match(/filename="([^"]+)"/);
      const filename = utf8Match
        ? decodeURIComponent(utf8Match[1].trim())
        : asciiMatch
          ? asciiMatch[1]
          : `subtask-history.${ext}`;
      return { blob, filename };
    },
  };

  // ── Analytics ────────────────────────────────────────────────────
  const analyticsApi = {
    get: (taskId, params = {}) =>
      request("GET", `/tasks/${taskId}/analytics?` + new URLSearchParams(params)),
  };

  // ── Monitor ──────────────────────────────────────────────────────
  const monitor = {
    get: () => request("GET", "/monitor"),
  };

  // ── Proxies ───────────────────────────────────────────────────────
  const proxies = {
    list: (p) => request("GET", "/proxies?" + new URLSearchParams(p || {})),
    create: (b) => request("POST", "/proxies", b),
    import: (b) => request("POST", "/proxies/import", b),
    delete: (id) => request("DELETE", `/proxies/${id}`),
    check: (id) => request("POST", `/proxies/${id}/check`),
    checkAll: () => request("POST", "/proxies/check-all"),
    stats: () => request("GET", "/proxies/stats"),
  };

  // ── Site Auths ────────────────────────────────────────────────────
  const siteAuths = {
    list: () => request("GET", "/site-auths"),
    create: (b) => request("POST", "/site-auths", b),
    update: (id, b) => request("PUT", `/site-auths/${id}`, b),
    delete: (id) => request("DELETE", `/site-auths/${id}`),
    authenticate: (id) => request("POST", `/site-auths/${id}/authenticate`),
    setCookies: (id, cookies) => request("PUT", `/site-auths/${id}/cookies`, { cookies }),
  };

  return {
    auth,
    tasks,
    results,
    proxies,
    subtasks,
    monitor,
    analytics: analyticsApi,
    siteAuths,
    getToken,
    setToken: (t) => localStorage.setItem("token", t),
    clearToken: () => localStorage.removeItem("token"),
  };
})();
