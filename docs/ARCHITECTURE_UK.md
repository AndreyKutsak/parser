# Архітектура проєкту

## Загальна ідея

Проєкт поділений на три основні шари:

1. `frontend/` — інтерфейс користувача
2. `src/api/` — REST API і зовнішні точки входу
3. `src/core/` — бізнес-логіка парсингу, розкладу, підзадач і експорту

## Поточна структура

```text
src/
  app.js
  api/
    controllers/
    middlewares/
    routes/
    validators/
  core/
    exporter/
    parser/
    proxy/
    scheduler/
    subtask/
  db/
    models/
  queue/
    workers/
  server/
    createApp.js
    createVisualProxyHandler.js
  utils/
```

## Що було покращено

### Раніше

`src/app.js` одночасно відповідав за:

- створення Express-застосунку
- middleware
- swagger
- статичний frontend
- proxy для visual selector
- запуск системи

Це ускладнювало підтримку.

### Тепер

- `src/server/createApp.js` збирає Express-застосунок
- `src/server/createVisualProxyHandler.js` ізолює логіку visual selector proxy
- `src/app.js` відповідає тільки за startup і shutdown

## Frontend-архітектура

Фронтенд поки що працює на vanilla JS, але вже поділений логічно:

- `frontend/js/api.js` — клієнт для API
- `frontend/js/selector.js` — візуальний вибір елементів
- `frontend/js/app.js` — основна бізнес-логіка інтерфейсу
- `frontend/js/user-friendly.js` — UX-шар для простого режиму, пресетів і мобільної навігації

## Основні потоки

### Створення задачі

1. Користувач заповнює форму у frontend
2. `frontend/js/api.js` відправляє запит у `src/api/routes/tasks.routes.js`
3. Контролер валідує й зберігає задачу
4. Scheduler або ручний запуск ставить задачу в роботу

### Запуск парсингу

1. Задача потрапляє в queue
2. Worker обробляє її
3. `parser.service.js` обирає engine
4. Результати зберігаються в БД
5. Frontend показує записи та історію змін

## Технічний борг, який ще залишився

- `frontend/js/app.js` все ще надто великий і проситься на поділ по модулях сторінок
- у `frontend/index.html` досі є inline handlers
- варто поступово винести UI-представлення в окремі шаблонні модулі

## Рекомендований наступний крок

Найкращий наступний рефакторинг:

1. розділити `frontend/js/app.js` на модулі `dashboard`, `tasks`, `results`, `proxies`
2. замінити inline `onclick` на `addEventListener`
3. винести повторювані HTML-рендери в окремі функції-шаблони
