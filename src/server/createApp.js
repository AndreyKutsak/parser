const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const rateLimit = require("express-rate-limit");
const swaggerUi = require("swagger-ui-express");

const apiRoutes = require("../api/routes");
const {
  errorHandler,
  notFound,
} = require("../api/middlewares/error.middleware");
const logger = require("../utils/logger");
const swaggerSpec = require("../../config/swagger");
const createVisualProxyHandler = require("./createVisualProxyHandler");

function createApp() {
  const app = express();
  const frontendPath = path.join(__dirname, "../../frontend");

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:", "http:"],
          frameSrc: ["'self'", "https:", "http:"],
          connectSrc: ["'self'"],
        },
      },
    }),
  );

  app.use(
    cors({
      origin: process.env.CORS_ORIGIN || "*",
      credentials: true,
    }),
  );

  app.use(
    "/api/",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 500,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        message: "Too many requests, please slow down",
      },
    }),
  );

  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true, limit: "5mb" }));

  app.use(
    morgan("combined", {
      stream: { write: (msg) => logger.http(msg.trim()) },
      skip: (req) => req.path.startsWith("/health"),
    }),
  );

  app.use(express.static(frontendPath));
  app.get("/api-proxy", createVisualProxyHandler());

  app.use("/api", apiRoutes);
  app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: "Web Parser Pro — Документація API",
    }),
  );

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      version: require("../../package.json").version,
    });
  });

  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    res.sendFile(path.join(frontendPath, "index.html"));
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
