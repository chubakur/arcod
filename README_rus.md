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

Сайт: <https://chubakur.github.io/arcod/> · Актуальная версия (английская): [README.md](README.md) · Дорожная карта: [ROADMAP.md](ROADMAP.md).

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

Файл спеки — заголовок модуля и объявления после него. В скобках заголовка
живёт один блок `meta { ... }` и больше ничего: `type`, `enum`, `error`,
`service`, `environment` и `ui` идут после закрывающей скобки. Токен, который
не `meta`, внутри скобок — объявление, написанное на скобку глубже, второй
блок `meta` или повтор ключа в нём — это ошибка разбора с локацией, поэтому
забытое объявление не может молча превратиться в пустую строку.

### Типы

Типы — часть контракта, а не аннотации для вида: из них выводятся JSON-схемы
параметров и ответов, проверки `check` и тексты промптов.

```arcod
type MessageId = uuid
type Body = { author: string, text: string, attachments: list<uuid> }
type Result = Body | NotFound          // объединение вариантов
type Password = string?                // optional

enum Visibility { draft, published, archived }
```

Есть записи `{ ... }`, `list<T>`, `bytes`, `uuid`, `datetime` (ISO-8601,
в OpenAPI — `format: date-time`), `decimal`, объединения и значения по
умолчанию у параметров (`limit: number = 20`). Длительности (`999s`, `24h`) —
значения в клаузах (`ttl: 999s`, `timeout: 30s`), а не тип.

У поля записи может быть скалярное значение по умолчанию:

```arcod
type Task = { id: TaskId, title: string, done: bool = false, dueAt: datetime? }
```

Это одно объявление на все слои: миграция пишет `DEFAULT 0`, runtime-вставка
подставляет `false`, только если тело поле не передало (явное значение,
включая `null` у optional-поля, важнее), а OpenAPI публикует `default: false`
и убирает поле из `required`. `check` отвергает всё, что не литерал типа поля
(`A059`).

Строка может нести ограничение. `email` и `url` — сокращения для
`string(format: email)` и `string(format: uri)`, а объявленный enum закрывает
множество значений:

```arcod
enum Plan { free, pro, team }
type Account = { id: uuid, email: email, website: url?, plan: Plan = "free" }
```

Ограничение попадает туда, где его читают клиенты (`format: email`,
`format: uri`, `enum`), остаётся обычной строковой колонкой в миграции и
проверяется сгенерированным сервисом до тела операции: кривой адрес, URL без
схемы или значение вне enum — это `400 Invalid` с именем поля, а не 500 из
тела, которое поверило клиенту. `check` отвергает значение по умолчанию,
нарушающее свой же тип (`A060`), и неизвестное имя формата (`A061`).
Полный пример: `examples/signup`.

## Команды

| Команда | Что делает |
|---|---|
| `arcod check [dir]` | парсит, проверяет типы, привязки, эффекты, правила; JSON через `--json`; `--strict` включает W013 (бюджет); шаблон в кавычках (`'examples/*/main.arc'`) проверяет все совпадения, печатает файл путём, не бросает прогон на файле с ошибкой разбора и падает, если ошибка есть хотя бы в одном |
| `arcod ast [dir]` | печатает канонический AST |
| `arcod plan [dir]` | детерминированный DAG задач: файлы, зависимости, критерии приёмки |
| `arcod openapi [dir]` | документ OpenAPI 3.1 в stdout: пути из `route`, схемы из `types`, ошибки как в рантайме, примеры из блока `examples`; `--service <имя>` выбирает сервис |
| `arcod migrate [dir]` | генерирует миграции из модели данных в `.arcod/build/migrations/` (changelog + up/down `.sql`); `--json`; `--dialect mysql\|postgres` выбирает диалект DDL; сервис применяет их при старте |
| `arcod build [dir]` | scaffold: маршруты, адаптеры, тесты, инфраструктура в `.arcod/build`; тела — TODO |
| `arcod build --dialect postgres` | та же сборка с postgres-клиентом, `PgStore` (entity/kv/outbox/транзакции) и postgres-миграциями; mysql по умолчанию |
| `arcod build --impl` | тела из `impl/*.mjs`, адаптер `io`, ничего не додумывает |
| `arcod build --reference` | то же плюс встроенные демо-тела `create`/`read` |
| `arcod test [dir]` | поднимает сгенерированный сервис с in-memory kv и прогоняет `examples` |
| `arcod make [dir]` | весь цикл одной командой: check → prompts → тела → build → test |
| `arcod run [dir]` | build + `docker compose up --build` |
| `arcod run --down` | останавливает то, что поднял этот проект (`docker compose down --remove-orphans`); без пересборки, артефакты `.arcod/build` остаются |
| `arcod providers` | таблица возможностей, провайдеров, портов и пакета-объявителя (`origin`, `-` для встроенных); `--json` также отдаёт объявленные опции bind (`options`) каждого провайдера; `--plugins` — манифесты на `ARC_PLUGIN_PATH`, `./.arcod/plugins`, `~/.arcod/plugins` |
| `arcod deploy [dir]` | target развёртывания и манифест `deploy.<env>.json`; `--env`, `--json` |
| `arcod k8s [dir]` | объекты Kubernetes для compose-топологии (namespace, configmap, деплойменты провайдеров, сервис, ingress); `--helm` — чарт, `--out dir` — записать файлы |
| `arcod terraform [dir]` | Terraform для облака: сеть, managed-сервисы под привязки, секреты через переменные; `--env`, `--out dir`; Yandex Cloud |
| `arcod prompts [dir]` | только промпты: `--max-tokens`, `--full` (не урезать), `--json` |
| `arcod impl [dir]` | тела операций локальной моделью: `--model`, `--endpoint`, `--dry-run`, `--no-cache`, `--allow-remote` |
| `arcod fmt [dir|pattern]` | канонический AST-форматтер в stdout; `--check` падает, если не отформатировано; `--write` перезаписывает спеку; шаблон в кавычках (`'examples/*/main.arc'`) проверяет или переписывает все совпадения, печатает файл путём и требует `--check` или `--write`; `--to <version>` сперва мигрирует. Комментарии перевешиваются на декларацию или поле, которое они предваряют (поле с комментарием делает запись многострочной), а комментарий в конце строки остаётся на своей строке |
| `arcod diff <a> <b>` | структурный diff двух спек (обе канонизируются), хунки `-`/`+` |
| `arcod graphql [dir]` | GraphQL SDL того же контракта: `GET` → Query, остальные методы → Mutation, близнецы `<Name>Input` для аргументов, HTTP-маршрут, коды ошибок и клаузулы доступа в описании поля; `--service <имя>`, `--out <файл>` |
| `arcod grpc [dir]` | proto3 того же контракта: один rpc на операцию с маршрутом, `<Op>Request`/`<Op>Response`, типы без молчаливого расширения, HTTP-маршрут и gRPC-коды ошибок в комментариях; `--service <имя>`, `--out <файл>` |
| `arcod adopt <openapi.json>` | обратная к `openapi`: читает OpenAPI 3.x JSON и выдаёт `.arc` (schemas→types/enums, paths→ops с `{id}`→`:id`, bearer-требование→`auth op`) |
| `arcod upgrade [dir]` | миграция версии языка: `--to <version>`, `--write`; сегодня версия одна (0.1.0), так что это identity или отказ на неизвестную цель |
| `arcod new <name>` | скаффолдит минимальный валидный сервис: `<name>/main.arc`, `.gitignore`, `impl/README.md` (сгенерённая спека парсится и проходит check); не пишет в непустой каталог без `--force` |
| `arcod lsp` | языковой сервер (LSP) по stdio для редакторов (VS Code, Neovim, JetBrains) |

У каждой подкоманды своя справка: `arcod <cmd> --help` печатает её и выходит 0;
неизвестный флаг — одна строка плюс `hint: arcod <cmd> --help`, exit 2.

Флаги: `--json`, `--env <name>`, `--port <n>`, `--detach`, `--down`,
`--remove-orphans`. У `make`: `--force` (перегенерировать тела), `--skip-impl`,
`--no-test`, `--model`, `--endpoint`, `--reference`, `--port`.
У `ast` — `--check` (разобрать и прогнать проверки), у `test` — `--impl`,
у `run` — `--impl` или `--scaffold`, у `check` — `--strict`.
У `fmt`/`upgrade` — `--check`, `--write`, `--to <version>`.

```bash
arcod make .            # первая сборка с нуля
arcod make . --force    # заново сгенерировать тела
arcod make . --skip-impl --no-test   # только check + prompts + build
```

Каждый шаг — та же функция, что и у отдельной команды, поэтому конвейер не
расходится с ними. Останавливается на первой ошибке и печатает, где именно.

Числовые флаги проверяются при разборе: `--port` 1..65535, `--replicas`
1..1000, `--max-tokens` 1..1000000. Плохое значение печатает `invalid value for
--flag` и выходит с кодом 2, а не пишет `NaN` в манифест.

