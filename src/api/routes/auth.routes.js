const router = require('express').Router();
const auth = require('../controllers/auth.controller');
const { requireAuth } = require('../middlewares/auth.middleware');

router.post('/register', auth.register);
router.post('/login',    auth.login);
router.get('/me',        requireAuth, auth.me);

module.exports = router;
