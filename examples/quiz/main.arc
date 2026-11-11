module quiz @0.1.0 {
  meta {
    owner: "@andrey"
    status: draft
    since: "2026-11-11"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1
use capability arcod.std.stream @1

type SessionId = uuid
type Code = string
type Session = { id: SessionId, code: Code, token: string }
type Member = { id: SessionId, token: string, name: string }
type Comment = { name: string, text: string }
type Tally = {
  index: number,
  counts: list<number>,
  average: number,
  rated: number,
  comments: list<Comment>,
  joined: number
}
type Ack = { ok: boolean }

error NotFound
error Invalid
error Forbidden
error Unavailable

service Live : http {
  uses store: kv(ttl: 86400s, consistency: strong)
  uses uuid: ids
  uses stream: stream

  effects {
    allow store.get, store.set, uuid.new, stream.publish
  }

  contract {
    // The host opens a room: one short code, one presenter token.
    public op start() -> Session {
      route: "POST /v1/sessions"
      effects: store.get, store.set, uuid.new
      errors: Unavailable
      post: result != null
      on error Unavailable: result == null
    }

    // A guest joins by the code shown on the screen, and gets a token of their
    // own: the host never shares its token with the audience.
    public op join(code: Code, name: string) -> Member {
      route: "POST /v1/sessions/:code/join"
      effects: store.get, store.set, stream.publish
      errors: NotFound, Invalid
      post: result != null
      on error NotFound: code != null
      on error Invalid: name != null
    }

    // The live state of the room: which slide is on, what the audience
    // answered and wrote. Polled by both views.
    public op state(id: SessionId, token: string) -> Tally {
      route: "GET /v1/sessions/:id"
      effects: store.get
      errors: NotFound, Forbidden
      post: result != null
      on error NotFound: id != null
      on error Forbidden: token != null
    }

    // Only the host moves the deck. The total comes from the page, because the
    // deck lives in the model, not in the service.
    public op advance(id: SessionId, token: string, delta: number, total: number) -> Ack {
      route: "POST /v1/sessions/:id/advance"
      effects: store.get, store.set, stream.publish
      errors: NotFound, Invalid, Forbidden
      post: result != null
      on error Forbidden: token != null
    }

    public op vote(id: SessionId, token: string, choice: number) -> Ack {
      route: "POST /v1/sessions/:id/votes"
      effects: store.get, store.set, stream.publish
      errors: NotFound, Invalid, Forbidden
      post: result != null
      on error Forbidden: token != null
      on error Invalid: choice != null
    }

    public op rate(id: SessionId, token: string, value: number) -> Ack {
      route: "POST /v1/sessions/:id/ratings"
      effects: store.get, store.set, stream.publish
      errors: NotFound, Invalid, Forbidden
      post: result != null
      on error Forbidden: token != null
      on error Invalid: value != null
    }

    public op comment(id: SessionId, token: string, text: string) -> Ack {
      route: "POST /v1/sessions/:id/comments"
      effects: store.get, store.set, stream.publish
      errors: NotFound, Invalid, Forbidden
      post: result != null
      on error Forbidden: token != null
      on error Invalid: text != null
    }
  }
}

ui Stage {
  kind:    spa
  route:   "/"
  title:   "Квиз: arcod"
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
    body: "Отметьте свою роль — результат появится на экране."
    poll("Бэкенд", "Фронтенд", "QA", "Продукт")
  }

  slide "Подключение" {
    body: "Откройте ссылку или отсканируйте код, чтобы отвечать со своего телефона."
    qr
  }

  slide "Насколько полезно?" {
    body: "Оцените доклад от 1 до 5."
    rating(max: 5)
  }

  slide "Что осталось непонятным?" {
    body: "Напишите вопрос — ведущий увидит его на экране."
    comments
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  bind stream -> websocket()
  deploy docker
}

environment prod {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  bind stream -> websocket()
  deploy yandex(region: "ru-central1", folder: "arcod-prod", service: "quiz", image: "cr.yandex/arcod/quiz:0.1.0")
}
