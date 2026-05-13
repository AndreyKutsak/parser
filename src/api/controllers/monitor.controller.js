const taskRepo    = require('../../db/repositories/task.repository');
const subtaskRepo = require('../../db/repositories/subtask.repository');

/**
 * GET /api/monitor
 * Returns running tasks, paused tasks, scheduled tasks, and active subtasks.
 */
exports.get = async (req, res, next) => {
  try {
    const [allTasks, activeSubtasks] = await Promise.all([
      taskRepo.findAll({ limit: 200 }),
      subtaskRepo.findActive(),
    ]);

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
    });
  } catch (err) {
    next(err);
  }
};
