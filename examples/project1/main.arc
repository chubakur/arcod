module project1 @0.1.0 {
  meta {
    owner: "@andrey"
    status: draft
    since: "2026-11-11"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1

type MessageId = uuid
type Author = bytes(min: 1, max: 255)
type Body = bytes(min: 1, max: 64kb)

error NotFound
error Gone
error Invalid

service OneTimeMessage : http {
  uses store: kv(ttl: 999s, consistency: strong)
  uses uuid: ids

  contract {
    public op create(author: Author, body: Body) -> MessageId {
      route: "POST /v1/api/messages"
      errors: Invalid
      post: result != null
    }

    public op read(id: MessageId) -> { author: Author, body: Body } {
      route: "GET /v1/api/messages/:id"
      errors: NotFound, Gone
      post: !store.has(id)
    }

  }

  rules {
    invariant read.at_most_once: once(read, by: id, else: Gone)
    atomic read { get; del }
  }

  effects {
    allow store.get, store.set, store.del, store.has, uuid.new
    deny net, fs, exec
  }

  budget {
    latency: p95 <= 50ms
    concurrency: 100
    tokens: <= 40000
    time: 2h
  }

  examples {
    example create_and_read {
      when {
        let id = create("baby", "hi")
      }
      then {
        let msg = read(id)
        msg.author == "baby"
        msg.body == "hi"
        read(id) is Gone
        read(uuid("00000000-0000-0000-0000-000000000000")) is NotFound
      }
    }

    example seeded_read {
      given {
        let id = create("andy", "seeded")
      }
      when {
        let msg = read(id)
      }
      then {
        msg.author == "andy"
        msg.body == "seeded"
        read(id) is Gone
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
}

ui Web {
  kind:  spa
  route: "/"
  title: "Project1. OneTimeMessage"
  uses  OneTimeMessage.create, OneTimeMessage.read
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  deploy docker
}
