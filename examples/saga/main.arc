module saga @0.1.0 {
  meta {
    owner: "@andrey"
    status: "draft"
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

    // The step that fails on purpose. The failure is a declared error, not a
    // 500, so the saga can tell a business rollback from a crash.
    public op boom(x: string) -> string {
      route: "POST /v1/boom"
      errors: Invalid
      on error Invalid: x != null
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

    job run_checkout(label: string) {
      on: events.checkout
      saga: checkout
    }
  }

  saga checkout {
    step mark { call: mark compensate: unmark }
    step boom { call: boom }
  }

  examples {

    // A mark is visible to a reader as one row, and unmark removes it: the
    // compensation the saga calls is the same operation a client can call.
    example mark_then_unmark {
      when {
        let m = mark("order-1")
      }
      then {
        peek("order-1") == 1
        m.label == "order-1"
        unmark("order-1") == 1
        peek("order-1") == 0
      }
    }

    // start() is the fire-and-forget edge: it accepts the label and answers
    // with the id it published, so a caller does not wait for the saga.
    example start_publishes {
      when {
        let id = start("order-2")
      }
      then {
        id != null
      }
    }

    // A failing step is a declared error: the caller reads Invalid, and the
    // saga compensates the mark it already made instead of hanging half done.
    example boom_is_invalid {
      when {
        let out = boom("order-3")
      }
      then {
        out is Invalid
      }
    }
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  bind events -> redis(host: "kv", port: 6379)
  deploy docker
}
