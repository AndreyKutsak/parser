const Joi = require("joi");

const fieldSchema = Joi.object({
  selector: Joi.string().required(),
  selectorType: Joi.string().valid("css", "xpath").default("css"),
  attr: Joi.string().allow(null, "").default(null),
  transform: Joi.alternatives(
    Joi.string(),
    Joi.array().items(Joi.string()),
  ).allow(null),
  multiple: Joi.boolean().default(false),
  monitor: Joi.boolean().default(false),
});

const paginationSchema = Joi.object({
  enabled: Joi.boolean().default(false),
  type: Joi.string()
    .valid("next-button", "page-number", "load-more", "scroll", "url-pattern")
    .default("next-button"),
  selector: Joi.string().allow("", null),
  urlPattern: Joi.string().allow("", null),
  startPage: Joi.number().integer().min(1).default(1),
  maxPages: Joi.number().integer().min(1).max(1000).default(10),
});

const requestSchema = Joi.object({
  url: Joi.string().required(),
  method: Joi.string().valid("GET", "POST").default("GET"),
  body: Joi.object({
    format: Joi.string().valid("json", "form", "raw").default("json"),
    data: Joi.alternatives(Joi.string(), Joi.object(), Joi.number())
      .allow(null)
      .default(null),
  }).default({}),
  headers: Joi.object().pattern(Joi.string(), Joi.string()).default({}),
  cookies: Joi.string().allow("", null).default(null),
  selectors: Joi.object({
    item: Joi.string().allow("", null).default(null),
    fields: Joi.object()
      .pattern(Joi.string().max(100), fieldSchema)
      .default({}),
  }).default({}),
});

const createTaskSchema = Joi.object({
  name: Joi.string().trim().min(2).max(200).required(),
  url: Joi.string().uri().allow("", null).optional(),
  engine: Joi.string().valid("static", "dynamic").default("static"),
  requests: Joi.array().items(requestSchema).default([]),

  selectors: Joi.object({
    item: Joi.string()
      .required()
      .messages({
        "any.required": "selectors.item is required (container CSS selector)",
      }),
    fields: Joi.object()
      .pattern(Joi.string().max(100), fieldSchema)
      .min(1)
      .required()
      .messages({
        "any.required": "selectors.fields must have at least one field",
      }),
    linkSelector: Joi.string().allow("", null).default(null),
    detailFields: Joi.object()
      .pattern(Joi.string().max(100), fieldSchema)
      .default({}),
    keyField: Joi.string().allow("", null).default(null),
  }).required(),

  pagination: paginationSchema.default({}),

  schedule: Joi.object({
    enabled: Joi.boolean().default(false),
    cron: Joi.string().when("enabled", { is: true, then: Joi.required() }),
    runOnce: Joi.boolean().default(false),
  }).default({}),

  proxy: Joi.object({
    enabled: Joi.boolean().default(false),
    rotate: Joi.boolean().default(true),
    proxyId: Joi.string().hex().length(24).allow(null),
  }).default({}),

  options: Joi.object({
    timeout: Joi.number().integer().min(1000).max(120000).default(30000),
    retries: Joi.number().integer().min(0).max(10).default(3),
    delay: Joi.number().integer().min(0).max(30000).default(1000),
    headers: Joi.object().pattern(Joi.string(), Joi.string()).default({}),
    cookies: Joi.string().allow("", null),
    antiBot: Joi.boolean().default(true),
    ajaxHeader: Joi.boolean().default(false),
    jsonHtmlField: Joi.string().allow("", null).default(null),
    jsonPath: Joi.string().allow("", null).default(null),
    crawl: Joi.object({
      enabled: Joi.boolean().default(false),
      selector: Joi.string().allow("", null).default("a[href]"),
      urlTemplate: Joi.string().allow("", null).default(null),
      jsonPath: Joi.string().allow("", null).default(null),
      maxDepth: Joi.number().integer().min(0).max(100).default(3),
      maxRequests: Joi.number().integer().min(0).default(0),
      sameOrigin: Joi.boolean().default(true),
    }).default({}),
  }).default({}),

  notification: Joi.object({
    enabled: Joi.boolean().default(false),
    url: Joi.string().uri().allow("", null).default(null),
    method: Joi.string().valid("POST", "PUT", "PATCH", "GET").default("POST"),
    headers: Joi.object().pattern(Joi.string(), Joi.string()).default({}),
  }).default({}),

  subTasks: Joi.object({
    enabled: Joi.boolean().default(false),
    intervalMinutes: Joi.number().integer().min(1).max(525600).default(60),
    cron: Joi.string().allow("", null).default(null),
  }).default({}),

  tags: Joi.array().items(Joi.string().max(50)).default([]),
});

const updateTaskSchema = createTaskSchema.fork(
  ["name", "url", "selectors"],
  (s) => s.optional(),
);

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });
  if (error) {
    return res.status(400).json({
      success: false,
      message: "Validation error",
      errors: error.details.map((d) => ({
        field: d.path.join("."),
        message: d.message,
      })),
    });
  }
  req.body = value;
  next();
};

module.exports = {
  validateCreate: validate(createTaskSchema),
  validateUpdate: validate(updateTaskSchema),
};