Тело операции — часть модели, а не скрытый блоб. Каждое тело `impl/*.mjs`
проверяется на sandbox — никаких import, сырой сети, fs, exec, process или eval,
только адаптер `io` — и `arcod build` падает, называя операцию и причину. Каждое
тело хешируется в `.arcod/build/impl-manifest.json`, а сгенерированные тела несут
заголовок `// @arcod generated:` с хешем промпта и моделью — provenance не теряется.
Все тела попадают в один модуль, поэтому top-level имя, объявленное в двух
файлах (`const LINES` и в `impl/create.mjs`, и в `impl/list.mjs`), отклоняется
на сборке с указанием обоих файлов, а не всплывает `SyntaxError` при старте
контейнера.

## Провайдеры

Модель называет возможность (`kv`, `sql`, `blob`…), окружение — провайдера
(`redis`, `postgres`, `s3`…). Компилятор знает, какой провайдер реализует
какую возможность, и проверяет это (`A023` неизвестный, `A024` несовместимый,
`A025` двойной bind, `A026` нет обязательного аргумента). Проверяются все
окружения: опечатка в `prod` валит `check`, а не релиз.

```arcod
environment dev {
  bind db     -> postgres(host: "db", expose: true)
  bind files  -> s3(host: "s3")
  bind stream -> websocket()
}
```

```bash
arcod providers            # таблица возможностей и провайдеров
arcod providers --plugins  # манифесты плагинов на этой машине
arcod deploy . --env prod  # target развёртывания и манифест
```

**Возможности с адаптером** (тело операции может их вызывать): `kv` (redis),
`sql` (postgres, mysql, mariadb), `blob` (s3), `identity` (keycloak),
`llm` (ollama, openai), `stream` (websocket, redis), `queue` (redis —
публикация, потребление, повторы, dead letter), `ids` и `hash` — привязываются к
`local`: это собственный рантайм компилятора. Он ничего не поднимает и умеет
только эти две возможности; `kv`, `sql` или `queue` на `local` — это `A068`.

`rabbitmq` и `kafka` тоже удовлетворяют `queue` и провижинятся, но сгенерированный
адаптер говорит только по протоколу redis-списков. Привязывайте `queue` к redis:
с другим брокером драйвер останется внутрипроцессным, а контейнер будет простаивать.

**Только инфраструктура** — провайдер провижинится в compose, но эффектов у
возможности пока нет, и адаптер в сервис не попадает: `document` (mongodb),
`proxy` (nginx), `migrations` (liquibase),
`olap` (clickhouse), `metrics` (prometheus), `errors` (sentry), `tracing`
(jaeger), `dashboards` (grafana), `mail` (mailpit), `secrets` (vault).
`endpoint` и `websocket` контейнера не создают вовсе: первый — адрес чужого
сервиса, второй — сервер внутри самого сервиса.

На каждый bind, которому нужен контейнер, генерируется сервис в compose с
healthcheck, томом и env; порты публикуются только при `expose: true`.

### Модель как возможность

Сервис не знает, локальная модель или облачная: он просит `llm.chat`, а
провайдера выбирает окружение.

```arcod
service Chat : http {
  uses store: sql(ttl: 31536000s)
  uses uuid: ids
  uses llm: llm
  effects { allow store.get, store.set, uuid.new, llm.chat }
}
```

```arcod
environment dev {
  bind llm -> ollama(host: "host.docker.internal", port: 11434, model: "qwen2.5-coder:7b")
}

environment prod {
  bind llm -> openai(model: "gpt-4o-mini")   // ключ из LLM_API_KEY
}
```

Оба провайдера говорят на OpenAI-совместимом `/chat/completions`, поэтому тело
операции одно: `io.chat(messages, system)`. Имя вендора в модели запрещено
(`A003`). Полный пример — `examples/chat`: история диалога, ответы модели и
страница с `layout: chat`.

```bash
arcod build examples/chat --impl && arcod run examples/chat
```

Локальная модель должна быть доступна контейнерам. На macOS Docker Desktop
`host.docker.internal` достаёт до Ollama, слушающей `127.0.0.1:11434`, без
настройки. На Linux контейнер до loopback хоста не дотянется: поднимите Ollama
на `0.0.0.0` (`OLLAMA_HOST=0.0.0.0 ollama serve`) или укажите в привязке
другой хост.

### Сгенерированная страница и доступность

Каждый блок `ui` даёт форму без зависимостей. Это единственный интерфейс у
большинства спек, поэтому a11y-базис — часть эмиттера: `<html lang="en">`,
обёртка `<label>` на каждый контрол, `aria-required` у обязательных
параметров, `autocomplete="off"`, чтобы менеджер паролей не подставлял пароль
в параметры API, и результаты в регионе `role="status"` с `aria-live="polite"`
— асинхронный ответ объявляется, фокус не крадётся.

Язык — свойство блока `ui`, а не флаг сборки: `locale: "ru"` (или любой тег
BCP-47) задаёт `<html lang>` и подменяет каталог подписей страницы — сегодня
есть `en` и `ru`; непоставленный тег сохраняет свой `lang` и откатывается на
английские подписи вместо падения сборки. Кривой тег — ошибка разбора.

```arcod
ui TasksUi {
  title:  "Tasks"
  locale: "ru"
  uses   Tasks.create, Tasks.list
}
```

Цвета — design tokens (`--surface`, `--ink`, `--line`, `--muted`, `--accent`,
`--danger`), которые читает каждое правило, а `theme: light|dark|auto`
выбирает палитру через атрибут `data-theme`; `render: static|ssr` объявляет,
где рендерится страница: `static` (по умолчанию) — HTML на сборке, `ssr`
встраивает ту же страницу в сервис и отдаёт её по маршруту ui (web-контейнер
не нужен); W030 напоминает, что данные запроса пока не рендерятся; `auto` (по умолчанию) следует за
ОС читателя через `prefers-color-scheme`. В разметке нет захардкоженных цветов.

Страницы чата и презентации берут тот же `lang` и тот же каталог: их статичная
обвязка (кнопка отправки, placeholder композера, форма входа, навигация по
слайдам, счётчик участников) подписана из него, а заголовки и текст слайдов
остаются авторскими.

Список локалей включает переключатель на странице формы: `locales: "en, ru"`
встраивает каждый объявленный каталог один раз и добавляет `<select>` в шапку;
`?lang=ru` выбирает каталог при загрузке, неизвестный тег откатывается на
`locale` (или первый объявленный). Страница статична, поэтому переключение
перезагружает её. В чате и презентации тот же переключатель в шапке; SSR —
отдельный пункт (B12).

```arcod
ui TasksUi {
  title:   "Tasks"
  locale:  "ru"
  locales: "en, ru"
  uses    Tasks.create, Tasks.list
}
```

### Чат-страница

`layout: chat` — не форма на операцию, а лента сообщений. Странице нужны две
привязки и необязательная третья:

```arcod
ui Chat {
  kind:    spa
  route:   "/"
  layout:  chat
  history: Agent.history    // что читать
  send:    Agent.send       // куда отправлять
  start:   Agent.start      // опционально: создать диалог
  uses     Agent.history, Agent.send, Agent.start
}
```

Текст сообщения берётся из параметра операции с типом строки; имя параметра
страница не угадывает, оно приходит из контракта. Если `history` или `send`
нет, или операция не публичная, — ошибка `A036`: лента без источника или без
получателя не имеет смысла.

Страница не опрашивает сервер: читает историю при открытии, отправляет
сообщение и добавляет ответ, который вернула операция `send`. Живые обновления —
это отдельная возможность `stream` (см. «Поток событий»), и в `layout: chat`
она пока не подключена.

### Чужой сервис: только контракт и адрес

Если сервис уже существует и мы только вызываем его, достаточно частичного
контракта. Ни контейнера, ни тела, ни тестов для него не генерируется.

```arcod
external service Ledger : http {
  contract {
    op record(entry: Entry) -> Receipt {
      route: "POST /v1/entries"
    }
  }
}

environment dev {
  bind Ledger -> endpoint(url: "http://localhost:9009")
}
```

```js
// в теле своей операции
const out = await io.remote('Ledger', 'record', { order: id, amount });
```

Эмиттер берёт метод и путь из контракта, базовый URL — из окружения
(`LEDGER_URL`), поэтому тело операции не знает адреса. В compose
`localhost` переписывается в `host.docker.internal`; `network: "shared"`
подключает контейнер к уже существующей сети (`external: true`), а
`gateway: true` добавляет `host-gateway` для Linux. Чужой сервис не попадает
в `services` манифеста и не получает задач планировщика.

Метод решает, куда попадает параметр: имя, совпавшее с `:path`-захватом,
подставляется в путь (с percent-encoding), `GET`, `HEAD` и `DELETE` кладут
остальные в query-строку, любой другой метод отправляет JSON-тело с
`content-type: application/json`. `HEAD` — это `GET` без тела ответа: запрос
уходит без тела, а ответ всё равно приходит как `{ status, body }` с
`body: null`.

