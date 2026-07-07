const router = require('express').Router();
const tasks = require('../controllers/tasks.controller');
const results = require('../controllers/results.controller');
const exporter = require('../controllers/export.controller');
const analytics = require('../controllers/analytics.controller');
const preview = require('../controllers/preview.controller');
const { requireAuth, requireApiToken } = require('../middlewares/auth.middleware');
const { validateCreate, validateUpdate, validatePreview } = require('../validators/task.validator');

// SSE live — auth via ?token= query param (EventSource cannot set headers), must be BEFORE router.use(requireAuth)
router.get('/:id/live',    tasks.live);

// Public — no auth required
router.get('/:taskId/results/search', results.search);

// Selector test/preview — protected by a static API token (PREVIEW_API_TOKEN), not a user JWT
router.post('/preview', requireApiToken, validatePreview, preview.preview);

router.use(requireAuth);

router.get('/',            tasks.list);
router.post('/',           validateCreate, tasks.create);
router.get('/queue/stats', tasks.queueStats);
router.get('/:id',         tasks.get);
router.put('/:id',         validateUpdate, tasks.update);
router.delete('/:id',      tasks.remove);
router.post('/:id/run',    tasks.run);
router.post('/:id/stop',   tasks.stop);
router.post('/:id/pause',  tasks.pause);
router.post('/:id/resume', tasks.resume);
router.get('/:id/runs',    tasks.getRuns);

// Results sub-routes
router.get('/:taskId/results',              results.list);
router.get('/:taskId/results/runs',         results.getRuns);
router.get('/:taskId/results/count',        results.count);
router.post('/:taskId/results/forward',     results.forwardToApi);
router.delete('/:taskId/results',           results.deleteResults);
router.delete('/:taskId/results/:resultId', results.deleteOne);

// Export sub-routes
router.get('/:taskId/export/json',  exporter.json);
router.get('/:taskId/export/csv',   exporter.csv);
router.get('/:taskId/export/excel', exporter.excel);
router.get('/:taskId/export/txt',   exporter.txt);

// Analytics
router.get('/:taskId/analytics', analytics.get);

// Sub-tasks sub-routes
router.use('/:taskId/subtasks', require('./subtasks.routes'));

module.exports = router;
