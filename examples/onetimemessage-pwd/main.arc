module onetimemessagepwd @0.1.0 {
  meta {
    owner: "@andrey"
    status: draft
    since: "2026-11-10"
    basedOn: "onetimemessage@0.1.0"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1
use capability arcod.std.passwords @1

type MessageId = uuid
type Body = bytes(min: 1, max: 64kb)
type Password = string(min: 1, max: 128)

error NotFound
error Gone
error Invalid
error WrongPassword

service GuardedMessage : http {
  uses store: kv(ttl: 999s, consistency: strong)
  uses uuid: ids
  uses passwords: hash(scrypt)

  budget {
    concurrency: 32
  }

  contract {
    public op create(body: Body, password: Password?) -> MessageId {
      route: "POST /api/messages"
      errors: Invalid
      post: result != null
    }

    public op read(id: MessageId, password: Password?) -> Body {
      route: "GET /api/messages/:id"
      errors: NotFound, Gone, WrongPassword
      post: !store.has(id)
      on error WrongPassword: store.has(id)
    }
  }

  effects {
    allow store.get, store.set, store.del, store.has, uuid.new, passwords.hash, passwords.verify
    deny net, fs, exec
  }

  rules {
    invariant read.at_most_once: once(read, by: id, else: Gone)
    atomic read { get; del }
  }

  examples {
    example guarded_roundtrip {
      when {
        let id = create("hi", "s3cret")
      }
      then {
        read(id, "wrong") is WrongPassword
        read(id, "s3cret") == "hi"
        read(id, "s3cret") is Gone
      }
    }

    example open_message {
      when {
        let id = create("hi")
      }
      then {
        read(id) == "hi"
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
}

ui Web {
  kind:  spa
  route: "/"
  title: "Password-protected message"
  uses  GuardedMessage.create, GuardedMessage.read
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  bind passwords -> local
  deploy docker
}
