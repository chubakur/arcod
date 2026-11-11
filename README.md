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
| `arcod check [dir]` | парсит, проверяет типы, привязки, эффекты, правила; JSON через `--json`; `--strict` включает W013 (бюджет) |
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
arcod deploy . --env prod  # target развёртывания и манифест
```

Реестр: redis, postgres, mysql, mariadb, mongodb, keycloak, s3 (minio), rabbitmq,
kafka, nginx, liquibase, clickhouse, prometheus, sentry, jaeger, grafana, mailpit,
vault. На каждый bind генерируется
сервис в compose с healthcheck, томом и env; порты публикуются только при
`expose: true`.

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

Соглашение о видимости живёт в одном месте — `canRead` в телах операций:

| Кто | public | authenticated | restricted |
|---|---|---|---|
| аноним | да | нет | нет |
| авторизованный | да | да | только из списка |
| администратор | да | да | да |

Страница UI тоже строится из контракта: по форме на публичную операцию,
поля по параметрам, результат — по форме ответа.

### Презентация с виджетами

`layout: presentation` — это одна страница для двух аудиторий: ведущий
открывает её на экране, участники заходят по коду или QR с телефона. Слайды и
виджеты объявлены в модели, поэтому страница не угадывает, что показывать.

```arcod
ui Stage {
  kind:    spa
  route:   "/"
  layout:  presentation
  start:   Live.start
  join:    Live.join
  state:   Live.state
  advance: Live.advance
  vote:    Live.vote
  rate:    Live.rate
  comment: Live.comment
  uses     Live.start, Live.join, Live.state, Live.advance, Live.vote, Live.rate, Live.comment

  slide "Кто вы?" {
    body: "Отметьте роль — результат появится на экране."
    poll("Бэкенд", "Фронтенд", "QA", "Продукт")
  }
  slide "Подключение" { qr }
  slide "Насколько полезно?" { rating(max: 5) }
  slide "Вопросы" { comments }
}
```

Правила:

- `start`, `join`, `state`, `advance` обязательны (`A040`): ведущий создаёт
  сеанс, гость входит по коду, оба опрашивают состояние, ведущий двигает деку;
- виджеты не рендерятся «на всякий случай»: `poll` требует `vote`, `rating` —
  `rate`, `comments` — `comment` (`A045`), иначе контролы некуда отправлять;
- `qr` рисуется на клиенте из ссылки на текущий сеанс; код генерируется
  сервисом, поэтому QR всегда ведёт на живую комнату;
- коды `A041`–`A044` ловят пустую деку, слайд без виджета, `poll` из одного
  варианта и шкалу вне 2..10; `W027` — забыли слайд с QR.

Живой пример: `examples/quiz`. Ведущий получает код и QR, гость отвечает на
опрос, ставит оценку и пишет комментарий; ведущий видит проценты и ленту на
своём экране. Обновление — опросом `state` раз в 1.5 с: в языке пока нет
потоковой возможности, и это осознанное ограничение, а не недосмотр.

Подробнее: `Проект «Файлы» — Keycloak и S3` в заметках проекта.

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
- `A042` слайд без виджета;
- `A043` у `poll` меньше двух вариантов;
- `A044` у `rating(max: n)` n вне 2..10;
- `A045` виджет без своей операции (poll → vote, rating → rate, comments → comment);
- `W026` внешний сервис вызывают, но адрес не задан;
- `W027` в презентации нет слайда с `qr`.

`arcod check` возвращает `1` при ошибках и `0`, когда модель чистая.

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
  plan.ts         DAG задач
  build.ts        сборка примера в .arcod/build
  emit/service.ts генерация сервиса
  emit/llm.ts     адаптер модели (OpenAI-совместимый чат)
  emit/chat-page.ts страница для layout: chat
  emit/web.ts     генерация фронтенда
  emit/compose.ts Dockerfile и compose
  cli.ts          команды
editors/vscode/ расширение VS Code: грамматика, дополнения, проверки
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
