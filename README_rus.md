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

Есть записи `{ ... }`, `list<T>`, `bytes`, `uuid`, объединения и значения по
умолчанию у параметров (`limit: number = 20`). Длительности (`999s`, `24h`) —
значения в клаузах (`ttl: 999s`, `timeout: 30s`), а не тип.

## Команды

| Команда | Что делает |
|---|---|
| `arcod check [dir]` | парсит, проверяет типы, привязки, эффекты, правила; JSON через `--json`; `--strict` включает W013 (бюджет) |
| `arcod ast [dir]` | печатает канонический AST |
| `arcod plan [dir]` | детерминированный DAG задач: файлы, зависимости, критерии приёмки |
| `arcod openapi [dir]` | документ OpenAPI 3.1 в stdout: пути из `route`, схемы из `types`, ошибки как в рантайме, примеры из блока `examples`; `--service <имя>` выбирает сервис |
| `arcod build [dir]` | scaffold: маршруты, адаптеры, тесты, инфраструктура в `.arcod/build`; тела — TODO |
| `arcod build --impl` | тела из `impl/*.mjs`, адаптер `io`, ничего не додумывает |
| `arcod build --reference` | то же плюс встроенные демо-тела `create`/`read` |
| `arcod test [dir]` | поднимает сгенерированный сервис с in-memory kv и прогоняет `examples` |
| `arcod make [dir]` | весь цикл одной командой: check → prompts → тела → build → test |
| `arcod run [dir]` | build + `docker compose up --build` |
| `arcod run --down` | останавливает окружение (`down --remove-orphans`) |
| `arcod providers` | таблица возможностей, провайдеров и их портов; `--json` |
| `arcod deploy [dir]` | target развёртывания и манифест `deploy.<env>.json`; `--env`, `--json` |
| `arcod prompts [dir]` | только промпты: `--max-tokens`, `--full` (не урезать), `--json` |
| `arcod impl [dir]` | тела операций локальной моделью: `--model`, `--endpoint`, `--dry-run`, `--no-cache`, `--allow-remote` |
| `arcod fmt [dir]` | заглушка v0.1: печатает, что форматтера нет |

Флаги: `--json`, `--env <name>`, `--port <n>`, `--detach`, `--down`,
`--remove-orphans`. У `make`: `--force` (перегенерировать тела), `--skip-impl`,
`--no-test`, `--model`, `--endpoint`, `--reference`, `--port`.
У `ast` — `--check` (разобрать и прогнать проверки), у `test` — `--impl`,
у `run` — `--impl` или `--scaffold`, у `check` — `--strict`.

```bash
arcod make .            # первая сборка с нуля
arcod make . --force    # заново сгенерировать тела
arcod make . --skip-impl --no-test   # только check + prompts + build
```

Каждый шаг — та же функция, что и у отдельной команды, поэтому конвейер не
расходится с ними. Останавливается на первой ошибке и печатает, где именно.

## Провайдеры

Модель называет возможность (`kv`, `sql`, `blob`…), окружение — провайдера
(`redis`, `postgres`, `s3`…). Компилятор знает, какой провайдер реализует
какую возможность, и проверяет это (`A023` неизвестный, `A024` несовместимый,
`A025` двойной bind).

```arcod
environment dev {
  bind db     -> postgres(host: "db", expose: true)
  bind files  -> s3(host: "s3")
  bind stream -> websocket()
}
```

```bash
arcod providers            # таблица возможностей и провайдеров
arcod deploy . --env prod  # target развёртывания и манифест
```

**Возможности с адаптером** (тело операции может их вызывать): `kv` (redis),
`sql` (postgres, mysql, mariadb), `blob` (s3), `identity` (keycloak),
`llm` (ollama, openai), `stream` (websocket, redis), `queue` (redis —
публикация, потребление, повторы, dead letter), `ids` и `hash` — привязываются к
`local`: это специальный провайдер «ничего не нужно», инфраструктуры у него нет.

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

`docker` даёт локальный `docker-compose.yml`; `aws`, `yandex` и
`kubernetes` — декларативный манифест `deploy.<env>.json`
(`"executed": false`: ни кредов, ни вызовов API). Неизвестный провайдер —
`A028`, неизвестный аргумент — `W019`. Compose собирается из локального
окружения, prod-привязки в него не протекают.

