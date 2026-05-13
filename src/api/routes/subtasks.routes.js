const router = require("express").Router({ mergeParams: true });
const ctrl = require("../controllers/subtasks.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

router.use(requireAuth);

router.get("/", ctrl.list); // GET    /api/tasks/:taskId/subtasks
router.get("/:id", ctrl.get); // GET    /api/tasks/:taskId/subtasks/:id
router.get("/:id/history", ctrl.history); // GET    /api/tasks/:taskId/subtasks/:id/history
router.patch("/:id", ctrl.update); // PATCH  /api/tasks/:taskId/subtasks/:id
router.post("/:id/run", ctrl.runNow); // POST   /api/tasks/:taskId/subtasks/:id/run
router.delete("/:id", ctrl.disable); // DELETE /api/tasks/:taskId/subtasks/:id

// Export sub-routes
router.get("/:id/export/json", ctrl.exportJson);
router.get("/:id/export/csv", ctrl.exportCsv);
router.get("/:id/export/excel", ctrl.exportExcel);

module.exports = router;
