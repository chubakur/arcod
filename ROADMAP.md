# Roadmap Arcod

Дата: 2026-11-11  
Статус: рабочий roadmap после аудита v0.1

## Цель

Перейти от сильного вертикального среза к инструменту, применимому к большинству современных backend/full-stack задач.

Критерий зрелости: `.arc`-спека должна описывать не только контракт и инфраструктуру, но и **поведение, данные, права, интеграции и эксплуатацию** сервиса.

## Принципы

1. **Сначала P0, потом экосистема.** Не добавлять новые UI-layouts, провайдеры «только инфраструктура» и мультиязыковые эмиттеры, пока не закрыты данные, authZ, API-контракт, асинхронность и observability.
2. **Каждая фича заканчивается работающим срезом.** Для каждой задачи нужны: синтаксис/AST, проверки, runtime/эффект, пример, тест, документация.
3. **Модель не называет провайдеров.** Провайдер выбирается окружением; в спеке не должно быть хостов, вендоров и секретов.
4. **То, что спека обещает, runtime должен исполнять или честно диагностировать.** Декларативные заготовки допустимы только с warning и понятным планом доведения.

---

## P0 — блокеры применимости

### 1. OpenAPI и внешний контракт API

**Статус: реализовано (2026-11-11).** `arcod openapi [dir|spec.arc] [--service name]` — OpenAPI 3.1 из `types`/`errors`/`route`/`public`/`examples`; nominal-схемы в `components.schemas`, operationId `<service>.<op>`, error mapping общий с runtime, примеры из `examples`-блока; public op без route ловится новым кодом `A041`; внешние сервисы экспортируются через `--service`. Тесты: изменение типа меняет схему, изменение route меняет path, error mapping сохраняется.

**Проблема:** сгенерированный сервис доступен только по ad-hoc HTTP routes. Нет OpenAPI, SDK, webhook-контракта и стабильного способа интеграции.

**Сделать:**

- Команда `arcod openapi [dir]`.
- Генерация OpenAPI 3.1 из `types`, `errors`, `route`, `public`, `examples`.
- JSON Schema для параметров, ответов и ошибок.
- Стабильные operationId: `<service>.<op>`.
- Экспорт примеров как `examples` в OpenAPI.
- Валидация: спека без `route` у публичной операции не должна попадать в OpenAPI.

**Готово, когда:**

- Для всех примеров генерируется валидный OpenAPI.
- Для одного внешнего сервиса можно сгенерировать клиент по OpenAPI и вызвать его без ручного чтения `.arc`.
- Есть тест: изменение типа меняет схему; изменение route меняет path; error mapping сохраняется.

---

### 2. AuthZ в языке, а не в телах операций

