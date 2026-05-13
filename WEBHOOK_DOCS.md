# Webhook Notification — Документація

## Огляд

Коли включена опція **Webhook Notification**, парсер автоматично відправляє HTTP-запит на зовнішній URL кожного разу, коли знаходить новий або змінений контент.

## Налаштування

### У формі задачі:

1. **Вкладка "Додатково"** → прокрутити донизу до **"Відправляти сповіщення про новий контент"**
2. Включити чекбокс
3. Заповнити поля:
   - **URL вебхука** — куди надсилати дані (обов'язково)
   - **HTTP метод** — POST/PUT/PATCH/GET (за замовч. POST)
   - **Додаткові заголовки** — JSON з заголовками типу `Authorization`

### Приклад конфігурації:

```json
{
  "notification": {
    "enabled": true,
    "url": "https://api.example.com/webhooks/parser",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer sk_live_xxxxx",
      "X-API-Key": "your-api-key",
      "Content-Type": "application/json"
    }
  }
}
```

## Payload структура

Кожен webhook-запит містить:

```json
{
  "taskId": "507f1f77bcf86cd799439011",
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "source": "page|crawl|template",
  "event": "new_content",
  "timestamp": "2026-04-19T10:30:45.123Z",
  "items": [
    {
      "url": "https://example.com/product/123",
      "detailUrl": "https://example.com/product/123/details",
      "page": 1,
      "seq": 0,
      "data": {
        "name": "Product Name",
        "price": "99.99",
        "description": "..."
      },
      "fieldChanges": [
        {
          "fieldName": "price",
          "oldValue": "89.99",
          "newValue": "99.99",
          "changedAt": "2026-04-19T10:30:00.000Z"
        }
      ],
      "status": "ok"
    }
  ]
}
```

### Поля:

| Поле        | Опис                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `taskId`    | ID задачи парсера                                                                                   |
| `runId`     | Унікальний ID цього запуску парсера                                                                 |
| `source`    | Джерело даних: `page` (основна сторінка), `crawl` (рекурсивний обхід), `template` (шаблонний запит) |
| `event`     | Тип события (поки що тільки `new_content`)                                                          |
| `timestamp` | ISO дата-час відправлення                                                                           |
| `items`     | Масив знайдених/змінених записів                                                                    |

#### items[] поля:

| Поле           | Опис                                               |
| -------------- | -------------------------------------------------- |
| `url`          | URL сторінки, з якої був витягнутий запис          |
| `detailUrl`    | URL деталей (якщо є посилання на сторінку деталей) |
| `page`         | Номер сторінки                                     |
| `seq`          | Номер запису на сторінці                           |
| `data`         | Витягнуті дані (об'єкт з полями селекторів)        |
| `fieldChanges` | Масив змін полів (якщо це не перший запуск)        |
| `status`       | Статус парсингу (`ok`, `error` тощо)               |

## Приклади обробки

### Node.js/Express

```javascript
app.post("/webhooks/parser", (req, res) => {
  const { taskId, runId, items, source, timestamp } = req.body;

  console.log(`[${timestamp}] Webhook from parser task ${taskId}`);
  console.log(`New items: ${items.length}`);

  // Обробити дані
  items.forEach((item) => {
    if (item.fieldChanges?.length > 0) {
      console.log(`Changes detected in ${item.url}:`, item.fieldChanges);
    }
    // Зберегти в БД, відправити email тощо
    saveToDatabase(item.data);
  });

  res.json({ success: true });
});
```

### Python/Flask

```python
from flask import Flask, request

app = Flask(__name__)

@app.route('/webhooks/parser', methods=['POST'])
def handle_webhook():
    data = request.json
    task_id = data['taskId']
    items = data['items']

    for item in items:
        print(f"Received item from {item['url']}")
        if item.get('fieldChanges'):
            print(f"Fields changed: {[c['fieldName'] for c in item['fieldChanges']]}")
        # Обробити...

    return {'success': True}
```

### Go

```go
func handleWebhook(w http.ResponseWriter, r *http.Request) {
    var payload struct {
        TaskID    string `json:"taskId"`
        RunID     string `json:"runId"`
        Items     []Item `json:"items"`
        Timestamp string `json:"timestamp"`
    }

    json.NewDecoder(r.Body).Decode(&payload)

    for _, item := range payload.Items {
        // Обробити кожен item...
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]bool{"success": true})
}
```

## Retry логіка

- Таймаут вебхука: **15 секунд**
- Якщо помилка або таймаут — логується, але не зупиняє парсинг
- Нові спроби не робляться автоматично

## Безпека

1. **HTTPS рекомендовано** — завжди використовуй HTTPS для продакшену
2. **Аутентифікація** — додай `Authorization` або інші заголовки
3. **Перевірка підпису** (не реалізовано в базовій версії)

## Тестування

### curl

```bash
curl -X POST https://api.example.com/webhooks/parser \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "test-id",
    "runId": "test-run-id",
    "source": "page",
    "event": "new_content",
    "timestamp": "2026-04-19T10:30:45Z",
    "items": [{
      "url": "https://example.com",
      "data": {"name": "Test"},
      "fieldChanges": [],
      "status": "ok"
    }]
  }'
```

### Webhook.site (для тестування)

1. Перейти на https://webhook.site
2. Скопіювати згенерований URL
3. Вставити в поле "URL вебхука" в задачі
4. Запустити парсинг
5. Дані буде видно на сайті webhook.site в реальному часі
