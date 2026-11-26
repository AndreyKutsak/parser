const router = require("express").Router();
const proxy = require("../controllers/proxy.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  validateProxy,
  validateImport,
  validateVpnCreate,
  validateVpnUpdate,
  validateVpnGateImport,
} = require("../validators/proxy.validator");

router.use(requireAuth);

router.get("/", proxy.list);
router.post("/", validateProxy, proxy.create);
router.post("/vpn", validateVpnCreate, proxy.createVpn);
router.post("/vpn/import-vpngate", validateVpnGateImport, proxy.importVpnGate);
router.get("/vpn/import-vpngate", proxy.importVpnGateStatus);
router.put("/vpn/:id", validateVpnUpdate, proxy.updateVpn);
router.post("/import", validateImport, proxy.importBulk);
router.post("/bulk-delete", proxy.removeBulk);
router.post("/check-all", proxy.checkAll);
router.get("/check-status", proxy.checkStatus);
router.post("/reset-errors", proxy.resetErrors);
router.post("/delete-dead", proxy.deleteDead);
router.get("/stats", proxy.stats);
router.get("/:id", proxy.get);
router.put("/:id", proxy.update);
router.delete("/:id", proxy.remove);
router.post("/:id/check", proxy.check);
router.post("/:id/check-site", proxy.checkSite);

module.exports = router;