Проверки: `A037` — нет `route`; `A038` — чужому сервису объявили `uses` или
эффекты; `A039` — привязали не к `endpoint`; `W026` — вызывают, но адрес не
задан.

Процесс на машине разработчика должен слушать `0.0.0.0`: на `127.0.0.1`
контейнер получит `Connection refused`.

### Где живёт сервис

Возможность и развёртывание — разные оси. Возможность говорит, чем сервис
пользуется (`bind store -> redis`), развёртывание — где он сам работает:

```arcod
environment dev  { ... deploy docker }
environment prod { ... deploy yandex(region: "ru-central1", folder: "arcod-prod") }
```

`docker` даёт локальный `docker-compose.yml`; `kubernetes` и `helm` —
те же объекты, но для кластера (`k8s/` или `helm/` рядом с compose-файлом);
`aws` и `yandex` — декларативный манифест `deploy.<env>.json`
(`"executed": false`: ни кредов, ни вызовов API). Неизвестный провайдер —
`A028`, неизвестный аргумент — `W019`. Compose собирается из локального
окружения, prod-привязки в него не протекают.

```bash
arcod deploy . --env prod          # target и артефакт
arcod deploy . --env prod --json   # манифест
```

**Имена образов — контракт.** Каждый сервис получает
`arcod/<module>-<service>:<версия спеки>`, если окружение не задало
`registry`, `repository` или явный `image`. Semver-метаданные приводятся к
легальному тегу (`0.2.0+build.7` → `0.2.0-build.7`). В манифесте есть части
(`registry`, `repository`, `tag`, `image`) на каждый сервис и карта
`images`, чтобы CI собирал ровно то имя, которое тянут раннеры; сам arcod
по-прежнему ничего не пушит. `arcod k8s` и `arcod helm` по умолчанию
рендерят то же имя; `--env` выбирает, чей контракт брать.
`.github/workflows/images.yml` собирает этот образ по тегу или вручную —
и на этом останавливается: публикация в registry — релизное действие, а не
работа генератора.

`arcod terraform` рендерит облачное представление того же окружения: сеть и
подсеть, managed-кластер на каждую привязку `postgres`/`redis`, бакет на
`s3`, а все креды — `variable` с `sensitive = true`, так что пароля в плане
нет. Цель — Yandex Cloud (провайдер из `deploy`); любой другой таргет
отвергается, а не рендерится наполовину. План читает тот же реестр
провайдеров, что и `check`: провайдер из плагина попадает в план как внешняя
зависимость — с именем пакета и каждым секретом как `sensitive`-переменной, а
не тихо выпадает. Неизвестный провайдер отмечается комментарием. Backend
состояния выбирает владелец, состояние не генерируется.

**Секреты** объявляет сам провайдер, а не догадка по имени: `postgres` помечает
`POSTGRES_PASSWORD` и `DATABASE_URL`, `s3` — `MINIO_ROOT_PASSWORD`/`S3_SECRET_KEY`,
`vault` — `VAULT_TOKEN` и т.д. Kubernetes-таргет кладёт их в `Secret`, а не в
`ConfigMap`. Если привязать возможность `secrets`, тот же Secret заменяется на
`ExternalSecret` (external-secrets.io) из Vault — ни один кред не пишется на диск:

```arcod
environment prod {
  bind db   -> postgres()
  bind keys -> vault(path: "secret/data/shop", store: "vault-backend")
  deploy kubernetes(image: "ghcr.io/acme/shop:1.0.0", host: "shop.example.com")
}
```

### Фоновые задачи и их зависимости

Одиночная задача с расписанием — это `job` внутри контракта сервиса.
Несколько задач с зависимостями — это `workflow`: граф шагов с типизированными
портами.

```arcod
workflow Nightly {
  trigger cron("0 3 * * *", tz: "Europe/Moscow")
  overlap: skip          // если прошлый запуск ещё идёт
  catchup: last          // догнать только последний пропуск
  retry: 2
  timeout: 30m

  step prepare() -> Snapshot {
    call: Reports.prepare
    effects: store.set
  }

  step render(snapshot: Snapshot) -> Report {
    call: Reports.render
    needs: prepare
  }

  step send(report: Report) -> Receipt {
    call: Reports.send
    needs: render
    onFail: stop
  }
}
```

Правила:

- рёбра только явные: `needs`; шаг без `needs` стартует сразу после триггера;
- входной порт заполняется выходом **ровно одного** шага из `needs` — по типу,
  без угадывания;
- цикл запрещён (`A030`), неизвестное ребро — `A029`, порт без производителя —
  `A031`;
- `onFail: stop | skip | retry | continue`; `onFail: skip` шага, от которого
  зависят другие, — предупреждение `W020`;
- триггеры: `cron(...)`, `event(...)`, `manual`, `after Other`,
  `after <длительность>` (задержка, например `after 30s`) и `at(<момент>)`
  (одноразовый запуск). Момент — ISO-8601 с явной зоной, без кавычек
  (`at(2026-11-18T12:00:05Z)`) или в кавычках; опечатка, невозможная дата
  или отсутствие зоны — `A034`, неположительная задержка или неизвестная
  единица — тоже `A034`.

Граф декларативный: он попадает в `deploy.<env>.json`, но runner появится
отдельно (`W022`). Триггер едет в манифесте данными: `kind`, `args`, а для
отложенных форм — `at` (момент) или `afterSeconds` (задержка), чтобы runner
планировал без повторного разбора спеки.

Отложенный триггер — декларация для runner'а, **а не таймер**: в v0.1
`at`/`after` сами не срабатывают, и работа по дедлайну остаётся
ответственностью приложения, пока runner'а нет. Невозможный момент,
отсутствие зоны или неположительная задержка отвергаются на сборке (`A034`). Состояние запусков, ретраи и лизинг — это отдельная
возможность `journal`, а не магия компилятора.

### Файлы, вход и права

`examples/files` — сервис, где пользователь входит через Keycloak, загружает
файл в S3 и выбирает видимость: всем, авторизованным или списку пользователей.
Администратор видит файл при любой видимости.

```arcod
uses store: sql(ttl: 31536000s)
uses auth:  identity
uses files: blob

environment dev {
  bind auth  -> keycloak(host: "idp", import: "realm.json")
  bind files -> s3(host: "s3")
}
```

`io.actor()` проверяет JWT по JWKS провайдера и отдаёт `{ id, name, admin }`,
`io.users()` берёт список пользователей из admin API, `io.blobPut/blobGet`
кладут и читают объекты. Провайдер по-прежнему выбирается в окружении: в модели
нет ни Keycloak, ни MinIO.

Эффекты операции объявляются явно: `effects: store.get, auth.actor, files.get`.
Запись `allow store.*` разрешает все эффекты одной возможности сразу; запись
`allow`/`deny`, которая не называет ни одного эффекта объявленной возможности
(или другой сервис), — это `A044`, так что опечатка не сойдёт за защиту.
Планировщик строит процедуру из эффектов и форм типов, а не из имён операций;
если объявления нет, эффекты выводятся из формы (uuid → чтение, bytes → объект,
list → список).

Права объявляются в контракте, а не пишутся руками в телах:

- `auth op` — нужен аутентифицированный актор; аноним получает `401`;
- `roles: admin, manager` — токен должен нести одну из ролей словаря `roles:`
  сервиса, иначе `403`;
- `owner: id` — запись, загруженная параметром `id`, должна принадлежать
  актору, иначе `403` (администраторы обходят; отсутствующая запись — `404`,
  а не утечка).

Guard выполняется в сгенерированном рантайме до тела операции: `401`, `403` и
`404` одинаковы во всех операциях и не зависят от того, что написал автор тела.

Страница UI тоже строится из контракта: по форме на публичную операцию,
поля по параметрам, результат — по форме ответа.

### Презентация: одна страница, две аудитории

`layout: presentation` — это одна страница для двух аудиторий: ведущий
открывает её на экране, участники заходят по коду или QR с телефона. Слайды
объявлены в модели, поэтому страница не угадывает, что показывать.

Интерактивные виджеты (опросы, оценки, комментарии) сознательно не входят в
v0.1: это продуктовая фича, а не ядро языка. Они вернутся отдельным пакетом,
когда появится модель плагинов.

```arcod
ui Stage {
  kind:    spa
  route:   "/"
  layout:  presentation
  start:   Live.start
  join:    Live.join
  state:   Live.state
  advance: Live.advance
  uses     Live.start, Live.join, Live.state, Live.advance

  slide "Кто вы?" {
    body: "Разработчики, QA, продукт — ведущий спрашивает, зал отвечает вслух."
  }
  slide "Подключение" {
    body: "Откройте ссылку с экрана или отсканируйте код, чтобы следить с телефона."
  }
}
```

Правила:

- `start`, `join`, `state`, `advance` обязательны (`A040`): ведущий создаёт
  сеанс, гость входит по коду, оба читают состояние, ведущий двигает деку;
