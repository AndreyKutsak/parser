/**
 * Exporter Service — converts result records to JSON / CSV / Excel / TXT.
 *
 * All formats use the same _buildProductRows() base:
 *   - One row per unique product (grouped by detailUrl > keyField > _id)
 *   - Subtask lastData merged directly (no prefix, no duplication)
 *   - All fieldChanges from all runs of this product collapsed into "Зміни" column
 *   - "Остання зміна" column with the date of the latest detected change
 *
 * Excel adds a second sheet "Деталі змін" (one row per individual field change)
 * and a third sheet "Історія підзадач" when sub-task run history exists.
 */
const { Parser: Json2CsvParser } = require("json2csv");
const ExcelJS = require("exceljs");
const resultRepo = require("../../db/repositories/result.repository");
const subtaskRepo = require("../../db/repositories/subtask.repository");
const taskRepo = require("../../db/repositories/task.repository");
const logger = require("../../utils/logger");

class ExporterService {
  // Shared row-building pipeline used by all to* methods
  _resolveRows(records, stMap, opts) {
    const { keyField = null, fieldTypes = {}, uniqueField = null,
      aggregateFields = [], mode = null,
      deltaFields = [], dateFrom = null, dateTo = null } = opts;
    let rows = mode === "delta"
      ? this._buildDeltaRows(records, keyField, { deltaFields, dateFrom, dateTo })
      : this._buildProductRows(records, stMap, keyField);
    rows = this._applyNormalization(rows, fieldTypes);
    if (mode !== "delta") rows = this._dedupAndAggregate(rows, uniqueField, aggregateFields);
    return rows;
  }

  async toJson(
    taskId,
    { runId, fields = [], fieldLabels = {}, filters = {}, keyField = null,
      fieldTypes = {}, uniqueField = null, aggregateFields = [],
      mode = null, deltaFields = [], dateFrom = null, dateTo = null } = {},
  ) {
    const records = await this._loadRecords(taskId, runId, filters);
    const stMap = await this._loadSubTaskMap(taskId, records);
    const rows = this._resolveRows(records, stMap, { keyField, fieldTypes, uniqueField, aggregateFields, mode, deltaFields, dateFrom, dateTo });
    const selected = this._applyFieldSelection(rows, fields, fieldLabels);
    return JSON.stringify(selected.rows, null, 2);
  }

  async toCsv(
    taskId,
    { runId, fields = [], fieldLabels = {}, filters = {}, keyField = null,
      fieldTypes = {}, uniqueField = null, aggregateFields = [],
      mode = null, deltaFields = [], dateFrom = null, dateTo = null } = {},
  ) {
    const records = await this._loadRecords(taskId, runId, filters);
    if (!records.length) return "";
    const stMap = await this._loadSubTaskMap(taskId, records);
    const rows = this._resolveRows(records, stMap, { keyField, fieldTypes, uniqueField, aggregateFields, mode, deltaFields, dateFrom, dateTo });
    const selected = this._applyFieldSelection(rows, fields, fieldLabels);
    try {
      const parser = new Json2CsvParser({ fields: Object.keys(selected.rows[0] || {}) });
      return parser.parse(selected.rows);
    } catch (err) {
      logger.error("CSV export error", { error: err.message });
      throw new Error("CSV export failed: " + err.message);
    }
  }

  async toExcel(
    taskId,
    { runId, fields = [], fieldLabels = {}, filters = {}, taskName = "Results",
      keyField = null, fieldTypes = {}, uniqueField = null, aggregateFields = [],
      mode = null, deltaFields = [], dateFrom = null, dateTo = null,
      stream = null } = {},
  ) {
    const records = await this._loadRecords(taskId, runId, filters);
    const stMap = await this._loadSubTaskMap(taskId, records);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Web Parser Pro";
    workbook.created = new Date();

    const sheetName = mode === "delta" ? "Дельта" : (taskName.slice(0, 28) || "Результати");
    const sheet1 = workbook.addWorksheet(sheetName);
    if (!records.length) {
      sheet1.addRow(["No data"]);
    } else {
      const rows = this._resolveRows(records, stMap, { keyField, fieldTypes, uniqueField, aggregateFields, mode, deltaFields, dateFrom, dateTo });
      this._fillSheet(sheet1, this._applyFieldSelection(rows, fields, fieldLabels).rows, "FF2563EB");
    }

    if (mode !== "delta") {
      const hasChanges = records.some((r) => r.fieldChanges?.length > 0);
      if (hasChanges) {
        const sheet2 = workbook.addWorksheet("Деталі змін");
        const changeRows = this._buildChangeDetailRows(records, stMap, keyField);
        if (changeRows.length) this._fillSheet(sheet2, changeRows, "FF7C3AED");
      }
      const hasSubTasks = [...stMap.values()].some((st) => st.history?.length > 0);
      if (hasSubTasks) {
        const sheet3 = workbook.addWorksheet("Історія підзадач");
        const histRows = this._buildHistoryRows(records, stMap);
        if (histRows.length) this._fillSheet(sheet3, histRows, "FF059669");
      }
    }

    // Stream directly to response if provided — avoids allocating a second in-memory buffer
    if (stream) {
      await workbook.xlsx.write(stream);
      return null;
    }
    return workbook.xlsx.writeBuffer();
  }

