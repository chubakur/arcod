module onetimemessage @0.1.0 {
  meta {
    owner: "@andrey"
    status: "draft"
    since: "2026-11-10"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1

type MessageId = uuid
type Body = bytes(min: 1, max: 64kb)

error NotFound
error Gone
error Invalid

service OneTimeMessage : http {
  uses store: kv(ttl: 999s)
  uses uuid: ids

  effects {
    allow store.get, store.set, store.del, store.has, uuid.new
    deny net, fs, exec
  }

  rules {
    invariant read.at_most_once: once(read, by: id, else: Gone)
    atomic read { get; del }
  }

  contract {
    public op create(body: Body) -> MessageId {
      route: "POST /api/messages"
      errors: Invalid
      post: result != null
    }

    public op read(id: MessageId) -> Body {
      route: "GET /api/messages/:id"
      errors: NotFound, Gone
      post: !store.has(id)
    }
  }

  examples {

    example create_and_read {
      when {
        let id = create("hi")
      }
      then {
        read(id) == "hi"
        read(id) is Gone
        read(uuid("00000000-0000-0000-0000-000000000000")) is NotFound
      }
    }

    example rejects_empty {
      when {
        let e = create("")
      }
      then {
        e is Invalid
      }
    }
  }

  budget {
    latency: p95 <= 50ms
    concurrency: 100
    tokens: <= 40000
    time: 2h
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  deploy docker
}

ui Web {
  kind: spa
  route: "/"
  title: "One-time message"
  uses OneTimeMessage.create, OneTimeMessage.read
}
