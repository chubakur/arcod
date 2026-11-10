# Arcod

Спецификация сервиса → работающий сервис. Без ручного выбора библиотек, без расхождения кода и модели.

Arcod — это язык описания и компилятор. Вы пишете `.arc`-файл: типы, операции, ошибки, правила, эффекты, привязки к инфраструктуре. Компилятор проверяет модель, строит план работ и генерирует код, тесты и окружение.

```arcod
service OneTimeMessage : http {
  uses store: kv(ttl: 999s)
  uses uuid: ids

  contract {
    public op create(body: Body) -> MessageId {
      route: "POST /api/messages"
      errors: Invalid
    }

    public op read(id: MessageId) -> Body {
      route: "GET /api/messages/:id"
      errors: NotFound, Gone
      post: !store.has(id)
    }
  }

  rules {
    invariant read.at_most_once: once(read, by: id)
    atomic read { get; del }
  }

  effects { allow store.get, store.set, store.del, store.has, uuid.new }
}

ui Web {
  kind:  spa
  route: "/"
  uses  OneTimeMessage.create, OneTimeMessage.read
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  deploy docker
}
```

Фронтенд появляется только если объявлен `ui`. Нет `ui` — генерируется только API и порт сервиса.

## Быстрый старт

Нужны Node.js >= 22.18 и Docker.

```bash
git clone git@github.com:chubakur/arcod.git
cd arcod
npm link            # ставит команду arcod глобально

cd examples/onetimemessage
arcod run
```

Откройте <http://localhost:8080>. Создайте сообщение, скопируйте ссылку, откройте её. Второй раз — 410 Gone.

Остановить:

```bash
arcod run --down
```

Без `npm link`:

```bash
node ../../bin/arcod.mjs run
```

## Команды

| Команда | Что делает |
|---|---|
| `arcod check [dir]` | парсит, проверяет типы, привязки, эффекты, правила; JSON через `--json` |
| `arcod ast [dir]` | печатает канонический AST |
| `arcod plan [dir]` | детерминированный DAG задач: файлы, зависимости, критерии приёмки |
| `arcod build [dir]` | scaffold: маршруты, адаптеры, тесты, инфраструктура в `.arcod/build`; тела — TODO |
| `arcod build --reference` | то же плюс встроенные демо-тела `create`/`read` |
| `arcod test [dir]` | поднимает сгенерированный сервис с in-memory kv и прогоняет `examples` |
| `arcod run [dir]` | build + `docker compose up --build` |
| `arcod run --down` | останавливает окружение |

Флаги: `--json`, `--env <name>`, `--port <n>`, `--detach`, `--down`.

## Режимы сборки

```bash
arcod build              # scaffold: обработчики возвращают 501, тела помечены TODO
arcod build --reference  # reference: встроенные тела create/read поверх kv
arcod run                # reference, чтобы демо работало
arcod run --scaffold     # поднять скелет: healthz работает, операции — 501
```

Scaffold — это то, что компилятор действительно выводит из модели: маршруты, конфиг, адаптеры, ошибки, ограничения и инфраструктура. Тела операций в него не входят.

## Что генерируется

Для `examples/onetimemessage`:

- `.arcod/build/service/index.mjs` — HTTP-сервис на Node без зависимостей, с минимальным RESP-клиентом;
- `.arcod/build/web/` — статический фронтенд и nginx с проксированием `/api` (только при объявленном `ui`);
- `.arcod/build/docker-compose.yml` — redis + сервис + фронтенд.

`budget { concurrency: N }` даёт лимитер in-flight запросов: сверх лимита — `503`.

`atomic read { get; del }` переключает чтение на атомарный Lua-скрипт; без правила генерируются раздельные `GET` и `DEL`. `once(read, by: id, else: Gone)` задаёт ошибку повторного чтения — эмиттер берёт её из модели, а не из константы.

Правила из спеки превращаются в поведение: `atomic read { get; del }` — в Lua-скрипт с гетом и удалением, `once(read, by: id)` — в tombstone-ключ, который даёт `Gone` при повторном чтении.

## Проверки

Реализованы диагностики:

- `A002` возможность не привязана в `environment`;
- `A003` провайдер, хост или секрет упомянут в модели;
- `A004` эффект используется, но не разрешён;
- `A005` write-вызов в инварианте;
- `A007` объявленная ошибка не обработана и не покрыта примером;
- `A008` бюджет без метрики;
- `A009` дублирующийся алиас;
- `A010` цикл в `ordering`;
- `W011` возможность объявлена, но не используется;
- `W012` операция без примеров;
- `W013` бюджет не задан;
- `W015` ошибка объявлена, но нигде не используется;
- `A018` `ui` ссылается на несуществующую операцию или операцию без `route`;
- `A019` `ui` с неподдерживаемым `kind` (в v0.1 только `spa`);
- `A020` эффект одновременно в `allow` и `deny`;
- `A021` запрещённый эффект используется;
- `W016` `deny` для нативного эффекта (`net`, `fs`, `exec`) не исполняется;
- `W017` `job` не исполняется в v0.1;
- `W018` тело операции — встроенный шаблон, не выведено из модели;
- `A022` `once(..., else: E)` ссылается на ошибку вне контракта.

`arcod check` возвращает `1` при ошибках и `0`, когда модель чистая.

## Структура

```
src/
  lexer.ts        токены и позиции
  parser.ts       ручной recursive descent + Pratt для выражений
  ast.ts          канонический AST
  check.ts        статические проверки
  plan.ts         DAG задач
  build.ts        сборка примера в .arcod/build
  emit/service.ts генерация сервиса
  emit/web.ts     генерация фронтенда
  emit/compose.ts Dockerfile и compose
  cli.ts          команды
examples/
  onetimemessage/ живой пример
test/             node --test
```

Запуск тестов:

```bash
npm test
```

## Ограничения v0.1

Это вертикальный срез, а не готовый язык.

- Эмиттер поддерживает только сервисы с операциями `create` и `read` поверх `kv`.
- Провайдер `kv` — только Redis.
- `arcod fmt`, `arcod diff`, `arcod adopt` ещё не реализованы.
- `arcod test` не исполняет `given`; из предикатов поддерживает только `once`.
- `unique` и `ordering` пока не проверяются глубже синтаксиса и циклов.
- Генерация только в JavaScript/Node. PHP, Go и Python — отдельные эмиттеры позже.
- `change`, `unknown` и `external` парсятся, но не влияют на сборку.
- `lifecycle`, `ordering` и предикаты, кроме `once`, пока декларативны.
- `ui` поддерживает только `kind: spa` и генерирует страницу под операции `create`/`read`; произвольная вёрстка не выражается.
- `budget.latency` и `budget.cost` — декларативные SLO, runtime-проверки для них ещё нет.
- `effects.deny` для `net`, `fs`, `exec` декларативен: рантайм его не применяет (`W016`).
- `job` парсится, но не исполняется (`W017`): в языке нет модели состояния и условия выборки, поэтому «expired» не определён. TTL — гарантия провайдера `kv`.
- **Тела `create` и `read` не выводятся из модели** (`W018`). По умолчанию `build` даёт scaffold с TODO; готовые тела появляются только под `--reference` и являются демо-шаблоном.

## Лицензия

MIT
