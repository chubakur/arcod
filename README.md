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

cd examples/onetimemessage     # без пароля
# или
cd examples/onetimemessage-pwd # с необязательным паролем (--port 8081)
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
| `arcod build --impl` | тела из `impl/*.mjs`, адаптер `io`, ничего не додумывает |
| `arcod build --reference` | то же плюс встроенные демо-тела `create`/`read` |
| `arcod test [dir]` | поднимает сгенерированный сервис с in-memory kv и прогоняет `examples` |
| `arcod make [dir]` | весь цикл одной командой: check → prompts → тела → build → test |
| `arcod run [dir]` | build + `docker compose up --build` |
| `arcod run --down` | останавливает окружение |

Флаги: `--json`, `--env <name>`, `--port <n>`, `--detach`, `--down`.
У `make`: `--force` (перегенерировать тела), `--skip-impl`, `--no-test`,
`--model`, `--endpoint`, `--reference`.

```bash
arcod make .            # первая сборка с нуля
arcod make . --force    # заново сгенерировать тела
arcod make . --skip-impl --no-test   # только check + prompts + build
```

Каждый шаг — та же функция, что и у отдельной команды, поэтому конвейер не
расходится с ними. Останавливается на первой ошибке и печатает, где именно.

## Провайдеры

Модель называет возможность (`kv`, `sql`, `queue`…), окружение — провайдера
(`redis`, `postgres`, `kafka`…). Компилятор знает, какой провайдер реализует
какую возможность, и проверяет это (`A023` неизвестный, `A024` несовместимый,
`A025` двойной bind).

```arcod
environment dev {
  bind db -> postgres(host: "db", expose: true)
  bind files -> s3(host: "s3")
  bind events -> kafka(host: "kafka")
}
```

```bash
arcod providers            # таблица возможностей и провайдеров
```

Реестр: redis, postgres, mysql, mariadb, mongodb, keycloak, s3 (minio), rabbitmq,
kafka, nginx, liquibase, clickhouse, prometheus, sentry, jaeger, grafana, mailpit,
vault. На каждый bind генерируется
сервис в compose с healthcheck, томом и env; порты публикуются только при
`expose: true`.

Провайдер может быть внешним: `bind errors -> sentry(dsn: "...")` не создаёт
контейнер, но добавляет `SENTRY_DSN` в окружение сервиса; без `dsn` — ошибка
`A026`.

Адаптер в рантайме пока есть только у `kv`/`redis` — остальные провайдеры
поднимаются, но телу недоступны. Это следующая итерация.

## Режимы сборки

```bash
arcod build              # scaffold: обработчики возвращают 501, тела помечены TODO
arcod build --reference  # reference: встроенные тела create/read поверх kv
arcod build --impl       # тела из impl/*.mjs через адаптер io
arcod run                # reference, чтобы демо работало
arcod run --impl         # поднять сервис с телами модели
arcod run --scaffold     # поднять скелет: healthz работает, операции — 501
```

Scaffold — это то, что компилятор действительно выводит из модели: маршруты, конфиг, адаптеры, ошибки, ограничения и инфраструктура. Тела операций в него не входят.

## Промпты и локальная модель

Компилятор не только пишет код: он выпускает **детерминированные промпты** — по
одному на операцию.

```bash
arcod build              # .arcod/build/prompts/<op>.md + manifest.json
arcod prompts --json     # только промпты, с токенами и sha256
```

Промпт — это сигнатура функции, а не описание сервиса. Для примеров:

```text
create(input, io)
in: { body: string /* 1..65536 bytes */, password: string | null /* 1..128 chars */ }
out: { result: string } | { error: "Invalid" }
io: new() -> id; hash(password); set(id, value)
value: {b: string, h: string|null}; h = password hash or null
```

66 токенов для `create`, 109 для `read`. Ни маршрутов, ни других операций, ни
инфраструктуры: всё постоянное («один файл, без импортов, без HTTP») уходит в
системный промпт модели. `--full` возвращает подробный формат (324/367 токенов)
для сравнения. `--max-tokens` роняет сборку, если бюджет превышен.