```bash
arcod deploy . --env prod          # target и артефакт
arcod deploy . --env prod --json   # манифест
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
- триггеры: `cron(...)`, `event(...)`, `manual`, `after Other`.

Граф декларативный: он попадает в `deploy.<env>.json`, но runner появится
отдельно (`W022`). Состояние запусков, ретраи и лизинг — это отдельная
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

Проверки: `on:` — только у job (`A051`), источник — объявленный `queue`-алиас
(`A052`), `retry` без `on:` — ошибка (`A053`); job с очередью исполняется,
поэтому предупреждение `W017` «job не исполняется» к нему не применяется.

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

Чего в документе нет: `servers` (адрес принадлежит окружению, а не контракту) и
`securitySchemes`. Защищённая операция перечисляет `401`/`403`, но сама
bearer-схема описана только в этом README.

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

Живые примеры: `examples/project1` (Redis) и `examples/project1-mysql` (MySQL) —
одна и та же спека, отличие в двух строках.

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

- `.arcod/build/service/index.mjs` — HTTP-сервис на Node без зависимостей, с
  адаптером под выбранные возможности: RESP-клиент для `kv`, MySQL-клиент для
  `sql`, JWKS для `identity`, S3 для `blob`, OpenAI-совместимый чат для `llm`,
  websocket-хаб и pub/sub для `stream`, очередь с повторами и dead letter для
  `queue` (redis-списки, либо внутрипроцессно, если брокер не привязан);
- `.arcod/build/web/` — статический фронтенд и nginx с проксированием корней
  объявленных маршрутов (`/api`, `/v1`) и `/ws` при потоке `stream` (только при
  объявленном `ui`);
- `.arcod/build/docker-compose.yml` — провайдеры + сервис + фронтенд;
- `.arcod/build/prompts/` — по промпту на операцию и `manifest.json` с хешем
  модели и бюджетом токенов;
- `.arcod/build/deploy.<env>.json` — манифест на каждое окружение с `deploy`.

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
- `A027` операция называет эффект, чей алиас не объявлен в `uses`;
- `A028` неизвестный провайдер развёртывания, `W019` неизвестный аргумент;
- `A029` `needs` ссылается на неизвестный шаг;
- `A030` цикл в графе workflow;
- `A031` у входного порта нет единственного производителя;
- `A032` шаг объявлен дважды;
- `A033` workflow без триггера или с неизвестным триггером;
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
- `W026` внешний сервис вызывают, но адрес не задан;
- `W028` презентация без `stream`: страница будет опрашивать состояние.

`arcod check` возвращает `1` при ошибках и `0`, когда модель чистая.

### Примеры — это тесты

`examples` в модели — не документация, а исполняемые сценарии: `arcod test`
поднимает сервис и прогоняет их. Без флага он берёт reference-тела
(`create`/`read`), с `--impl` — тела из `impl/`.

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

`when` вызывает операции и связывает результаты через `let`, `then` утверждает:
сравнение, `is <Ошибка>`, `&&`, `||`, `!`. `given` (подготовка состояния) в v0.1
не исполняется. Операция без примера — предупреждение `W012`; объявленная
ошибка, которую не обработали и не покрыли примером, — `A007`.

## Редактор — VS Code

Расширение `*.arc` живёт в `editors/vscode`:

- подсветка TextMate: объявления, операции, клаузы, эффекты, типы и длительности;
- провайдеры и возможности различаются цветом — это разные оси;
- дополнение по контексту: после `uses store:` — возможности, после
  `bind x ->` — провайдеры, после `deploy` — провайдеры развёртывания,
  значения `layout`, `overlap`, `catchup`, `onFail`, `trigger`;
- `arcod check --json` на открытии и сохранении: Problems, счётчик в
  статус-баре, ошибки разбора с позицией;
- навигация: Cmd/Ctrl+Click и F12 ведут к объявлению, Shift+F12 — использования,
  hover показывает подпись, одинаковые имена подсвечиваются в файле;
- outline модуля и команды `arcod.check|plan|build|make|deploy|providers`.

```bash
cd editors/vscode
npm install && npm run compile
npx @vscode/vsce package --no-dependencies
code --install-extension arcod-0.1.0.vsix
```

Проверки расширения: `node --test test/*.test.mjs` (грамматика через
vscode-textmate, дополнения, отображение диагностик) и
`node test/runTest.cjs` — запускает настоящий extension host VS Code и
проверяет активацию, распознавание `.arc` и `A002` в Problems.

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
  quiz/                презентация, виджеты и поток событий
test/             node --test
```

Запуск тестов:

```bash
npm test
```

## Ограничения v0.1

Это вертикальный срез, а не готовый язык.

- **Scaffold без тел** (`arcod build` без `--impl`) знает только `create` и
  `read`: встроенных шаблонов для других операций нет. С `--impl` эмиттер
  принимает любые операции и любую из девяти возможностей.
- `kv` в реальном окружении — Redis; in-memory драйвер есть только для
  `arcod test`.
- `arcod fmt` — заглушка, `arcod diff` и `arcod adopt` не реализованы.
- `arcod test` не исполняет `given`; из предикатов поддерживает только `once`.
- `unique` и `ordering` пока не проверяются глубже синтаксиса и циклов.
- Генерация только в JavaScript/Node. PHP, Go и Python — отдельные эмиттеры позже.
- `change`, `policy`, `hint` и `unknown`, а также клаузы `idempotent`, `since`
  и `schedule` парсятся, но не влияют на сборку: это заготовки, а не работающие
  конструкты.
- `lifecycle`, `ordering` и предикаты, кроме `once`, пока декларативны.
- `ui` поддерживает только `kind: spa` и генерирует страницу под операции `create`/`read`; произвольная вёрстка не выражается.
- `budget.latency` и `budget.cost` — декларативные SLO, runtime-проверки для них ещё нет.
- `effects.deny` для `net`, `fs`, `exec` декларативен: рантайм его не применяет (`W016`).
- `job` без `on:`-консьюмера по-прежнему только парсится и не исполняется (`W017`): модели состояния и условия выборки нет, поэтому «expired» не определён. TTL — гарантия провайдера `kv`. Job с очередью исполняется, с повторами и dead letter.
- **В спеке нет тел операций** (`W018`): `build` по умолчанию даёт scaffold с TODO, `--impl` берёт тела из `impl/`, `--reference` подставляет встроенный демо-шаблон.

## Лицензия

MIT
