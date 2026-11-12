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

**Статус: частично (2026-11-12) — запись, unique, find и курсор есть; схема БД и индексы — нет.**
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

**Проблема:** Liquibase поднимается как контейнер, но changelog не генерируется. Транзакционность есть только в виде специализированного atomic read.

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

**Статус: частично (2026-11-11) — M0.3 закрыт, outbox и runner остались.** Stream: `bind stream -> redis(...)` переключает транспорт на pub/sub — реплики делят подписчиков, событие приходит ровно один раз (собственный echo приходит через брокер, локальная доставка не дублируется), reconnect переподписывается; memory-драйвер без бинда. Queue: capability с эффектами `publish`/`dead`; консьюмеры объявляются в модели — `job ... { on: alias.topic, retry: n }` — runtime владеет lifecycle (старт до http, graceful shutdown с дообработкой текущего сообщения, ack-by-completion, requeue, dead letter после retry-бюджета); драйверы memory и redis (lists, zero-dep RESP-клиент); проверки A051–A053, W017 не действует на queue-backed job'ы. Redis теперь реализует `kv` + `stream` + `queue` (extraCapabilities). e2e-тесты на fake-RESP-брокере: две реплики видят одни события, retry/dead-letter на обоих драйверах. Осталось: outbox (atomic publish+fact, вместе с миграциями M0.5), saga, `given` в `arcod test`, workflow runner — помечен как external-runner contract.

**Проблема:** `stream` in-memory и однонаправленный; `queue`, `workflow`, `job` декларативны; `given` не исполняется.

**Сделать:**

- Redis pub/sub для `stream`, чтобы реплики делили подписчиков.
- Сигнатуры эффектов для `queue`:
  - `publish`;
  - `subscribe`/`consume`;
  - `retry`, `dead letter`.
- Минимальный consumer lifecycle в runtime: start, stop, graceful shutdown, ack/nack.
- Outbox для надёжных исходящих событий/webhooks.
- Минимальный исполняемый `job`/`workflow` runner:
  - либо собственный `journal` + scheduler;
  - либо честно отдать граф внешнему runner, но тогда закрыть promise в docs и убрать из “рабочих” фич.
- Включить `given` в `arcod test`.

**Готово, когда:**

- Две реплики сервиса видят одни и те же websocket events через Redis.
- Operation может опубликовать событие и записать факт atomically через outbox.
- Тесты покрывают retry и dead-letter behavior хотя бы на memory/fake driver.
- `workflow` либо исполняется, либо явно помечен как external-runner contract без внутренней “магии”.

---

### 6. Observability и production runtime

**Проблема:** Prometheus/Jaeger/Sentry/Vault провижнятся, но сгенерированный сервис почти не пишет телеметрию.

**Сделать:**

- Structured access log: method, route, status, latency, request id, actor id, operation.
- Request-id propagation: входящий header → лог → external calls.
- `/metrics` в Prometheus format: RPS, latency histogram, errors, in-flight, capability call counts.
- Trace hooks: span на operation и capability calls; OTEL export при наличии env.
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

**Сделать:**

- Выбрать направление:
  - либо typed executable expressions для простых операций;
  - либо first-class `impl` blocks;
  - либо versioned external bodies с sandbox-контрактом.
- Ограничить bodies: нет raw network/fs/exec/process; только `io` capabilities.
- Body provenance: кто/чем сгенерировано, prompt hash, model, тесты.
- `change`, `hint`, `unknown`, `idempotent`, `since`, `schedule` — либо оживить, либо убрать из публичного синтаксиса.

**Готово, когда:** тело операции не является скрытым непроверяемым кодом вне модели.

### 8. Spec tooling: fmt, diff, adopt, migrate

**Сделать:**

- `arcod fmt` через canonical AST.
- `arcod diff` между спеками/версиями.
- `arcod adopt` для подхвата существующего HTTP/OpenAPI сервиса.
- Миграция спецификаций между версиями языка.

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
   unique с атомарным claim, `datetime`/`decimal` в OpenAPI; ⏳ индексы,
   SQL-схема на запись и pushdown.

5. **M0.5 — migrations + observability**  
   Prod baseline: миграции, метрики, логи, request-id, timeouts.

После этих пяти можно честно говорить, что Arcod подходит не только для demo-сервисов, а для большинства типовых backend-сервисов.
