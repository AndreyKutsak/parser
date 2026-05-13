const router = require('express').Router();
const { requireAuth } = require('../middlewares/auth.middleware');

router.use('/auth',    require('./auth.routes'));
router.use('/tasks',   require('./tasks.routes'));
router.use('/proxies', require('./proxy.routes'));
router.get('/monitor', requireAuth, require('../controllers/monitor.controller').get);
router.get('/export/domain', requireAuth, require('../controllers/export.controller').byDomain);
router.get('/export/domains', requireAuth, require('../controllers/export.controller').domains);
router.get('/export/domain/fields', requireAuth, require('../controllers/export.controller').domainFields);

module.exports = router;
