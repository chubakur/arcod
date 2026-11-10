# GuardedMessage — одноразовое сообщение с паролем

Тот же одноразовый просмотр, что в `onetimemessage`, но при создании можно
задать пароль. Без пароля сообщение открывается по ссылке; с паролем — только
после проверки. Неверный пароль **не расходует** сообщение.

Проект существует отдельно, чтобы разница между двумя сервисами читалась в
модели, а не в коде.

## Запуск

```bash
arcod run --port 8081
# http://localhost:8081
```

Остановить:

```bash
arcod run --down --port 8081
```

## Чем отличается от onetimemessage

| | `onetimemessage` | `onetimemessage-pwd` |
|---|---|---|
| `create` | `(body)` | `(body, password?)` |
| `read` | `(id)` | `(id, password?)` |
| ошибки | NotFound, Gone, Invalid | + `WrongPassword` |
| правило | `once(read, by: id, else: Gone)` | то же + `on error WrongPassword: store.has(id)` |
| возможности | kv, ids | + `hash(scrypt)` |
| хранение | текст как есть | `scrypt`-хеш с солью |

Всё остальное совпадает: маршруты, TTL, лимит тела, атомарное чтение,
генерация фронтенда и docker-compose.

## API

| Метод | Путь | Ответ |
|---|---|---|
| `POST` | `/api/messages` | `201 {"id":"..."}`; тело JSON `{"body":"...","password":"..."}`, пароль необязателен |
| `GET` | `/api/messages/:id` | `200 text/plain`, `403 WrongPassword`, `404 NotFound`, `410 Gone` |
| `GET` | `/api/messages/:id?password=...` | то же, с проверкой пароля |
| `GET` | `/healthz` | состояние сервиса и kv |

Заголовок `x-password` работает как альтернатива query-параметру.

## Проверка

```bash
arcod test examples/onetimemessage-pwd
```

`guarded_roundtrip` проверяет главное: неверный пароль возвращает
`WrongPassword`, сообщение остаётся, правильный пароль отдаёт текст, повторное
чтение даёт `Gone`.

## Файлы

- `main.arc` — единственный источник истины;
- `.arcod/build` — сгенерированные артефакты, в git не попадают.