- `A041` ловит пустую деку;
- QR рисуется на клиенте из ссылки на текущий сеанс; код генерируется
  сервисом, поэтому QR всегда ведёт на живую комнату; энкодер вендорен в
  страницу (MIT, без CDN), так что презентация работает офлайн.

Живой пример: `examples/quiz`. Ведущий получает код и QR и двигает деку, гости
следят за слайдами. Обновления идут по websocket: сервис публикует событие
после каждой мутации, страница читает `state`. В простое — ноль запросов; если
сокет не поднялся, страница сама переходит на опрос раз в 3 с.

### Поток событий: websocket

Модель просит поток, окружение отвечает транспортом — как с `kv` и `redis`.

```arcod
service Live : http {
  uses stream: stream
  effects {
    allow store.get, store.set, stream.publish
  }
  contract {
    public op vote(...) -> Ack {
      route: "POST /v1/sessions/:id/votes"
      effects: store.get, store.set, stream.publish
    }
  }
}

environment dev {
  bind stream -> websocket()
}
```

В теле операции:

```js
await io.publish('room:' + session.code, { type: 'changed', index: session.index });
```

`publish` возвращает число слушателей: `0` — это не ошибка, просто ведущий
ещё не открыл экран. Тема — обычная строка, её выбирает тело.

Что генерируется:

- **сервер на том же порту**, путь `/ws?topic=...`: рукопожатие, текстовые
  кадры, ping/pong и close по RFC 6455, вендорено в один файл — `ws` в
  зависимостях нет;
- **подписка по теме**: сообщение уходит только тем, кто слушает эту комнату;
- **nginx** получает `location /ws` с `Upgrade` и часовым `proxy_read_timeout`;
- **страница** слушает сокет и переподключается с backoff 1→10 с; пока сокета
  нет — опрос раз в 3 с. В презентации без `stream` — предупреждение `W028`.

Ограничения: канал односторонний (сервер → клиент), команды остаются на HTTP,
где есть статусы и лимиты. Без брокера хаб живёт в памяти процесса; `bind stream
-> redis(...)` ставит между репликами pub/sub: каждый инстанс публикует в
брокер и подписан на темы своих клиентов, так что клиент может сидеть на любой
реплике и всё равно увидит каждое событие ровно один раз.

Подробнее: `Проект «Файлы» — Keycloak и S3` в заметках проекта.

### Очередь: публикация в операции, потребление в job

Модель объявляет оба конца. Операция публикует:

```arcod
uses events: queue

public op submit(entry: string) -> bool {
  route: "POST /v1/submit"
  effects: events.publish
}
```

Job потребляет — жизненным циклом владеет рантайм, тело остаётся обычной
функцией от сообщения:

```arcod
job audit(entry: string) {
  on: events.jobs
  retry: 3
  effects: store.set
}
```

Семантика, которую обеспечивает сгенерированный рантайм, а не тела:

- консьюмер стартует до http-сервера и останавливается по `SIGINT`/`SIGTERM`,
  дообрабатывая сообщение в полёте (ack по завершению, nack — возврат в очередь);
- падающее тело — исключение или `{ error: ... }` — повторяется до `retry` раз
  (по умолчанию 3), затем уезжает в dead letter, читаемый `io.queueDead(topic)`;
- доставка at-least-once: тело консьюмера должно быть идемпотентным;
- без redis очередь внутрипроцессная (memory-драйвер); с `bind events ->
  redis(...)` сообщения живут в брокере и переживают рестарт.

Когда сервис использует `queue` на `sql`-драйвере, публикация в операции, которая
одновременно пишет факт, идёт через **outbox**: тело работает в транзакции, событие
кладётся в `arcod_outbox` в той же транзакции, а диспетчер на своей connection
ретранслирует закоммиченные строки в брокер. Падение между записью факта и
передачей в брокер не теряет событие; реплика, умершая на середине ретрансляции,
найдёт строку всё ещё pending при рестарте. Пример: `examples/orders`.
Идентификаторы всегда бэктикаются (`q()`), поэтому reserved-слова (`order`)
безопасны в качестве имён таблиц.

Проверки: `on:` — только у job (`A051`), источник — объявленный `queue`-алиас
(`A052`), `retry` без `on:` — ошибка (`A053`); job с очередью исполняется,
поэтому предупреждение `W017` «job не исполняется» к нему не применяется.

### Saga: multi-step с компенсацией

Saga — линейный multi-step сценарий, который исполняет сам рантайм (в отличие от
`workflow`, который остаётся external-runner контрактом). Каждый шаг вызывает
операцию и может назвать компенсирующую:

```arcod
saga checkout {
  step reserve {
    call: reserve          // свой op, in-process
    compensate: release
  }
  step charge {
    call: Billing.charge   // внешний сервис, через remoteCall
    compensate: Billing.refund
    retry: 2
  }
}
```

Триггер — job: `job run_checkout(label: string) { on: events.checkout
saga: checkout }`. Раннер исполняет шаги по порядку, ретраит падающий шаг до
`retry` раз (по умолчанию одна попытка) и на финальном падении компенсирует
завершённые шаги в обратном порядке. Компенсация — терминальное состояние,
сообщение не ретраится. Пример: `examples/saga`.

Проверки: `call`/`compensate` шага должны называть реальную операцию (`A057`),
`saga:` в job — объявленную saga (`A058`).

### Контракт как OpenAPI

`arcod openapi` печатает ту же модель документом OpenAPI 3.1 в stdout —
контракт, который читают другие команды, генераторы SDK и API-шлюзы, без
компилятора посередине:

```bash
arcod openapi examples/files > openapi.json
arcod openapi . --service FileShare   # спека из нескольких сервисов
```

Пути берутся из `route`, схемы запроса и ответа — из `types` (объявленный тип
становится `$ref` в `components/schemas`), коды — из того же маппинга ошибок,
что и в рантайме: `Invalid` — `400`, `Unauthorized` — `401`, `Forbidden` —
`403`, `NotFound` — `404`, `Unavailable` — `503`; блок `examples`
прикрепляется именованными примерами, включая примеры ошибок из
`then { e is Invalid }`. Провайдеры и хосты в документ не попадают: модели
запрещено их называть (`A003`).

Чего в документе нет: `servers` (адрес принадлежит окружению, а не контракту).
Аутентификация описывается, когда она есть в модели: сервис с `auth: identity`
публикует схему `bearerAuth` (`http`, `bearer`, JWT) и применяет её ко всему
документу, а `public`-операция снимает её явным `security: []`. Без
identity-возможности ключа `security` в документе нет вовсе — контракт не
обещает токен, который рантайм не проверяет. Для ролей и владения в OpenAPI
нет ключевых слов, поэтому клаузулы `roles:`/`owner:` попадают в `description`
операции: автор клиента видит то, что рантайм проверяет до тела.

### Контракт как GraphQL

`arcod graphql` рисует тот же контракт как GraphQL SDL. Рантайм по-прежнему
говорит по HTTP — схема это клиентский взгляд, чтобы кодогенерация (Apollo,
graphql-codegen, сам `graphql`) читала настоящую схему, а не догадывалась:

```bash
arcod graphql examples/tasks-sql                    # SDL в stdout
arcod graphql . --service TaskBoard --out schema.graphql
```

Разделение следует методу REST, который спека уже объявила, а не соглашению об
именах: маршрут `GET` становится полем **Query**, любой другой метод — полем
**Mutation**. Аргументы берутся из параметров операции (`uuid` → `ID`, `int` →
`Int`, `datetime` → `DateTime`, optional → nullable), тип возврата — из
`-> Type`. GraphQL не позволяет использовать выходной тип как входной, поэтому
каждый тип, встречающийся в аргументах, получает близнеца `<Name>Input`: его
несёт параметр тела, а скалярные параметры остаются обычными аргументами:

```graphql
type Query {
  """
  HTTP: GET /v1/tasks
  Errors: Invalid (400)
  """
  list(status: String, sort: String, limit: Int, cursor: String): ListResult!
}

type Mutation {
  create(task: TaskInput!): Task!
}
```

Описание каждого поля несёт HTTP-маршрут и коды ошибок по той же таблице, что
использует рантайм, — REST и GraphQL не могут разъехаться. Сгенерированный SDL
проверяется `buildSchema` из пакета `graphql` в тестах: по всем примерам, не
только по фикстуре.

### Контракт как gRPC

`arcod grpc` рисует тот же контракт как proto3-файл. Это единственный вид, где
HTTP вообще не участвует, поэтому механика важна: каждый тип должен попасть в
proto-тип с тем же смыслом, иначе клиенты наследуют ложь.

```bash
arcod grpc examples/tasks-sql                       # proto3 в stdout
arcod grpc . --service TaskBoard --out proto/tasks.proto
```

