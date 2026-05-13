const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Web Parser Pro API",
      version: "1.0.0",
      description:
        "Універсальна платформа веб-скрейпінгу з гнучкою конфігурацією, ротацією проксі, планувальником завдань та експортом даних.",
    },
    servers: [{ url: "/api", description: "Сервер API" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        User: {
          type: "object",
          properties: {
            _id: { type: "string", description: "ID користувача" },
            username: { type: "string", description: "Ім'я користувача" },
            email: {
              type: "string",
              format: "email",
              description: "Електронна пошта",
            },
            role: {
              type: "string",
              enum: ["user", "admin"],
              default: "user",
              description: "Роль користувача",
            },
            createdAt: {
              type: "string",
              format: "date-time",
              description: "Дата створення",
            },
          },
        },
        Task: {
          type: "object",
          properties: {
            _id: { type: "string", description: "ID завдання" },
            name: { type: "string", description: "Назва завдання" },
            url: {
              type: "string",
              format: "uri",
              description: "URL для парсингу",
            },
            engine: {
              type: "string",
              enum: ["static", "dynamic"],
              description:
                "Тип двигуна: static (axios+cheerio) або dynamic (Puppeteer)",
            },
            selectors: {
              type: "object",
              properties: {
                item: {
                  type: "string",
                  description: "CSS селектор контейнера елементів",
                },
                fields: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      selector: {
                        type: "string",
                        description: "CSS або XPath селектор",
                      },
                      selectorType: {
                        type: "string",
                        enum: ["css", "xpath"],
                        default: "css",
                      },
                      attr: {
                        type: "string",
                        nullable: true,
                        description:
                          "Атрибут для витягу (наприклад, src, href)",
                      },
                      transform: {
                        oneOf: [
                          { type: "string" },
                          { type: "array", items: { type: "string" } },
                        ],
                        description: "Трансформації даних",
                      },
                      multiple: {
                        type: "boolean",
                        default: false,
                        description: "Чи витягувати кілька значень",
                      },
                    },
                  },
                },
              },
            },
            pagination: {
              type: "object",
              properties: {
                enabled: { type: "boolean", default: false },
                type: {
                  type: "string",
                  enum: [
                    "next-button",
                    "page-number",
                    "load-more",
                    "scroll",
                    "url-pattern",
                  ],
                },
                selector: { type: "string", nullable: true },
                maxPages: {
                  type: "integer",
                  minimum: 1,
                  maximum: 1000,
                  default: 10,
                },
              },
            },
            schedule: {
              type: "object",
              properties: {
                enabled: { type: "boolean", default: false },
                cron: {
                  type: "string",
                  description: "Cron вираз для планування",
                },
              },
            },
            proxy: {
              type: "object",
              properties: {
                enabled: { type: "boolean", default: false },
                rotate: { type: "boolean", default: true },
              },
            },
            options: {
              type: "object",
              properties: {
                timeout: {
                  type: "integer",
                  minimum: 1000,
                  maximum: 120000,
                  default: 30000,
                },
                retries: {
                  type: "integer",
                  minimum: 0,
                  maximum: 10,
                  default: 3,
                },
                delay: {
                  type: "integer",
                  minimum: 0,
                  maximum: 30000,
                  default: 1000,
                },
                antiBot: { type: "boolean", default: true },
              },
            },
            notification: {
              type: "object",
              description:
                "Налаштування webhook для відправлення нових/змінених результатів",
              properties: {
                enabled: {
                  type: "boolean",
                  default: false,
                  description: "Активувати відправлення сповіщень",
                },
                url: {
                  type: "string",
                  format: "uri",
                  nullable: true,
                  description: "URL вебхука для отримання даних",
                },
                method: {
                  type: "string",
                  enum: ["POST", "PUT", "PATCH", "GET"],
                  default: "POST",
                  description: "HTTP метод для відправлення",
                },
                headers: {
                  type: "object",
                  description: "Додаткові HTTP заголовки",
                  additionalProperties: { type: "string" },
                },
              },
            },
            status: {
              type: "string",
              enum: ["idle", "running", "paused", "error"],
              description: "Статус завдання",
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Proxy: {
          type: "object",
          properties: {
            _id: { type: "string", description: "ID проксі" },
            host: { type: "string", description: "Хост проксі" },
            port: { type: "integer", description: "Порт проксі" },
            protocol: {
              type: "string",
              enum: ["http", "https", "socks4", "socks5"],
              description: "Протокол проксі",
            },
            username: {
              type: "string",
              nullable: true,
              description: "Ім'я користувача для аутентифікації",
            },
            password: {
              type: "string",
              nullable: true,
              description: "Пароль для аутентифікації",
            },
            country: { type: "string", description: "Країна проксі (2 букви)" },
            status: {
              type: "string",
              enum: ["active", "inactive", "checking"],
              description: "Статус проксі",
            },
            lastChecked: {
              type: "string",
              format: "date-time",
              description: "Останнє перевірка",
            },
          },
        },
        Result: {
          type: "object",
          properties: {
            _id: { type: "string", description: "ID результату" },
            taskId: { type: "string", description: "ID завдання" },
            runId: { type: "string", description: "ID запуску" },
            data: { type: "object", description: "Витягнуті дані" },
            status: {
              type: "string",
              enum: ["success", "error"],
              description: "Статус результату",
            },
            createdAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ["./src/api/controllers/*.js", "./src/api/routes/*.js"],
};

module.exports = swaggerJsdoc(options);
