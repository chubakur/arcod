module saga @0.1.0 {
  meta {
    owner: "@andrey"
    status: draft
    since: "2026-11-12"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1

type MarkerId = uuid
type Marker = { id: MarkerId, label: string }

error Invalid

service Checkout : http {
  uses store: kv
  uses uuid: ids
  uses events: queue

  effects {
    allow store.insert, store.find, store.remove, uuid.new, events.publish
  }

  contract {
    public op mark(label: string) -> Marker {
      route: "POST /v1/mark"
      effects: store.insert, uuid.new
      errors: Invalid
      on error Invalid: label != null
    }
    public op unmark(label: string) -> int {
      route: "DELETE /v1/mark"
      effects: store.find, store.remove
    }
    public op boom(x: string) -> string {
      route: "POST /v1/boom"
    }
    public op peek(label: string) -> int {
      route: "GET /v1/mark"
      effects: store.find
    }
    public op start(label: string) -> string {
      route: "POST /v1/start"
      effects: events.publish
      errors: Invalid
      on error Invalid: label != null
    }
    job run_checkout(label: string) { on: events.checkout saga: checkout }
  }

  saga checkout {
    step mark { call: mark compensate: unmark }
    step boom { call: boom }
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  bind events -> redis(host: "kv", port: 6379)
  deploy docker
}
