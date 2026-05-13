const router = require("express").Router();
const proxy = require("../controllers/proxy.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  validateProxy,
  validateImport,
} = require("../validators/proxy.validator");

router.use(requireAuth);

router.get("/", proxy.list);
router.post("/", validateProxy, proxy.create);
router.post("/import", validateImport, proxy.importBulk);
router.post("/bulk-delete", proxy.removeBulk);
router.post("/check-all", proxy.checkAll);
router.get("/stats", proxy.stats);
router.get("/:id", proxy.get);
router.put("/:id", proxy.update);
router.delete("/:id", proxy.remove);
router.post("/:id/check", proxy.check);

module.exports = router;