  async toTxt(
    taskId,
    { runId, filters = {}, fieldSep = "\t", recordSep = "\n", template = null,
      includeHeader = true, fields = [], keyField = null,
      fieldTypes = {}, uniqueField = null, aggregateFields = [],
      mode = null, deltaFields = [], dateFrom = null, dateTo = null } = {},
  ) {
    const records = await this._loadRecords(taskId, runId, filters);
    if (!records.length) return "";
    const stMap = await this._loadSubTaskMap(taskId, records);
    const rows = this._resolveRows(records, stMap, { keyField, fieldTypes, uniqueField, aggregateFields, mode, deltaFields, dateFrom, dateTo });
    const selected = this._applyFieldSelection(rows, fields, {});

    const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    if (template) {
      return selected.rows
        .map((row) => template.replace(/\{\{([^}]+)\}\}/g, (_, k) => clean(row[k])))
        .join(recordSep);
    }
    const keys = selected.keys;
    const lines = [];
    if (includeHeader) lines.push(keys.join(fieldSep));
    for (const row of selected.rows) lines.push(keys.map((k) => clean(row[k])).join(fieldSep));
    return lines.join(recordSep);
  }

  // ── Domain export ─────────────────────────────────────────────────────────

  async _loadDomainRecords(domain, runId, filters) {
    const tasks = await taskRepo.findByDomain(domain);
    if (!tasks.length) return { records: [], tasks: [] };
    const allRecords = [];
    for (const task of tasks) {
      const recs = await this._loadRecords(String(task._id), runId, filters);
      const taskKeyField = task.selectors?.keyField || null;
      recs.forEach((r) => { r._taskName = task.name; r._taskKeyField = taskKeyField; });
      allRecords.push(...recs);
    }
    return { records: allRecords, tasks };
  }

  async domainToJson(domain, opts = {}) {
    const { records, tasks } = await this._loadDomainRecords(domain, opts.runId, opts.filters || {});
    if (!records.length) return "[]";
    const stMap = await this._buildDomainStMap(tasks, records);
    let rows = this._buildProductRows(records, stMap, opts.keyField || null);
    rows = this._applyNormalization(rows, opts.fieldTypes || {});
    rows = this._dedupAndAggregate(rows, opts.uniqueField || null, opts.aggregateFields || []);
    const selected = this._applyFieldSelection(rows, opts.fields || [], opts.fieldLabels || {});
    return JSON.stringify(selected.rows, null, 2);
  }

  async domainToCsv(domain, opts = {}) {
    const { records, tasks } = await this._loadDomainRecords(domain, opts.runId, opts.filters || {});
    if (!records.length) return "";
    const stMap = await this._buildDomainStMap(tasks, records);
    let rows = this._buildProductRows(records, stMap, opts.keyField || null);
    rows = this._applyNormalization(rows, opts.fieldTypes || {});
    rows = this._dedupAndAggregate(rows, opts.uniqueField || null, opts.aggregateFields || []);
    const selected = this._applyFieldSelection(rows, opts.fields || [], opts.fieldLabels || {});
    const parser = new Json2CsvParser({ fields: Object.keys(selected.rows[0]) });
    return parser.parse(selected.rows);
  }

  async domainToExcel(domain, opts = {}) {
    const { records, tasks } = await this._loadDomainRecords(domain, opts.runId, opts.filters || {});
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Web Parser Pro";
    workbook.created = new Date();
    const sheet1 = workbook.addWorksheet(domain.slice(0, 28) || "Домен");
    if (!records.length) {
      sheet1.addRow(["No data"]);
    } else {
      const stMap = await this._buildDomainStMap(tasks, records);
      let rows = this._buildProductRows(records, stMap, opts.keyField || null);
      rows = this._applyNormalization(rows, opts.fieldTypes || {});
      rows = this._dedupAndAggregate(rows, opts.uniqueField || null, opts.aggregateFields || []);
      this._fillSheet(sheet1, this._applyFieldSelection(rows, opts.fields || [], opts.fieldLabels || {}).rows, "FF2563EB");
    }
    return workbook.xlsx.writeBuffer();
  }

  async domainToTxt(domain, opts = {}) {
    const { records, tasks } = await this._loadDomainRecords(domain, opts.runId, opts.filters || {});
    if (!records.length) return "";
    const stMap = await this._buildDomainStMap(tasks, records);
    let rows = this._buildProductRows(records, stMap, opts.keyField || null);
    rows = this._applyNormalization(rows, opts.fieldTypes || {});
    rows = this._dedupAndAggregate(rows, opts.uniqueField || null, opts.aggregateFields || []);
    const selected = this._applyFieldSelection(rows, opts.fields || [], {});
    const { fieldSep = "\t", recordSep = "\n", template = null, includeHeader = true } = opts;
    const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    if (template) {
      return selected.rows
        .map((row) => template.replace(/\{\{([^}]+)\}\}/g, (_, k) => clean(row[k])))
        .join(recordSep);
    }
    const keys = selected.keys;
    const lines = [];
    if (includeHeader) lines.push(keys.join(fieldSep));
    for (const row of selected.rows) lines.push(keys.map((k) => clean(row[k])).join(fieldSep));
    return lines.join(recordSep);
  }

  async _buildDomainStMap(tasks, records) {
    const allUrls = [...new Set(records.map((r) => r.detailUrl).filter(Boolean))];
    if (!allUrls.length) return new Map();
    const allSt = [];
    for (const task of tasks) {
      const subs = await subtaskRepo.findByUrls(String(task._id), allUrls);
      allSt.push(...subs);
    }
    return new Map(allSt.map((st) => [st.url, st]));
  }

  // ── Private: data loading ─────────────────────────────────────────────────

  async _loadRecords(taskId, runId, filters) {
    if (runId) return resultRepo.findAllByRun(taskId, runId, filters);
    const { items } = await resultRepo.findByTask(taskId, {
      limit: 10000,
      ...filters,
    });
    return items;
  }

  async _loadSubTaskMap(taskId, records) {
    const urls = [...new Set(records.map((r) => r.detailUrl).filter(Boolean))];
    if (!urls.length) return new Map();
    const subTasks = await subtaskRepo.findByUrls(taskId, urls);
    return new Map(subTasks.map((st) => [st.url, st]));
  }

  // ── Private: core row builder ─────────────────────────────────────────────

  /**
   * One row per unique product.
   * Grouping priority: detailUrl > keyField value > record _id (no grouping).
   * Each row contains:
   *   - latest scraped data fields
   *   - subtask lastData fields (merged directly, no _st_ prefix)
   *   - "Зміни"        — collapsed summary of ALL field changes across all runs
   *   - "Остання зміна" — date of the newest detected change
   */
  _buildProductRows(records, stMap, keyField = null) {
    // Pre-flatten all data objects once — avoids double-flatten later
    const flatMap = new Map(records.map((r) => [r, this._flatten(r.data || {})]));

    // Group by product key
    const groups = new Map();
    for (const r of records) {
      let key;
      const effectiveKeyField = keyField || r._taskKeyField || null;
      if (r.detailUrl) key = r.detailUrl;
      else if (effectiveKeyField && r.data?.[effectiveKeyField] != null) key = String(r.data[effectiveKeyField]);
      else key = String(r._id);

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    // Stable column order: first appearance wins — use already-flattened objects
    const dataKeys = this._collectKeysFromFlat([...flatMap.values()]);
    const stKeys = this._collectKeys([...stMap.values()].map((st) => st.lastData));

    const rows = [];

    for (const groupRecords of groups.values()) {
      // Latest result in this group
      const latest = groupRecords.reduce((a, b) =>
        new Date(a.createdAt) > new Date(b.createdAt) ? a : b,
      );

      // Product data — reuse pre-flattened value
      const dataFlat = flatMap.get(latest) || {};
      const base = Object.fromEntries(dataKeys.map((k) => [k, dataFlat[k] ?? ""]));

      // Subtask lastData — merged directly (no prefix)
      for (const k of stKeys) base[k] = "";
      const st = latest.detailUrl ? stMap.get(latest.detailUrl) : null;
      if (st?.lastData) Object.assign(base, this._flatten(st.lastData));

      // Collect ALL fieldChanges across all records of this product.
      // Sort oldest→newest, then reconstruct state to filter duplicates
      // (same transition detected by multiple tasks at different times).
      const rawChanges = groupRecords
        .flatMap((r) => r.fieldChanges ?? [])
        .sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));

      const knownState = {};
      const allChanges = [];
      for (const c of rawChanges) {
        const prev = knownState[c.fieldName];
        if (prev === undefined || String(c.oldValue) === prev) {
          knownState[c.fieldName] = String(c.newValue);
          allChanges.push(c);
        }
      }
      allChanges.reverse(); // newest first for display

      if (allChanges.length) {
        base["Зміни"] = allChanges
          .map((c) => {
            const ds = this._fmtDate(c.changedAt, true);
            return `${c.fieldName}: ${c.oldValue}→${c.newValue}${ds ? ` (${ds})` : ""}`;
          })
          .join("; ");
        base["Остання зміна"] = this._fmtDate(allChanges[0].changedAt);
      } else {
        base["Зміни"] = "";
        base["Остання зміна"] = "";
      }

      rows.push(base);
    }

    const allKeys = [...dataKeys, ...stKeys, "Зміни", "Остання зміна"];
    return rows.map((row) =>
      Object.fromEntries(allKeys.map((k) => [k, row[k] ?? ""])),
    );
  }

  /**
   * One row per individual field change event.
   * Each row repeats the product's current data + subtask data for context.
   * Columns: [product fields] [subtask fields] Поле | Було | Стало | Дата
   */
  _buildChangeDetailRows(records, stMap, keyField = null) {
    const dataKeys = this._collectKeys(records.map((r) => r.data));
    const stKeys = this._collectKeys([...stMap.values()].map((st) => st.lastData));
    const CHANGE_COLS = ["Поле", "Було", "Стало", "Дата"];

    const rows = [];

    for (const r of records) {
      if (!r.fieldChanges?.length) continue;

      const dataFlat = this._flatten(r.data || {});
      const base = Object.fromEntries(dataKeys.map((k) => [k, dataFlat[k] ?? ""]));

      for (const k of stKeys) base[k] = "";
      const st = r.detailUrl ? stMap.get(r.detailUrl) : null;
      if (st?.lastData) Object.assign(base, this._flatten(st.lastData));

      for (const c of r.fieldChanges) {
        rows.push({
          ...base,
          Поле: c.fieldName ?? "",
          Було: String(c.oldValue ?? ""),
          Стало: String(c.newValue ?? ""),
          Дата: this._fmtDate(c.changedAt),
        });
      }
    }

    if (!rows.length) return rows;
    const allKeys = [...dataKeys, ...stKeys, ...CHANGE_COLS];
    return rows.map((row) =>
      Object.fromEntries(allKeys.map((k) => [k, row[k] ?? ""])),
    );
  }

  /**
   * Subtask run history timeline — one row per run per product.
   * Sheet 3 in Excel, only rendered when sub-task history exists.
   */
  _buildHistoryRows(records, stMap) {
    const rows = [];

    for (const r of records) {
      const st = r.detailUrl ? stMap.get(r.detailUrl) : null;
      if (!st?.history?.length) continue;

      const mainFlat = {
        _url: r.url,
        _detailUrl: r.detailUrl,
        ...this._flatten(r.data),
      };

      for (const h of [...st.history].reverse()) {
        rows.push({
          ...mainFlat,
          _st_parsedAt: h.parsedAt,
          _st_changed: h.changed,
          _st_duration: h.duration ? `${h.duration} ms` : "",
          _st_error: h.error ?? "",
          ...(h.data ? this._flatten(h.data, "_st_") : {}),
        });
      }
    }

    if (!rows.length) return rows;
    const allKeys = [...new Set(rows.flatMap(Object.keys))];
    return rows.map((row) =>
      Object.fromEntries(allKeys.map((k) => [k, row[k] ?? ""])),
    );
  }

  // ── Private: sheet writer ─────────────────────────────────────────────────

  _applyFieldSelection(rows, fields = [], fieldLabels = {}) {
    if (!rows.length) return { rows, keys: [], headers: [] };
    const sourceKeys = Object.keys(rows[0]);
    const selectedKeys = fields && fields.length ? fields : sourceKeys;
    const selectedRows = rows.map((row) => {
      const output = {};
      for (const key of selectedKeys) {
        output[fieldLabels[key] || key] = row[key] ?? "";
      }
      return output;
    });
    return {
      rows: selectedRows,
      keys: selectedKeys,
      headers: selectedKeys.map((key) => fieldLabels[key] || key),
    };
  }

  _fillSheet(sheet, rows, headerArgb = "FF2563EB") {
    if (!rows.length) return;
    const columns = Object.keys(rows[0]);

    const FIXED_WIDTHS = {
      Поле: 18, Було: 22, Стало: 22, Дата: 20,
      Зміни: 50, "Остання зміна": 20,
    };
    sheet.columns = columns.map((key) => ({
      header: key,
      key,
      width: FIXED_WIDTHS[key] ?? Math.min(Math.max(key.length + 5, 15), 50),
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerArgb } };
    headerRow.alignment = { vertical: "middle" };
    headerRow.height = 20;

    rows.forEach((row, idx) => {
      const r = sheet.addRow(row);
      if (idx % 2 === 0) {
        r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    });

    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };
  }

  // ── Private: helpers ──────────────────────────────────────────────────────

  /** Collect unique flattened keys from an array of data objects (first-seen order). */
  _collectKeys(dataObjects) {
    const set = new Set();
    const keys = [];
    for (const obj of dataObjects) {
      if (!obj) continue;
      for (const k of Object.keys(this._flatten(obj))) {
        if (!set.has(k)) { set.add(k); keys.push(k); }
      }
    }
    return keys;
  }

  /** Same as _collectKeys but accepts already-flattened objects — no double flatten. */
  _collectKeysFromFlat(flatObjects) {
    const set = new Set();
    const keys = [];
    for (const obj of flatObjects) {
      if (!obj) continue;
      for (const k of Object.keys(obj)) {
        if (!set.has(k)) { set.add(k); keys.push(k); }
      }
    }
    return keys;
  }

  /** Format a date as "DD.MM.YYYY HH:MM" (short=true → "DD.MM HH:MM"). */
  _fmtDate(date, short = false) {
    if (!date) return "";
    const d = new Date(date);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return short ? `${dd}.${mm} ${hh}:${min}` : `${dd}.${mm}.${yyyy} ${hh}:${min}`;
  }

  _buildDeltaRows(records, keyField = null, { deltaFields = [], dateFrom = null, dateTo = null } = {}) {
    const toNum = (v) => {
      const n = parseFloat(String(v ?? "").replace(/[^\d.,-]/g, "").replace(/,/g, "."));
      return isNaN(n) ? null : n;
    };
    const fmt = (n) => n === null ? "" : String(Math.round(n * 1e10) / 1e10);

    // Group by product
    const groups = new Map();
    for (const r of records) {
      const _ef = keyField || r._taskKeyField || null;
      let key = r.detailUrl || (_ef && r.data?.[_ef] != null ? String(r.data[_ef]) : String(r._id));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const dataKeys = this._collectKeys(records.map((r) => r.data));
    const dfrom = dateFrom ? new Date(dateFrom) : null;
    const dto = dateTo ? new Date(dateTo) : null;
    const rows = [];

    for (const groupRecords of groups.values()) {
      const latest = groupRecords.reduce((a, b) => new Date(a.createdAt) > new Date(b.createdAt) ? a : b);
      const dataFlat = this._flatten(latest.data || {});
      const base = Object.fromEntries(dataKeys.map((k) => [k, dataFlat[k] ?? ""]));

      // All changes filtered by date range, sorted oldest→newest
      const allChanges = groupRecords
        .flatMap((r) => r.fieldChanges ?? [])
        .filter((c) => {
          const d = new Date(c.changedAt);
          if (dfrom && d < dfrom) return false;
          if (dto && d > dto) return false;
          return true;
        })
        .sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));

      // Group by field name
      const byField = new Map();
      for (const c of allChanges) {
        if (!byField.has(c.fieldName)) byField.set(c.fieldName, []);
        byField.get(c.fieldName).push(c);
      }

      const fields = deltaFields.length ? deltaFields : [...byField.keys()];
      for (const field of fields) {
        const changes = byField.get(field) || [];
        if (!changes.length) {
          base[`${field}_початок`] = "";
          base[`${field}_кінець`] = "";
          base[`${field}_дельта`] = "";
          base[`${field}_продажі`] = "";
          base[`${field}_надходження`] = "";
          continue;
        }
        const startVal = toNum(changes[0].oldValue);
        const endVal = toNum(changes[changes.length - 1].newValue);
        const delta = startVal !== null && endVal !== null ? endVal - startVal : null;
        let sales = 0, restock = 0;
        for (const c of changes) {
          const o = toNum(c.oldValue), n = toNum(c.newValue);
          if (o !== null && n !== null) {
            if (n < o) sales += o - n;
            else if (n > o) restock += n - o;
          }
        }
        base[`${field}_початок`] = fmt(startVal);
        base[`${field}_кінець`] = fmt(endVal);
        base[`${field}_дельта`] = fmt(delta);
        base[`${field}_продажі`] = fmt(sales || null);
        base[`${field}_надходження`] = fmt(restock || null);
      }
      rows.push(base);
    }

    if (!rows.length) return rows;
    const allKeys = [...dataKeys, ...new Set(rows.flatMap(Object.keys).filter((k) => !dataKeys.includes(k)))];
    return rows.map((row) => Object.fromEntries(allKeys.map((k) => [k, row[k] ?? ""])));
  }

  _applyNormalization(rows, fieldTypes = {}) {
    if (!Object.keys(fieldTypes).length) return rows;
    return rows.map((row) => {
      const out = { ...row };
      for (const [field, type] of Object.entries(fieldTypes)) {
        if (!(field in out)) continue;
        const v = String(out[field] ?? "");
        if (type === "numeric") {
          const cleaned = v.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
          out[field] = cleaned === "" ? "" : cleaned;
        }
      }
      return out;
    });
  }

  _dedupAndAggregate(rows, uniqueField = null, aggregateFields = []) {
    if (!uniqueField || !rows.length) return rows;
    const aggrSet = new Set(aggregateFields);
    const map = new Map();
    const noKey = [];
    for (const row of rows) {
      const key = String(row[uniqueField] ?? "").trim();
      if (!key) { noKey.push(row); continue; }
      if (!map.has(key)) {
        map.set(key, { ...row });
      } else {
        const base = map.get(key);
        for (const field of aggrSet) {
          const a = parseFloat(String(base[field] ?? "").replace(/[^\d.-]/g, "")) || 0;
          const b = parseFloat(String(row[field] ?? "").replace(/[^\d.-]/g, "")) || 0;
          base[field] = String(Math.round((a + b) * 1e10) / 1e10);
        }
      }
    }
    return [...map.values(), ...noKey];
  }

  _normalizeText(val) {
    if (typeof val !== "string") return val;
    return val.replace(/\s+/g, " ").trim();
  }

  _flatten(obj, prefix = "", result = {}) {
    if (!obj || typeof obj !== "object") {
      if (prefix) result[prefix.replace(/_$/, "")] = this._normalizeText(obj);
      return result;
    }
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}${key}` : key;
      if (val && typeof val === "object" && !Array.isArray(val)) {
        this._flatten(val, `${path}.`, result);
      } else {
        const raw = Array.isArray(val) ? val.join(", ") : val;
        result[path] = this._normalizeText(raw);
      }
    }
    return result;
  }

  // ── Sub-task history export (subtask detail page) ─────────────────────────

  async historyToCsv(history) {
    if (!history.length) return "";
    const rows = history.map((h) => ({
      parsedAt: h.parsedAt,
      duration: h.duration,
      changed: h.changed,
      error: h.error ?? "",
      ...this._flatten(h.data),
    }));
    try {
      const parser = new Json2CsvParser({ fields: Object.keys(rows[0]) });
      return parser.parse(rows);
    } catch (err) {
      logger.error("Sub-task history CSV export error", { error: err.message });
      throw new Error("CSV export failed: " + err.message);
    }
  }

  async historyToExcel(history, { subtaskUrl = "Sub-task History" } = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Web Parser Pro";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(subtaskUrl.slice(0, 28) || "Історія");
    if (!history.length) {
      sheet.addRow(["No history"]);
    } else {
      const rows = history.map((h) => ({
        parsedAt: h.parsedAt,
        duration: h.duration,
        changed: h.changed,
        error: h.error ?? "",
        ...this._flatten(h.data),
      }));
      this._fillSheet(sheet, rows, "FFDC2626");
    }

    return workbook.xlsx.writeBuffer();
  }
}

module.exports = new ExporterService();
