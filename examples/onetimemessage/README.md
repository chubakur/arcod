# OneTimeMessage

Пример на языке Arcod: одноразовые сообщения.

## Запуск

```bash
arcod run
# http://localhost:8080
```

Остановить:

```bash
arcod run --down
```

## Что проверяет пример

- `create` принимает текст, валидирует длину и возвращает UUID;
- `read` атомарно читает и удаляет сообщение;
- повторное чтение возвращает `410 Gone`, неизвестный id — `404 NotFound`;
- `post: !store.has(id)` описывает постусловие успешного чтения;
- `invariant read.at_most_once: once(read, by: id)` и `atomic read { get; del }` — правила, из которых генерируется Lua-скрипт;
- `environment dev` привязывает `kv` к Redis и `ids` к локальному генератору.

## API

| Метод | Путь | Ответ |
|---|---|---|
| `POST` | `/api/messages` | `201 {"id":"...","expiresIn":999}` или `400 Invalid` |
| `GET` | `/api/messages/:id` | `200 text/plain`, `404 NotFound`, `410 Gone` |
| `GET` | `/healthz` | состояние сервиса и kv |

## Файлы

- `main.arc` — единственный источник истины;
- `.arcod/build` — сгенерированные артефакты, в git не попадают.
