const resultRepo = require("../../db/repositories/result.repository");

const toNum = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^\d.,-]/g, "").replace(/,/g, "."));
  return isNaN(n) ? null : n;
};

const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

exports.get = async (req, res, next) => {
  try {
    const { taskId } = req.params;
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const trackFields = req.query.fields
      ? (Array.isArray(req.query.fields) ? req.query.fields : req.query.fields.split(",").map((s) => s.trim()))
      : null;

    const from = new Date();
    from.setDate(from.getDate() - days + 1);
    from.setHours(0, 0, 0, 0);

    // Load all results that have fieldChanges (no runId filter — across all runs)
    const { items } = await resultRepo.findByTask(taskId, { limit: 50000 });

    // Build day labels
    const dayLabels = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      dayLabels.push(dayKey(d));
    }

    // Aggregate changes per field
    const fieldStats = new Map(); // fieldName → { total, sold, restock, priceUp, priceDown, byDay }

    const seenKeys = new Set();

    for (const r of items) {
      for (const c of r.fieldChanges ?? []) {
        const d = new Date(c.changedAt);
        if (d < from) continue;
        const dk = dayKey(d);

        // Dedup same as export
        const minTs = Math.floor(d.getTime() / 60000);
        const uniq = `${c.fieldName}|${c.oldValue}|${c.newValue}|${minTs}`;
        if (seenKeys.has(uniq)) continue;
        seenKeys.add(uniq);

        if (trackFields && !trackFields.includes(c.fieldName)) continue;

        if (!fieldStats.has(c.fieldName)) {
          fieldStats.set(c.fieldName, {
            total: 0,
            sold: 0,
            restock: 0,
            priceUp: 0,
            priceDown: 0,
            byDay: Object.fromEntries(dayLabels.map((d) => [d, { count: 0, sold: 0, restock: 0 }])),
          });
        }

        const stat = fieldStats.get(c.fieldName);
        stat.total++;
        if (stat.byDay[dk]) stat.byDay[dk].count++;

        const oldN = toNum(c.oldValue);
        const newN = toNum(c.newValue);
        if (oldN !== null && newN !== null) {
          const diff = newN - oldN;
          if (diff < 0) {
            stat.sold += Math.abs(diff);
            if (stat.byDay[dk]) stat.byDay[dk].sold += Math.abs(diff);
          } else if (diff > 0) {
            stat.restock += diff;
            if (stat.byDay[dk]) stat.byDay[dk].restock += diff;
            stat.priceUp++;
          } else {
            // numeric but same value — ignore
          }
          if (diff < 0) stat.priceDown++;
        }
      }
    }

    const result = {};
    for (const [field, stat] of fieldStats) {
      result[field] = {
        total: stat.total,
        sold: Math.round(stat.sold * 100) / 100,
        restock: Math.round(stat.restock * 100) / 100,
        priceUp: stat.priceUp,
        priceDown: stat.priceDown,
        byDay: dayLabels.map((d) => ({
          date: d,
          count: stat.byDay[d]?.count ?? 0,
          sold: Math.round((stat.byDay[d]?.sold ?? 0) * 100) / 100,
          restock: Math.round((stat.byDay[d]?.restock ?? 0) * 100) / 100,
        })),
      };
    }

    res.json({ success: true, days, from: dayKey(from), fields: result, labels: dayLabels });
  } catch (err) {
    next(err);
  }
};