```bash
arcod impl --model qwen2.5-coder:7b --endpoint http://localhost:11434
arcod impl --dry-run          # показать, что будет отправлено
```

Проверено на `qwen2.5-coder:7b`: 2/2 тела для обоих примеров, семантика
верна (9 проверок с паролем, 4 без), два прогона с `--no-cache` дали
побайтово одинаковый результат. Без строки `steps` модель путала
жизненный цикл `read` — сообщение не расходовалось.

`impl` отправляет промпты в Ollama (`temperature=0`, фиксированный `seed`,
`num_ctx=4096`), проверяет ответ — нет импортов, нет HTTP, синтаксис
`node --check` — и кеширует по `sha256(model, params, prompt)`. Модель не
выбирает библиотеки: она видит только `io.*`, а провайдера подставляет
окружение.

```bash
ollama pull qwen2.5-coder:7b
```

Облачных провайдеров нет: эндпоинт по умолчанию локальный, нелокальный адрес
отклоняется без `--allow-remote`. Токены не тратятся.

Процедуру для тела выводит компилятор (`src/plan-body.ts`) из модели: наличие
параметра-`uuid` даёт `load`, `ids.new`+`kv.set` — `new` и `save`, `once` и
`atomic` — `takeIf`, а `on error E: store.has(id)` означает «проверка не
расходует запись» и ставит `verify` перед потреблением. Имена операций не
используются. Если шаг вывести нельзя, сборка промптов падает с `unresolved`,
а не догадывается.

Тела подключаются командой `arcod build --impl`: компилятор вставляет их в
сервис, собирает адаптер `io` (записи `{b, h}`, сравнение и удаление через
`takeIf`, scrypt) и оставляет маршруты, статусы и лимиты за собой.

Форма в UI строится из параметров `create`: `name`/`author` дают поле
«Имя», крупные `bytes` — `textarea`, `password` — отдельный блок у guarded-
сервиса. Поля валидируются по `min`/`max` типа.

Payload — все параметры, кроме `uuid`-идентификатора и `password`: одно
значение кладётся в `b` как есть, несколько — объектом, поэтому
`-> { author: Author, body: Body }` возвращается из `read` как JSON. Кортежей
в языке нет: `(A, B)` не разбирается.

Тела без файла в `impl/` отвечают `501`.

```bash
arcod impl examples/onetimemessage-pwd --model qwen2.5-coder:7b
arcod test --impl examples/onetimemessage-pwd   # 5 passed
arcod run --impl examples/onetimemessage-pwd
```

В `examples/*/impl/` лежат тела, сгенерированные qwen2.5-coder:7b и проверенные
тестами, — демо воспроизводится без Ollama.

`arcod impl` пишет тела в `impl/` рядом со спекой (это то, что читает
`arcod build --impl` и что стоит коммитить); старое место `.arcod/impl/`
тоже подхватывается.

## Что генерируется

Для `examples/onetimemessage` и `examples/onetimemessage-pwd`: что выводится из модели, а что остаётся шаблоном — см. «Режимы сборки».

Два примера отличаются только моделью: `create(body, password?)`,
`read(id, password?)`, ошибка `WrongPassword`, `on error WrongPassword: store.has(id)`
и возможность `hash(scrypt)`. Маршруты, TTL, лимиты и инфраструктура совпадают.

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
- `W018` тела операций не заданы в спеке: их даёт `arcod impl`, `--reference` или `TODO` в scaffold;
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
  onetimemessage/     одноразовые сообщения
  onetimemessage-pwd/ то же, но с необязательным паролем
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
- **В спеке нет тел операций** (`W018`): `build` по умолчанию даёт scaffold с TODO, `--impl` берёт тела из `impl/`, `--reference` подставляет встроенный демо-шаблон.

## Лицензия

MIT
