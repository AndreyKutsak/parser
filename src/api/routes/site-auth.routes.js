const router = require('express').Router();
const { requireAuth } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/site-auth.controller');

router.use(requireAuth);

router.get('/',              ctrl.list);
router.post('/',             ctrl.create);
router.put('/:id',           ctrl.update);
router.delete('/:id',        ctrl.remove);
router.post('/:id/authenticate', ctrl.authenticate);
router.put('/:id/cookies',   ctrl.setCookies);

module.exports = router;