| arcod | proto3 |
|---|---|
| `string`, `uuid` | `string` |
| `bytes` | `bytes` |
| `int` | `int64` (язык его не ограничивает) |
| `float`, `number` | `double` |
| `decimal` | `string` — `double` округлил бы деньги |
| `bool` | `bool` |
| `datetime` | `google.protobuf.Timestamp` |
| `json` | `google.protobuf.Value` |
| `map<K,V>` | `map<K,V>` для скалярных ключей и значений, иначе `Struct` |
| `list<T>` | `repeated T` |
| `T?` | `optional T` (presence в proto3) |
| `enum` | `enum` с членом `<NAME>_UNSPECIFIED = 0` |
| record | `message` |

proto3 требует, чтобы первый член enum был нулём, а в arcod у enum нет чисел,
поэтому эмиттер добавляет `<NAME>_UNSPECIFIED = 0` и нумерует объявленные
значения с 1, с именем enum в префиксе: проводу нужен ноль, контракт сохраняет
каждое объявленное значение.

Каждая операция с маршрутом становится одним rpc с её именем; все параметры
(path, query и body — в gRPC нет URL) попадают в `<Op>Request`, возвращаемое
значение — в `<Op>Response.result`; операция `-> void` получает пустой response.
HTTP-маршрут и gRPC-коды ошибок (из той же таблицы статусов, что у рантайма)
остаются в комментариях, так что ни один транспорт не уезжает молча:

```proto
service TaskBoard {
  // HTTP: POST /v1/tasks
  // Errors: Invalid (INVALID_ARGUMENT), Conflict (ABORTED)
  rpc Create(CreateRequest) returns (CreateResponse);
}

message CreateRequest {
  Task item = 1;
}

message CreateResponse {
  Task result = 1;
}
```

Один файл — один сервис: `package` и имена сообщений должны оставаться
уникальными; `--service` выбирает сервис, модуль с несколькими сервисами даёт
файл на каждый.

### Записи, а не блобы: unique, фильтр, страницы по курсору

Тип-запись — это ещё и хранилище. `rules { unique Task.title }` проверяет
адаптер: вторая задача с тем же названием возвращает объявленный `Conflict`
(409), а не 500:

```arcod
type Task = {
  id: TaskId, title: string, status: Status,
  priority: int, createdAt: datetime, dueAt: datetime?
}

service TaskBoard : http {
  uses store: kv(ttl: 604800s)
  rules {
    unique Task.title      // claim: дубль — Conflict
    index Task.dueAt       // факт запроса: KEY в сгенерированном DDL
  }
}
```

Тело просит страницу, а не сканирует и не режет само:

```js
const page = await io.find('Task', {
  where: { status: 'open', priority: { gte: 2 } },
  order: 'priority desc, createdAt asc',
  limit: 20,
  cursor: input.cursor,
});
// { items: [ …записи… ], next: 'eyJ2Ijpb…' | null }
```

Правило unique может называть кортеж: `unique Fence.(name, fence)` (или
`unique Fence.name, Fence.fence`) делает уникальной пару, поэтому то же `name`
на другом `fence` допустимо, а та же пара — `Conflict`. В kv claim ключуется
кортежем, в SQL генерируется один составной `UNIQUE KEY (name, fence)`.

Ошибка может объявлять поля ответа: `error Conflict { fence: int }`. Тело,
вернувшее `{ error: 'Conflict', fence: lease.fence }`, даёт 409 с `fence` рядом
с `error`/`message`; копируются только объявленные имена, поэтому тело не
может добавить произвольные свойства, а ошибка без полей сохраняет классическое
тело из двух ключей.

`io.insert`, `io.fetch`, `io.update`, `io.remove` держат unique-claim в согласии
с записью: новое значение захватывается до освобождения старого. `io.find`
фильтрует (`eq`, `ne`, `in`, `gt`/`gte`/`lt`/`lte`, `contains`), сортирует и
листает по keyset-курсору — значения сортировки последней строки и её id в
base64url, поэтому страница не съезжает, когда сверху вставляют записи.

`examples/tasks` (Redis, в тестах `KV_DRIVER=memory`) и `examples/tasks-sql`
(MySQL) делят одни и те же тела, оба проходят `arcod test --impl`. Чего пока
нет: фильтр выполняется в адаптере по одному namespace (`scan` + сравнение в
памяти) — это честно для тысяч строк, но не для миллионов. Осознанные SQL-таблицы,
объявленные индексы и pushdown запроса — следующий шаг.

### Одна модель — разные провайдеры

`kv` и `sql` — одна и та же запись по id, разные провайдеры. Тела операций не
меняются:

```arcod
uses store: kv(ttl: 999s)     bind store -> redis(host: "store")
uses store: sql(ttl: 999s)    bind store -> mysql(host: "store")
```

Сгенерированный сервис получает клиент под выбранную возможность: Redis RESP
или MySQL-протокол, оба без зависимостей. Данные идут hex-литералами, чтобы
значение из запроса никогда не склеивалось с SQL; `take` выполняется
транзакцией с `SELECT … FOR UPDATE`.

Опции провайдера — это аргументы `bind alias -> provider(args)`. Набор у
каждого провайдера фиксированный: `arcod providers --json` перечисляет имена в
`options`, а `W035` сообщает об аргументе, которого провайдер не читает.
`host`, `port`, `expose` и `import` принимает любой bind.

Живые примеры: `examples/project1` (Redis) и `examples/project1-mysql` (MySQL) —
одна и та же спека, отличие в двух строках.

Возможности и провайдеры могут приходить из пакета: манифест плагина их
объявляет, а `arcod providers --plugins` показывает, что найдено, откуда и что
с ним не так (неизвестный `pluginApi`, перекрытие встроенного провайдера,
провайдер с необъявленной возможностью). Реестр питает `check`, эмиттеры
compose/k8s/terraform и `arcod build`: файл провайдера с `runtime.adapter`
копируется в `plugins/<provider>.mjs`, сгенерированный сервис загружает его
на старте и направляет объявленные сигнатуры возможности (`send(to)`) в
методы адаптера. Тело операции называет `io.send(...)`, а не пакет. Манифест —
это данные; код плагина исполняется только внутри сервиса. Дизайн:
`docs/plugin-registry.md`.

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

### Из нуля в сервис локальной моделью

```bash
node scripts/e2e-local-model.mjs
# arcod new demo -> arcod impl demo -> arcod build demo --impl -> arcod test demo --impl
```

Один скрипт проходит весь путь: создать спеку, сгенерировать все тела локальной
моделью, собрать сервис с ними и прогнать его примеры. Сначала он проверяет
`OLLAMA_ENDPOINT` (по умолчанию `http://localhost:11434`); если модели нет, он
печатает одну строку `SKIP e2e-local-model: ...` и выходит с кодом `0` —
машина без модели это факт конфигурации, а не красный тест. `ARC_MODEL`
выбирает другую модель, `ARC_E2E_KEEP=1` оставляет временный каталог.

`node scripts/model-harness.mjs [example ...]` измеряет модель, а не верит ей:
копирует каждый пример во временный каталог, генерирует все тела, прогоняет
own примеры спеки и пишет `docs/model-report.md` — покрытие тел по примерам,
зелёные/красные примеры, время. Без модели — та же одна строка SKIP и код 0;
checked-in `impl/` не трогаются.

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

- `.arcod/build/service/index.mjs` — HTTP-сервис на Node без зависимостей, с
  адаптером под выбранные возможности: RESP-клиент для `kv`, MySQL-клиент для
  `sql`, JWKS для `identity`, S3 для `blob`, OpenAI-совместимый чат для `llm`,
  websocket-хаб и pub/sub для `stream`, очередь с повторами и dead letter для
  `queue` (redis-списки, либо внутрипроцессно, если брокер не привязан);
- роутер сравнивает путь по сегментам: захват `:name` — это позиция, а не имя,
  метод сверяется без учёта регистра, а запрос `HEAD` обслуживает `GET`-маршрут
  с теми же заголовками и без тела (RFC 9110);
- `.arcod/build/web/` — статический фронтенд и nginx с проксированием корней
  объявленных маршрутов (`/api`, `/v1`) и `/ws` при потоке `stream` (только при
  объявленном `ui`);
- `.arcod/build/docker-compose.yml` — провайдеры + сервис + фронтенд, с
  локальными тегами образов от содержимого (`arcod/<module>-service:<hash>` по
  `service/`, `arcod/<module>-web:<hash>` по `web/`; `arcod build` их печатает):
  правка тела в `impl/*.mjs` меняет тег, поэтому обычный `docker compose up`
  собирает и пересоздаёт контейнер, а не оставляет старый; при неизменных файлах
  тег тот же и образ переиспользуется;
- `.arcod/build/k8s/` (или `helm/`) — та же топология объектами Kubernetes:
  Namespace, ConfigMap с несекретным env, `Secret` под креды (при привязке
  `secrets` — `ExternalSecret`), Deployment+Service на каждый провайдер,
  сервис с пробами `/healthz`, веб-слой и Ingress; пишется, когда окружение
  объявляет `deploy kubernetes` или `deploy helm`;