**Статус: реализовано (2026-11-11), базовый уровень.** Декларативная модель: `auth op` (anonymous → 401), клаузы `roles: ...` (403, словарь сервиса `roles:` проверяется компилятором, A047) и `owner: <param>` (запись должна принадлежать actor'у, admin bypass, отсутствующая запись → 404). Guard генерируется в runtime до вызова body (таблица AUTHZ + authorize() в impl-режиме). Проверки: A046 (guarded op без identity), A048 (public op не должен требовать actor), A049 (owner без такого параметра). `examples/files` переведён: upload/users — `auth op`, setVisibility — `owner: id`; visibility-матрица осталась в body как resource-level политика (canRead). W016 закрыт для нативных deny (net/fs/exec) — validateBody теперь режет imports/require/fetch/WebSocket/dynamic-import/env; для deny целого capability warning сохраняется. Роли из токена (roles в actor) готовы к использованию; tenant-level правила — за пределами v0.2.

**Проблема:** сейчас есть только authN (`identity`), а права копируются руками в bodies (`examples/files/impl/*`). `policy` парсится, но не влияет на сборку.

**Сделать:**

- Минимальную декларативную модель доступа:
  - `public op ...`
  - `auth op ...`
  - `roles: admin, manager`
  - `owner`, `tenant`, `resource`-level правила — если получается без переусложнения v0.2.
- Проверки компилятором:
  - у guarded operation есть actor source;
  - роль существует;
  - public operation не требует actor;
  - operation с `identity` не остаётся публичной случайно.
- Runtime guard до вызова body:
  - anonymous → `401`;
  - authenticated but not allowed → `403`;
  - resource policy fail → `403` или declared domain error.
- Перевести `examples/files` с ручного `canRead` на декларативную политику, оставив body чистым.

**Готово, когда:**

- Политика проверяется в generated runtime до вызова body.
- Примеры покрывают anonymous / user / admin / owner / other tenant.
- Ручной доступ к `io.actor()` в body не требуется для стандартных guard-проверок.
- `W016` либо закрыт enforcement, либо превращён в error для нативных deny.

---

### 3. Настоящая модель данных

**Статус: готово (2026-11-12) — запись, unique, find, курсор и schema-aware SQL.**
Тип-запись — хранилище: `io.insert/fetch/update/remove` держат запись, `io.find`
фильтрует (`eq`, `ne`, `in`, `gt/gte/lt/lte`, `contains`), сортирует и листает
keyset-курсором. `rules { unique Task.title }` проверяется компилятором
(`A054`–`A056`) и исполняется адаптером: дубль — `Conflict` (409), не 500.

На `sql`-драйвере запись теперь лежит в осознанной таблице, а не блобом:
`arcod migrate` генерирует типизированные колонки и `UNIQUE KEY`, рантайм пишет
и читает через один codec (`sqlLiteral`/`readCell`), `find` уходит в SQL
(`WHERE`/`ORDER BY`/`LIMIT` + keyset-предикат), unique — constraint БД
(ER_DUP_ENTRY → `Conflict`), а не claim-ключ. `datetime` ходит как
`DATETIME(3)` туда и ISO-строкой обратно; числа — как числа. Проверено на
MySQL 8.4: строки в таблице `task`, `arcod_kv` пуст, фильтр/сортировка/
курсор/дубль 409/404 работают. `kv`-драйвер (память/Redis) оставлен на blob+claim.

Осталось из модели данных: значения по умолчанию на уровне схемы и
constrained-типы (`email`, `url`) — мелочь; индексы за пределами unique.


Тип-запись теперь и есть хранилище: `io.insert/fetch/update/remove` держат запись и
unique-claim вместе, `io.find(entity, { where, order, limit, cursor })` фильтрует
(`eq`, `ne`, `in`, `gt/gte/lt/lte`, `contains`), сортирует по нескольким полям и
листает keyset-курсором. `rules { unique Task.title }` проверяется компилятором
(`A054`–`A056`) и исполняется адаптером: дубль — объявленный `Conflict` (409), а
не 500. Claim атомарный на всех трёх драйверах: `SET NX` в Redis, проверка в
памяти, `INSERT IGNORE` в MySQL. Типы `datetime` и `decimal` доехали до OpenAPI
(`date-time`, `number/decimal`). Примеры: `examples/tasks` (kv) и
`examples/tasks-sql` (sql) делят одни тела; оба проходят `arcod test --impl`,
одинаково ведут себя на Redis, памяти и MySQL.

Осталось: значения по умолчанию на уровне схемы, индексы и осознанная SQL-таблица
на запись вместо `arcod_kv`, pushdown фильтра/сортировки (сейчас `find` сканирует
namespace), constrained-типы (`email`, `url`, `enum`) и вторая реализация SQL
(postgres-провайдер пока провижинится, но адаптер говорит по MySQL-протоколу).

**Проблема (на момент аудита):** `kv` и `sql` сейчас — запись `{b,h}` по id. Это не хватает для реальных доменов.

**Сделать:**

- Типы полей: `datetime`, `decimal`, `map<K,V>`, дискриминированные union'ы, constrained string/email/url/enum.
- Storage model в спеке:
  - entity/record shape;
  - поля, обязательность, значения по умолчанию;
  - индексы;
  - unique constraints;
  - ownership/tenant keys, если закрыт пункт authZ.
- Эффекты хранения выше blob-by-id:
  - `get`, `put`, `delete`;
  - `find` с filter/sort/pagination;
  - `count`;
  - `update`;
  - optimistic concurrency / compare-and-set.
- Pagination как часть контракта: `limit`, `cursor`, `next`, `total?`.
- `unique` и `ordering` перестают быть синтаксическими декларациями.

**Готово, когда:**

- Хотя бы один пример показывает список с фильтром, сортировкой и курсорной пагинацией.
- Нарушение unique даёт declared error, а не 500.
- Один и тот же body работает на двух `sql`-провайдерах без изменений.

---

### 4. Миграции и транзакции

**Статус: генерация + применение готово (2026-11-12); транзакционные сценарии — нет.**
Миграции теперь генерируются из модели данных и применяются детерминированно:

- `arcod migrate [dir]` пишет `.arcod/build/migrations/` — `changelog.json` и
  `NNNN_name.up.sql`/`.down.sql`. Для каждой записи-типа: осознанная
  `CREATE TABLE` с типизированными колонками (`uuid` → `CHAR(36)`,
  `datetime` → `DATETIME(3)`, `int` → `BIGINT`, `decimal` →
  `DECIMAL(30,6)`, строки → `TEXT`/уникальные → `VARCHAR(191)`), `PRIMARY KEY`
  по `id` и `UNIQUE KEY` на каждое `rules { unique ... }`.
- Контракт: `version`, `checksum` (sha256 от up+down), `up`/`down`.
- Применяет сам сгенерированный сервис при старте (sql-драйвер): таблица
  `arcod_migrations`, применение по порядку, повторный запуск — no-op,
  изменённая после применения миграция отказывается стартовать (checksum).

Проверено на MySQL 8.4: свежая БД получает `arcod_kv`+`task`+`arcod_migrations`,
повторный запуск ничего не делает, дубль title — 409.

Транзакционный publish+fact через outbox закрыт (см. раздел 5); runtime на
осознанных таблицах тоже (M0.4). Saga (линейные multi-step сценарии с
компенсацией, `saga` в модели + рантайм-раннер) закрыт; пример `examples/saga`.

**Проблема (на момент аудита):** Liquibase поднимается как контейнер, но changelog не генерируется. Транзакционность есть только в виде специализированного atomic read.

**Сделать:**

- Генерация миграций из модели данных.
- Команда/режим `arcod migrate` — dry-run и apply для dev.
- Операционный контракт миграций: версия, checksum, направление up/down, запрет редактирования применённых миграций.
- Транзакционные сценарии:
  - минимум multi-step `tx` внутри одной операции;
  - saga/outbox — отдельной задачей после async-слоя.

**Готово, когда:**

- Для `examples/files` или нового примера миграции генерируются из спеки.
- `arcod run` применяет их детерминированно.
- Повторный запуск не ломает состояние.

---

### 5. Асинхронность и события

**Статус: закрыт (2026-11-12) — M0.3 закрыт, outbox закрыт, saga закрыта, workflow — external-runner contract.** Stream: `bind stream -> redis(...)` переключает транспорт на pub/sub — реплики делят подписчиков, событие приходит ровно один раз (собственный echo приходит через брокер, локальная доставка не дублируется), reconnect переподписывается; memory-драйвер без бинда. Queue: capability с эффектами `publish`/`dead`; консьюмеры объявляются в модели — `job ... { on: alias.topic, retry: n }` — runtime владеет lifecycle (старт до http, graceful shutdown с дообработкой текущего сообщения, ack-by-completion, requeue, dead letter после retry-бюджета); драйверы memory и redis (lists, zero-dep RESP-клиент); проверки A051–A053, W017 не действует на queue-backed job'ы. Redis теперь реализует `kv` + `stream` + `queue` (extraCapabilities). e2e-тесты на fake-RESP-брокере: две реплики видят одни события, retry/dead-letter на обоих драйверах. Saga (линейные multi-step сценарии с компенсацией) тоже закрыта: `saga` в модели, рантайм-раннер с retry шага и reverse-компенсацией, триггер — job с `saga:`. Workflow runner закрыт решением: workflow — external-runner contract (граф уезжает в `deploy.<env>.json`); runtime-исполняемый линейный случай — saga.

**Проблема:** `stream` in-memory и однонаправленный; `queue`, `workflow`, `job` декларативны.

**Сделать:**

- Redis pub/sub для `stream`, чтобы реплики делили подписчиков.
- Сигнатуры эффектов для `queue`:
  - `publish`;
  - `subscribe`/`consume`;
  - `retry`, `dead letter`.
- Минимальный consumer lifecycle в runtime: start, stop, graceful shutdown, ack/nack.
- Outbox для надёжных исходящих событий/webhooks — ✅ на sql-драйвере: операция,
  которая пишет факт и публикует событие, работает в транзакции; publish кладётся
  в таблицу `arcod_outbox` (миграция `0003`), диспетчер на своей connection
  ретранслирует в брокер и помечает published. Идентификаторы SQL всегда
  бэктикаются (`q()`), так что reserved-слова (`order`) безопасны. Пример `examples/orders`.
- Saga — ✅: `saga Name { step s { call, compensate, retry } }` в модели,
  рантайм-раннер исполняет шаги по порядку, ретраит падающий шаг и на финальном
  падении компенсирует завершённые шаги в обратном порядке; триггер — job с
  `saga:`. Компенсация — терминальное состояние (не ретрай сообщения). Пример
  `examples/saga`; шаг вызывает свой op (без точки) или внешний (`Svc.op` через
  remote).
- Workflow runner — ✅ решено как external-runner contract: граф (шаги, `needs`,
  порты, триггер, `retry`/`timeout`/`onFail`) уезжает в `deploy.<env>.json`, и
  внешний runner читает его без пере-парсинга спеки. `W022` фиксирует «workflow
  описывается, не исполняется в v0.1»; runtime-исполняемый линейный случай —
  saga (см. выше), DAG — внешнему runner.
- Включить `given` в `arcod test` — ✅: секция исполняется до `when` и делится
  связываниями (`let`), результат доступен в `when`/`then`; пример `seeded_read`
  в `examples/project1` покрывает это в тестах.

**Готово, когда:**

- Две реплики сервиса видят одни и те же websocket events через Redis.
- Operation может опубликовать событие и записать факт atomically через outbox.
- Тесты покрывают retry и dead-letter behavior хотя бы на memory/fake driver.
- `workflow` либо исполняется, либо явно помечен как external-runner contract без внутренней “магии”.

---

### 6. Observability и production runtime

**Статус: observability — готово (2026-11-12); миграции — нет.**
Каждый сгенерированный HTTP-сервис теперь отдаёт прод-базлайн:

- **Structured access log** — одна JSON-строка на запрос: `method`, `route`
  (шаблон пути, не конкретный), `status`, `latency_ms`, `request_id`,
  `actor_id` (когда identity), `operation`.
- **request-id** — входящий `x-request-id` (или сгенерированный UUID)
  эхом уходит в ответ и пробрасывается в `remoteCall` через AsyncLocalStorage.
- **`/metrics`** (Prometheus text format, без зависимостей):
  `arcod_requests_total` по method/route/status, `arcod_request_duration_seconds`
  (гистограмма с бакетами), `arcod_errors_total` по operation,
  `arcod_inflight_requests` (gauge), `arcod_capability_calls_total`
  (store.insert/find/…, remote.*).
- **явные request timeouts** — `server.requestTimeout`/`headersTimeout` и
  `AbortSignal.timeout` у внешних вызовов; настраивается `ARCod_TIMEOUT_MS`
  (по умолчанию 30000).

Тесты: `/metrics`, эхо request-id и access-log покрыты интеграционно;
capability-счётчики считают store-операции и remote-вызовы.

Осталось из M0.5: миграции (`arcod migrate`, changelog, up/down, checksum) и
trace-hooks — оба закрыты (см. статус выше). M0.5 закрыт целиком.

**Проблема (на момент аудита):** Prometheus/Jaeger/Sentry/Vault провижнятся, но сгенерированный сервис почти не пишет телеметрию.

**Сделать:**

- Structured access log: method, route, status, latency, request id, actor id, operation.
- Request-id propagation: входящий header → лог → external calls.
- `/metrics` в Prometheus format: RPS, latency histogram, errors, in-flight, capability call counts.
- Trace hooks: ✅ span на operation (server span вокруг dispatch) и на внешние
  вызовы (client span вокруг `remoteCall`), parent/child через AsyncLocalStorage;
  OTEL export при `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (OTLP/JSON, zero-dep, batch
  flush). Store-операции счётчик уже покрывает (`arcod_capability_calls_total`),
  span'ы по ним — follow-up.
- Runtime enforcement для `budget`: хотя бы concurrency и max latency guard; cost — как declarative SLO.
- Graceful shutdown и drained requests.
- Security baseline:
  - CORS policy из окружения;
  - security headers;
  - SSRF guard для `endpoint`/`llm`;
  - явные request timeouts.

**Готово, когда:**

- `arcod run` поднимает сервис, у которого `/metrics` реально отдаёт полезные метрики.
- Логи содержат request-id, пробрасываемый через вызовы.
- Нагрузочный smoke-тест показывает concurrency limit и latency budget в метриках.

---

## P1 — зрелость продукта

### 7. Поведение в спецификации и sandbox для тел

**Статус: направление выбрано и закрыто (2026-11-12) — first-class `impl`-блоки + sandbox-контракт + provenance.**

**Сделать:**

- Выбрать направление — ✅: first-class `impl` blocks. Тело операции — файл
  `impl/<op>.mjs` (`export async function op(input, io)`), генерируется локальной
  моделью (`arcod impl`) или пишется руками; versioned external bodies — сам
  сгенерированный сервис (single-file, io-адаптер, прод-базлайн).
- Ограничить bodies — ✅: deny-list в `sandboxViolation`/`validateBody` (нет
  import/require, raw network, fs, exec/process, eval/Function); применяется и к
  рукописным bodies — `arcod build` падает с именем операции и причиной.
- Body provenance — ✅: сгенерированные bodies несут заголовок
  `// @arcod generated: op · prompt <sha12> · model`; build пишет
  `impl-manifest.json` (mode + op → sha256/bytes/source). «Тесты» — `arcod test`
  гоняет примеры, W012/W018 висят на операциях без покрытия/тел.
- `change`, `hint`, `unknown`, `idempotent`, `since`, `schedule` — ✅ убраны из
  публичного синтаксиса (как и `policy`/`impl`/`lifecycle`): парсер отклоняет их
  внятной ошибкой, а не игнорирует молча.

**Готово, когда:** тело операции не является скрытым непроверяемым кодом вне модели. ✅

### 8. Spec tooling: fmt, diff, adopt, migrate

**Статус: готово (2026-11-12) — canonical AST-форматтер, структурный diff, OpenAPI-импорт и шов для версионных миграций.**

- `arcod fmt` через canonical AST — ✅. `src/fmt.ts`: парс → канонический вывод
  (идемпотентность, round-trip `parse(print(x)) === x`), precedence-aware печать
  выражений (parens только где нужны), комментарии перевешиваются на следующую за ними
  декларацию (offset-маппинг). `--check` (exit 1, если не отформатировано), `--write`.
- `arcod diff` между спеками/версиями — ✅. `src/diff.ts`: обе спеки канонизируются,
  затем LCS-дифф с @@-хунками. Показывает семантику, а не шум форматирования.
- `arcod adopt` для подхвата HTTP/OpenAPI сервиса — ✅. `src/adopt.ts`: OpenAPI 3.x
  JSON → `.arc` (schemas → types/enums, paths → ops с route, parameters/requestBody →
  params, 200 → return type). Обратная операция к `arcod openapi`.
- Миграция спецификаций между версиями языка — ✅ (шов). `src/versions.ts`: реестр
  версий + цепочка миграций + `arcod upgrade [--to v] [--write]`. Реальных правил пока
  нет (язык один — 0.1.0), но движок протестирован (identity, отказ на неизвестную версию
  и на downgrade). `arcod fmt --to` применяет миграции перед форматированием.

**Готово, когда:** спека форматируется/диффится/импортируется из OpenAPI, а смена версии
языка имеет один протестированный путь переписывания. ✅

Ограничение v0.1: `fmt` канонизирует и переформатирует (record-типы в одну строку,
переупорядочивание секций), поэтому `--write` по умолчанию не трогает чужой ручной
layout без явного флага; комментарии между стейтментами и хвостовые дропаются.

### 9. Пакетирование и релизы

**Сделать:**

- `package.json`: `files`, `repository`, exports, publish script.
- GitHub release + npm publish.
- `arcod new` для скелета сервиса.
- Semver policy для CLI и language.

### 10. LSP и редакторы

**Сделать:**

- LSP server из существующих lexer/parser/check.
- VS Code extension поверх LSP.
- Neovim/JetBrains через стандартный протокол.

### 11. Тестовая матрица

**Сделать:**

- Contract tests для external services.
- Property/fuzz tests из инвариантов.
- AuthZ negative tests.
- Load/soak smoke для concurrency и latency budgets.
- Разделить монолитный тестовый файл на тематические suites.

---

## P2 — расширение охвата

- Реальные cloud deploy targets: Kubernetes manifests/Helm, Terraform, secrets из Vault, image publish.
- GraphQL/gRPC emitters.
- Python/Go/PHP emitters после стабилизации IR.
- Более богатый UI: design system, i18n, a11y, SSR; интерактивные виджеты —
  отдельным пакетом поверх языка.
- Plugin registry для capabilities/providers.
- Web console для services/workflows, если появится реальный runner.

---

## Сознательно не делаем сейчас

- Новые UI-layouts до закрытия P0.
- Интерактивные виджеты (poll/rating/comments/qr) удалены из языка v0.1: это
  продуктовая фича, а не ядро компилятора; вернутся отдельным пакетом после
  пакетной модели. Коды A042–A045 и W027 освобождены и не переиспользуются
  (коды диагностик — append-only, семейный план кодов — задача P1).
- Новые инфраструктурные провайдеры без runtime effects.
- Мультиязыковую генерацию до стабильного IR и data model.
- Сложный plugin marketplace до пакетной модели и semver.

---

## Предлагаемый порядок ближайших итераций

1. **M0.1 — OpenAPI emitter**  
   Быстрый, почти добавительный, сразу открывает интеграции.

2. **M0.2 — authZ guard**  
   Закрывает главный security gap и убирает ручной копипаст политик.

3. **M0.3 — Redis-backed stream + queue effects**  
   Делает async-слой реальным без полного workflow runner. ✅ stream-redis + queue (memory/redis), consumer lifecycle, retry/dead-letter. Outbox — в M0.5.

4. **M0.4 — data model v2**  
   Типизированные записи, query, pagination, unique, indexes.
   ✅ запись как хранилище, `insert/fetch/update/remove/find`, keyset-курсор,
   unique, `datetime`/`decimal` в OpenAPI, schema-aware SQL (типизированные
   таблицы, pushdown `find`, unique как constraint).

5. **M0.5 — migrations + observability**  
   Prod baseline: миграции, метрики, логи, request-id, timeouts.
   ✅ structured access log, request-id (in → ответ → external), `/metrics`
   Prometheus (RPS/histogram/errors/in-flight/capability calls), `ARCod_TIMEOUT_MS`,
   миграции (`arcod migrate`, checksum, идемпотентность), outbox (атомарный
   publish+fact), trace-hooks (span на operation/remote + OTEL export).

После этих пяти можно честно говорить, что Arcod подходит не только для demo-сервисов, а для большинства типовых backend-сервисов.
