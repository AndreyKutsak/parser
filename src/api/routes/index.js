const router = require('express').Router();
const { requireAuth } = require('../middlewares/auth.middleware');

router.use('/auth',       require('./auth.routes'));
router.use('/tasks',      require('./tasks.routes'));
router.use('/proxies',    require('./proxy.routes'));
router.use('/site-auths', require('./site-auth.routes'));
router.get('/monitor', requireAuth, require('../controllers/monitor.controller').get);

const errorsCtrl = require('../controllers/errors.controller');
router.get('/errors',                requireAuth, errorsCtrl.list);
router.get('/errors/sites',          requireAuth, errorsCtrl.sites);
router.get('/errors/:fingerprint',   requireAuth, errorsCtrl.get);
router.delete('/errors/:fingerprint', requireAuth, errorsCtrl.remove);
router.delete('/errors',             requireAuth, errorsCtrl.clear);
router.get('/export/domain', requireAuth, require('../controllers/export.controller').byDomain);
router.get('/export/domains', requireAuth, require('../controllers/export.controller').domains);
router.get('/export/domain/fields', requireAuth, require('../controllers/export.controller').domainFields);

module.exports = router;