- `.arcod/build/prompts/` — по промпту на операцию и `manifest.json` с хешем
  модели и бюджетом токенов;
- `.arcod/build/deploy.<env>.json` — манифест на каждое окружение с `deploy`.

`budget { concurrency: N }` даёт лимитер in-flight запросов: сверх лимита — `503`.

`atomic read { get; del }` переключает чтение на атомарный Lua-скрипт; без правила генерируются раздельные `GET` и `DEL`. `once(read, by: id, else: Gone)` задаёт ошибку повторного чтения — эмиттер берёт её из модели, а не из константы.

Правила из спеки превращаются в поведение: `atomic read { get; del }` — в Lua-скрипт с гетом и удалением, `once(read, by: id)` — в tombstone-ключ, который даёт `Gone` при повторном чтении.

## Observability

Каждый сгенерированный HTTP-сервис по умолчанию несёт прод-базлайн — без зависимостей и настройки:

- **Structured access log.** Одна JSON-строка на запрос в stdout:
  `method`, `route` (шаблон объявленного пути, а не конкретный URL),
  `status`, `latency_ms`, `request_id`, `actor_id` (когда подключён
  identity) и `operation`.
- **Request id.** Входящий `x-request-id` (или сгенерированный UUID)
  эхом уходит в ответ и пробрасывается в каждый внешний вызов через
  `AsyncLocalStorage` — один trace проходит сквозь границы сервисов.
- **`/metrics`.** Prometheus text format:
  `arcod_requests_total` (по method/route/status),
  `arcod_request_duration_seconds` (гистограмма с фиксированными бакетами),
  `arcod_errors_total` (по operation), `arcod_inflight_requests` (gauge) и
  `arcod_capability_calls_total` (`store.insert`, `store.find`, `remote.*`).
- **Request timeouts.** `server.requestTimeout`/`headersTimeout` и
  `AbortSignal.timeout` на внешних вызовах, управляются `ARCod_TIMEOUT_MS`
  (по умолчанию `30000`).
