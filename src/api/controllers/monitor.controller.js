const os          = require('os');
const taskRepo    = require('../../db/repositories/task.repository');
const subtaskRepo = require('../../db/repositories/subtask.repository');
const memoryReporter = require('../../utils/memory-reporter');

let ecosystem = null;
try { ecosystem = require('../../../ecosystem.config.js'); } catch { /* not present in this env */ }

/** e.g. '700M' -> 734003200 (bytes) */
function parseMemString(str) {
  const m = /^(\d+(?:\.\d+)?)([KMG])$/i.exec(String(str || ''));
  if (!m) return null;
  const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

function getConfiguredLimits(name) {
  const app = ecosystem?.apps?.find((a) => a.name === name);
  if (!app) return {};
  const heapMatch = /--max-old-space-size=(\d+)/.exec(app.node_args || '');
  return {
    heapLimitBytes: heapMatch ? parseInt(heapMatch[1], 10) * 1024 * 1024 : null,
    restartLimitBytes: parseMemString(app.max_memory_restart),
  };
}

/**
 * GET /api/monitor
 * Returns running tasks, paused tasks, scheduled tasks, active subtasks, and process RAM usage.
 */
exports.get = async (req, res, next) => {
  try {
    const [allTasks, activeSubtasks, processMemory] = await Promise.all([
      taskRepo.findAll({ limit: 200 }),
      subtaskRepo.findActive(),
      memoryReporter.readAll(),
    ]);

    const memory = processMemory.map((p) => ({ ...p, ...getConfiguredLimits(p.name) }));
    const system = { totalMem: os.totalmem(), freeMem: os.freemem() };

    const tasks = allTasks.items || allTasks;

    const runningTasks   = tasks.filter(t => t.status === 'running');
    const pausedTasks    = tasks.filter(t => t.status === 'paused');
    const scheduledTasks = tasks
      .filter(t => t.schedule?.enabled && t.status !== 'running')
      .sort((a, b) => {
        const na = a.schedule?.nextRun ? new Date(a.schedule.nextRun) : Infinity;
        const nb = b.schedule?.nextRun ? new Date(b.schedule.nextRun) : Infinity;
        return na - nb;
      });

    res.json({
      success: true,
      runningTasks,
      pausedTasks,
      scheduledTasks,
      activeSubtasks,
      memory,
      system,
    });
  } catch (err) {
    next(err);
  }
};