- **Трейсы.** Каждая операция выполняется в server-span, каждый вызов
  хранилища — в client-span (`store.<op>` с атрибутами `capability` и
  `entity`), каждый внешний вызов — тоже; связка parent/child через
  `AsyncLocalStorage`. При
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` спаны уходят батчами как OTLP/JSON
  (`POST <endpoint>/v1/traces`) — без зависимостей, opt-in.

```bash
curl -s localhost:8091/metrics | head
# arcod_requests_total{method="POST",route="/v1/tasks",status="201"} 1
# arcod_capability_calls_total{capability="store.insert"} 1
```

## Миграции

`arcod migrate [dir]` превращает модель данных в упорядоченный changelog с
checksum в `.arcod/build/migrations/`. Тип-запись становится настоящей таблицей:
скалярные поля — типизированные колонки (`uuid` → `CHAR(36)`, `datetime` →
`DATETIME(3)`, `int` → `BIGINT`, `decimal` → `DECIMAL(30,6)`, строки →
`TEXT`, уникальные строки → `VARCHAR(191)`), `id` — первичный ключ, каждое
`rules { unique ... }` — `UNIQUE KEY`, `rules { index ... }` — обычный `KEY`.
Значение по умолчанию у поля
становится `DEFAULT` колонки (`done: bool = false` → `DEFAULT 0`), так что
строка, вставленная в обход сгенерированного сервиса, тоже получает
объявленное значение. Вложенные записи, объединения и `list`/`map` ложатся
в колонки `JSON`.

У каждой миграции есть `version`, `checksum` (sha256 от up+down) и SQL
`up`/`down`. Сгенерированный сервис применяет их при старте (sql-драйвер):
ведёт `arcod_migrations`, повторный запуск — no-op, изменённая после применения
миграция отказывается стартовать.

```bash
arcod migrate examples/tasks
# migrations for TaskBoard (2):
#   0001 arcod_kv   checksum 46ec9741e862
#   0002 task       checksum b2d653261189
# artifact: .arcod/build/migrations/ — changelog.json + up/down .sql
```

Диалект DDL следует за окружением: `bind store -> postgres` (или `mysql`,
`mariadb`) выбирает диалект и для `arcod migrate`, и для сборки — без флага,
и `arcod build` печатает получившийся диалект. Явный `--dialect`, который
расходится с bind, отклоняется с именем bind (`--dialect mysql conflicts with
bind store -> postgres`, exit 2), а не выпускает клиент, который база отвергнет;
два sql-bind с разными диалектами в одной спеке отклоняются так же. Спека без
sql-bind сохраняет прежний дефолт (mysql).

Таблицами становятся только сущности: `arcod migrate` (и миграции внутри
собранного сервиса) читает `impl/` и берёт набор таблиц из имён типов, которые
тела передают в `io.insert`/`fetch`/`update`/`remove`/`find`, поэтому DTO
вроде `AlertAck { ok, id }`, который возвращает пишущая операция, таблицу не
получает. Скелет без тел сохраняет прежнее правило (таблица на каждый
record-тип), потому что отличить сущность от DTO нечем. Строковое поле-ключ
(`id` или член `unique`) печатается как `VARCHAR(191)`, а не `TEXT`: TEXT в
первичном ключе — ошибка MySQL 1170, и все следующие миграции молча не применяются.

На `sql`-драйвере рантайм пишет прямо в эти типизированные таблицы: запись —
строка, `unique` — `UNIQUE KEY` таблицы (дубль — ER_DUP_ENTRY БД, объявленный
`Conflict`), а `find` уходит в SQL (`WHERE`/`ORDER BY`/`LIMIT` с keyset-
предикатом). `kv`-драйвер (память/Redis) оставлен на blob+claim, так что одни
и те же тела работают на обоих без изменений.

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
- `W013` бюджет не задан — только с `--strict`; по умолчанию бюджет необязателен;
- `W015` ошибка объявлена, но нигде не используется;
- `A018` `ui` ссылается на несуществующую операцию или операцию без `route`;
- `A019` `ui` с неподдерживаемым `kind` (в v0.1 только `spa`);
- `A020` эффект одновременно в `allow` и `deny`;
- `A021` запрещённый эффект используется;
- `W016` `deny` для нативного эффекта (`net`, `fs`, `exec`) не исполняется;
- `W017` `job` не исполняется в v0.1;
- `W018` тела операций не заданы в спеке: их даёт `arcod impl`, `--reference` или `TODO` в scaffold;
- `A022` `once(..., else: E)` ссылается на ошибку вне контракта;
- `A023` неизвестный провайдер; `A024` провайдер не реализует возможность;
  `A025` алиас привязан дважды; `A026` провайдер требует аргумент, которого
  нет в `bind` — все четыре проверки идут по каждому окружению, а не только
  по выбранному `--env`;
- `A027` операция называет эффект, чей алиас не объявлен в `uses`;
- `A028` неизвестный провайдер развёртывания, `W019` неизвестный аргумент;
- `A029` `needs` ссылается на неизвестный шаг;
- `A030` цикл в графе workflow;
- `A031` у входного порта нет единственного производителя;
- `A032` шаг объявлен дважды;
- `A033` workflow без триггера или с неизвестным триггером;
- `A034` у отложенного триггера нет планируемого аргумента: `at` без одного
  момента ISO-8601 с зоной (или с невозможной датой), `after` без
  положительной длительности или имени job, либо неизвестная единица;
- `W020` `onFail: skip` у шага, от которого зависят другие шаги;
- `W022` workflow описывается, но не исполняется в v0.1;
- `W023` `call` шага не объявлен в модуле;
- `W024` шаг без `call`: его тело придётся сгенерировать;
- `A036` `layout: chat` без `history`/`send` или со ссылкой на непубличную операцию;
- `A037` у операции внешнего сервиса нет `route`;
- `A038` внешнему сервису объявили `uses` или `effects`;
- `A039` внешний сервис привязан не к `endpoint`;
- `A040` у `layout: presentation` нет `start`/`join`/`state`/`advance`;
- `A041` в презентации нет слайдов;
- `A042` слайды объявлены на странице, у которой `layout` не `presentation` —
  страница их отбросит, и текст не дойдёт до браузера;
- `A066` одно имя объявлено дважды (поле записи или ошибки, значение enum,
  операция, сервис, тип, enum, ошибка, workflow или окружение) — эмиттеры
  адресуют по имени, и вторая декларация молча заменила бы первую;
- `A067` операция объявляет одну клаузу дважды (`route`, `effects`, `retry`,
  `on error E`): в AST остаются обе, каждый читатель берёт первую, и вторая
  не делает ничего;
- `A074` в пути маршрута есть query-строка или фрагмент
  (`GET /v1/x?limit=10`): роутер сравнивает `url.pathname`, где их не бывает,
  поэтому операция недостижима — значение надо объявить параметром;
- `A075` в маршруте OpenAPI-синтаксис захвата (`GET /v1/items/{id}`):
  arcod пишет захват `:id`, поэтому скобки — литеральный сегмент, параметр не
  связывается и операция отвечает 404 — напишите `:id` (`arcod adopt`
  преобразует документ OpenAPI сам);
- `A073` литеральный маршрут объявлен после маршрута-захвата той же формы:
  роутер перебирает маршруты в порядке объявления, а `:id` принимает любой
  сегмент, поэтому `GET /v1/t/new` после `GET /v1/t/:id` не выполнится
  никогда — объявите литеральный маршрут первым или уберите его на сегмент,
  который захват не покрывает;
- `A072` один и тот же `:name` дважды в маршруте
  (`/v1/locks/:name/:name`): роутер разбирает сегменты по порядку, побеждает
  последний, а раннее значение не читает никто — составному ключу нужны два
  разных имени;
- `A071` сегмент маршрута `:name`, которого нет среди параметров операции:
  роутер захватывает значение, которое никто не читает, а аргумент тела
  остаётся несвязанным (опечатка `:tid` вместо `id`);
- `A070` `route` — не `"METHOD /path"` с известным HTTP-методом (GET, POST,
  PUT, PATCH, DELETE, HEAD, OPTIONS): голый путь раньше превращался в
  `GET /` и в OpenAPI, и в роутере, поэтому операция отвечала на URL,
  которого никто не писал. Метод сравнивается без учёта регистра и
  эмитится в верхнем регистре: `route: "post /v1/x"` обслуживает `POST`;
- `A069` две операции одного сервиса отвечают на один метод и путь:
  сгенерированный роутер оставляет первую, вторая недостижима — она никогда
  не выполнится, и никакая другая диагностика об этом не скажет. Путь
  сравнивается так, как его читает роутер: захват — это позиция, а не имя
  (`/v1/t/:id` и `/v1/t/:tid` совпадают), пустые сегменты отбрасываются
  (`/v1/x/` — это `/v1/x`);
- `A068` `bind alias -> local` для возможности, которую встроенный рантайм не
  обслуживает: `local` — это штатный рантайм компилятора (ids, hash), поэтому
  привязка хранилища или очереди к нему ничего не поднимает, а сервис стартует
  без адреса;
- `A045` `--env` называет окружение, которого нет в модуле (в подсказке —
  объявленные), вместо отчёта о «ненайденных привязках»;
- `A044` запись `allow`/`deny`, которая не называет ни одного эффекта
  объявленной возможности (опечатка вроде `store.gett`) или другого сервиса;
- `A043` клауза `ui`, которую выбранный layout не читает (`history`/`send` —
  только `layout: chat`; `start` — chat или presentation; `join`/`state`/
  `advance` — только presentation): клауза была бы молча проигнорирована;
- `A046` `auth`/`roles`/`owner` у операции сервиса без возможности
  `identity` — охраннику нужен источник актора;
- `A047` роль в `roles:` вне словаря `roles:` сервиса;
- `A048` `public`-операции нужен актор (`roles:`/`owner:` или эффект identity) —
  объявите её `auth op`;
- `A049` `owner:` ссылается на параметр, которого у операции нет;
- `A050` у `public`-операции нет `route`;
- `A051` `on: alias.topic` стоит не у `job`;
- `A052` источник консьюмера — не объявленный `queue`-алиас;
- `A053` `retry` без `on:`-консьюмера;
- `A054` `unique` не указывает на поле типа-записи;
- `A055` `unique` без объявленной ошибки `Conflict`;
- `A056` `unique` без хранилища `kv`/`sql`, где держать claim;
- `A062` `index` не указывает на поле типа-записи;
- `A057` `call`/`compensate` шага saga называет неизвестную операцию;
- `A058` `saga:` в job называет необъявленную saga;
- `A059` значение по умолчанию у поля — не литерал его типа;
- `A060` значение по умолчанию нарушает ограниченный тип (`email`, `url`, `enum`);
- `A061` `string(format: ...)` называет неизвестный формат;
- `A063` пример передаёт литерал, который параметр принять не может (список
  там, где объявлена `string`; число там, где `list<T>`; `null` для
  необязательного параметра);
- `A064` выражение `on error E` называет поле-член, которого `E` не объявляет;
- `A065` ошибка объявляет поле ответа, которое её `on error` не заполняет
  (ответ всегда терял бы его).
- `W026` внешний сервис вызывают, но адрес не задан;
- `W028` презентация без `stream`: страница будет опрашивать состояние;
- `W029` у провайдера плагина есть runtime.adapter, но у его возможности нет сигнатур (сервис не сможет его вызвать).
- `W032` у `bind` объявлены `guarantees [...]`: клауза сохраняется в спеке и
  печатается `fmt`, но никто её не проверяет и не исполняет — она читается как
  контракт долговечности, поэтому checker говорит, что это на самом деле.
- `W033` у `uses` объявлен параметр, который никто не читает
  (`consistency: strong`): исполняется только `ttl` у `kv`/`sql`, остальные
  имена остаются заметкой для читателя — checker говорит об этом прямо.
- `W034` аргумент `bind` или `deploy` — не литерал
  (`bind store -> redis(host: host)`, `deploy yandex(region: zone)`): эмиттеры
  читают `host`, `port`, `expose` и опции провайдера только из литералов, и
  выражение молча откатилось бы к значению по умолчанию или к строке
  `'<expr>'`.
- `W035` у `bind` аргумент, который провайдер не читает
  (`bind store -> redis(host: "kv", bogus: 1)`): у каждого провайдера
  объявлен фиксированный набор опций, поэтому аргумент принимался и
  отбрасывался. Подсказка перечисляет известные; `host`, `port`, `expose` и
  `import` есть у любого bind. Провайдер плагина без карты `args` исключён —
  сравнивать не с чем.

`arcod check` возвращает `1` при ошибках и `0`, когда модель чистая.

### Примеры — это тесты

`examples` в модели — не документация, а исполняемые сценарии: `arcod test`
поднимает сервис и прогоняет их. Тела берутся из `impl/`, если там что-то
есть (`--impl` форсирует это); пустой `impl/` откатывается на встроенные
reference-тела, а они покрывают только `create`/`read`. Для остальных операций
`arcod test` говорит, что тел нет и как их получить, вместо сборки сервиса,
который не умеет отвечать. Каждый шаг — настоящий запрос: имя, совпавшее с
`:path`-захватом, подставляется в путь, `GET`, `HEAD` и `DELETE` кладут
остальные в query-строку, любой другой метод отправляет JSON-тело. У ответа
`HEAD` тела нет, поэтому шаг вычисляется в `null`.

```arcod
service OneTimeMessage : http {
  // ...
  examples {
    example create_and_read {
      when { let id = create("hi") }
      then {
        read(id) == "hi"
        read(id) is Gone
      }
    }

    example rejects_empty {
      when { let e = create("") }
      then { e is Invalid }
    }
  }
}
```

Аргументы — литералы, которые знает контракт: строки, числа, `true`/`false`,
`null` и литералы списка вроде `["ann", "bob"]` для параметра `list<string>`.

`given` (подготовка состояния) и `when` вызывают операции и связывают результаты
через `let`, `then` утверждает: сравнение, `is <Ошибка>`, `&&`, `||`, `!`.
`given` исполняется до `when` и делится с ним связываниями, так что засеянное
значение можно читать в `when`/`then`. Операция без примера — предупреждение
`W012`; объявленная ошибка, которую не обработали и не покрыли примером, — `A007`.

## Редакторы и LSP

Расширение `*.arc` живёт в `editors/vscode`, а `arcod lsp` — это обычный
языковой сервер (LSP) по stdio, собранный из тех же lexer/parser/check, что и
компилятор: редактор видит ровно то, что видит `arcod check`. Открытие или
правка документа перепубликует диагностику, закрытие забывает буфер, а
неизвестный запрос получает `null`, а не молчание — клиент, который ждёт вечно,
выглядит как зависший редактор.

VS Code (`editors/vscode`):

- подсветка TextMate: объявления, операции, клаузы, эффекты, типы и длительности;
  провайдеры и возможности различаются цветом;
- живая диагностика по мере ввода + счётчик в статус-баре;
- дополнение: ключевые слова, типы, сервисы, операции, ошибки, enum'ы и алиасы
  `uses`; мёртвые ключевые слова v0.1 не предлагаются;
- outline, переход к определению, поиск использований, hover и форматирование
  (`arcod fmt`).

```bash
cd editors/vscode && npm install && npm run package
code --install-extension arcod-0.1.0.vsix --no-dependencies
```

Neovim (lspconfig) и любой другой LSP-клиент:

```lua
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'arcod',
  callback = function()
    vim.lsp.start({ name = 'arcod', cmd = { 'arcod', 'lsp' } })
  end,
})
```

JetBrains: подключите LSP-клиент (например, плагин LSP API) к команде
`arcod lsp` для файлов `*.arc`.

Проверки расширения: `node --test test/*.test.mjs` (грамматика через
vscode-textmate и LSP-клиент против настоящего сервера) и
`node test/runTest.cjs` — запускает настоящий extension host VS Code.

## Структура

```
src/
  lexer.ts        токены и позиции
  parser.ts       ручной recursive descent + Pratt для выражений
  ast.ts          канонический AST
  check.ts        статические проверки
  capabilities.ts подписи эффектов: что можно просить у возможности
  providers.ts    реестр провайдеров, портов и переменных окружения
  plan.ts         DAG задач
  plan-body.ts    что нужно телу операции: шаги и эффекты
  prompts.ts      детерминированные промпты и бюджет токенов
  impl.ts         генерация тел локальной моделью
  pipeline.ts     конвейер `arcod make`
  test.ts         прогон `examples` против сгенерированного сервиса
  build.ts        сборка в `.arcod/build`
  deploy.ts       провайдеры развёртывания и манифест
  templates.ts    встроенные reference-тела
  cli.ts          команды и флаги
  emit/service.ts        сервис, адаптеры и `io`
  emit/sql-store.ts      клиент MySQL
  emit/identity.ts       Keycloak/JWKS
  emit/blob.ts           S3
  emit/llm.ts            OpenAI-совместимый чат
  emit/stream.ts         websocket-сервер (RFC 6455) и redis pub/sub
  emit/queue.ts          драйверы очереди (memory, redis) и консьюмеры
  emit/openapi.ts        OpenAPI 3.1 из той же модели
  emit/graphql.ts        GraphQL SDL из той же модели
  emit/grpc.ts           proto3 из той же модели
  emit/web.ts            фронтенд: формы
  emit/chat-page.ts      `layout: chat`
  emit/presentation-page.ts `layout: presentation`
  emit/qr-code.ts        вендоренный QR-энкодер
  emit/compose.ts        Dockerfile, compose и nginx
editors/vscode/ расширение VS Code: грамматика, дополнения, проверки
examples/
  onetimemessage/      одноразовое сообщение
  onetimemessage-pwd/  то же, пароль необязателен
  project1/            сообщение с автором, хранилище kv
  project1-mysql/      та же модель на sql
  files/               вход, права, объекты в S3
  chat/                диалог с моделью, `layout: chat`
  payments/            чужой сервис: контракт и адрес
  quiz/                презентация и поток событий
  tasks/               хранилище записей: unique, фильтр, страницы (kv)
  tasks-sql/           те же тела на sql
  orders/              sql + queue: атомарный publish+fact через outbox
  saga/                saga: multi-step с компенсацией, исполняет рантайм
test/             node --test
```

Запуск тестов:

```bash
npm test
```

Тестовая матрица разбита на тематические suites: `arcod.test.ts` (парсер, чекер,
планировщик, ядро эмиттера), `emit-openapi` / `emit-authz` / `emit-async`
(эмиттеры), `impl.test.ts` (тела и sandbox), `tooling.test.ts` (fmt/diff/adopt/
versions), `lsp.test.ts` (языковой сервер) и интеграционные — `authz.test.ts`
(401/403), `contract.test.ts` (внешние сервисы против мока), `soak.test.ts`
(конкурентность + латентность) и `property.test.ts` (входной фаззинг: никакой
вход не даёт 500). Поведение методов закрыто отдельными небольшими suites:
`remote-methods` и `remote-capture` (что remote-вызов делает с каждым методом и
параметром), `head-example` (HEAD-операция из примера) и `head-ui` (таблица
операций SPA). `test/harness.ts` собирает спеку и поднимает сервис на свободном
порту для интеграционных suites.

## Ограничения v0.1

Это вертикальный срез, а не готовый язык.

- **Scaffold без тел** (`arcod build` без `--impl`) знает только `create` и
  `read`: встроенных шаблонов для других операций нет. С `--impl` эмиттер
  принимает любые операции и любую из девяти возможностей.
- `kv` в реальном окружении — Redis; in-memory драйвер есть только для
  `arcod test`.
- UTF-8 BOM в начале спеки игнорируется (его добавляет редактор в Windows),
  а канонический вид его не содержит: файл с BOM чист для `check` и
  «not formatted» для `fmt --check`, пока `--write` не уберёт BOM.
- `arcod fmt` — канонический и идемпотентный форматтер, но перекладывает
  record-типы в одну строку. Комментарии над декларациями, полями, значениями
  enum, стейтментами примеров, строками `uses`, строками `allow`/`deny`,
  записями `budget` и клаузами шагов workflow сохраняются, комментарий внутри
  шага `saga` разворачивает шаг из одной строки в блок, комментарий у одного
  имени эффекта печатает список по одному имени на строку, комментарий внутри
  скобок заголовка `module` остаётся внутри блока (печатается после `meta`,
  если блок объявлен), комментарий внутри `meta { ... }` остаётся у своей
  записи (или в конце блока), комментарий внутри блока `workflow`/`ui`
  остаётся у своей клаузы (или в конце блока, в том числе когда клауза —
  отброшенное значение по умолчанию вроде `theme: auto`), комментарий внутри
  `slide` остаётся в этом слайде (над `body` или после него перед закрывающей
  скобкой),
  комментарий после последней декларации печатается в конце файла,
  а комментарий в конце строки после кода остаётся на своей строке
  (перевешивается на самый глубокий узел, который начинается там же),
  комментарий после закрывающей скобки остаётся на этой скобке: сервис,
  операция, тип или enum, saga, пример и блоки
  `effects`/`rules`/`contract`/`examples`/`budget` внутри сервиса сохраняют
  `}  // note`, а однострочная запись или enum не разъезжаются на много строк. `arcod diff` сравнивает канонизированные спеки; `arcod adopt`
  импортирует только OpenAPI 3.x JSON.
- из предикатов правил `arcod test` поддерживает только `once`.
- `unique` проверяется и исполняется (`A054`–`A056`, дубль возвращает
  объявленный `Conflict`) для одного поля или кортежа полей одной записи.
  `ordering` проверяется только на циклы и остаётся декларативным.
- Генерация только в JavaScript/Node. PHP, Go и Python — отдельные эмиттеры позже.
- блоки `change`, `policy`, `hint`, `impl`, `lifecycle` и `unknown`, а также
  клаузы `idempotent`, `since` и `schedule` отклоняются парсером: в v0.1 они не
  поддерживаются — модель должна выражать смысл явно, а не оставлять заготовки.
- `ordering` и предикаты, кроме `once`, пока декларативны.
- `ui` поддерживает только `kind: spa` и генерирует страницу под операции `create`/`read`; произвольная вёрстка не выражается.
- `budget.latency` и `budget.cost` — декларативные SLO, runtime-проверки для них ещё нет.
- `effects.deny` для `net`, `fs`, `exec` декларативен: рантайм его не применяет (`W016`).
- `job` без `on:`-консьюмера по-прежнему только парсится и не исполняется (`W017`): модели состояния и условия выборки нет, поэтому «expired» не определён. TTL — гарантия провайдера `kv`. Job с очередью исполняется, с повторами и dead letter.
- **`find` на `kv` — это сканирование с фильтром**, а не планировщик запросов: адаптер читает один namespace и сравнивает в памяти. Для тысяч строк нормально, для миллионов — нет. На `sql` тот же `find` уходит в `WHERE`/`ORDER BY`/`LIMIT`; `rules { index Task.dueAt }` становится `KEY` в
сгенерированном DDL (пока только одноколоночные индексы).
- **Unique-claim переживает запись**: у ключа claim нет своего TTL, поэтому истёкшая запись держит значение, пока `io.remove`/`io.update` его не освободят. Обновление и удаление индекс поддерживают, очистки по TTL пока нет.
- **В спеке нет тел операций** (`W018`): `build` по умолчанию даёт scaffold с TODO, `--impl` берёт тела из `impl/`, `--reference` подставляет встроенный демо-шаблон.

## Версии и релизы

Версию несут две вещи:

- **CLI** (`arcod --version`, `package.json`) — semver; пока проект 0.x, минорный бамп может ломать командную поверхность.
- **Язык** (`@x.y.z` у модуля) — смена версии языка это миграция: `arcod upgrade` переписывает спеку через реестр `src/versions.ts`. Сегодня есть только `0.1.0`, поэтому движок — identity плюс отказ на неизвестную версию и downgrade.

Публикация: `npm pack` кладёт `bin` + `src` + README + LICENSE (исходники TypeScript, Node >= 24 исполняет их нативно). Пуш `v*`-тега запускает `.github/workflows/release.yml` — тесты, `npm publish` (секрет `NPM_TOKEN`) и GitHub release.

## Лицензия

Apache-2.0 — см. `LICENSE` и `NOTICE`.

Код, сгенерированный из ваших `.arc`-спек, принадлежит вам: лицензия покрывает
компилятор и рантайм, а не результат генерации. Имя и логотип Arcod лицензией
не покрываются (Apache-2.0, раздел 6).
