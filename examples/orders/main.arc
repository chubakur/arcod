module orders @0.1.0 {
  meta {
    owner: "@andrey"
    status: "draft"
    since: "2026-11-12"
  }
}

use capability arcod.std.sql @1
use capability arcod.std.ids @1
use capability arcod.std.queue @1

type OrderId = uuid
type Order = { id: OrderId, sku: string, qty: int, placedAt: datetime }

error Invalid
error Conflict

service Orders : http {
  uses store: sql(ttl: 604800s)
  uses uuid: ids
  uses events: queue

  effects {
    allow store.insert, uuid.new, events.publish
  }

  rules {
    unique Order.sku
  }

  contract {
    public op create(sku: string, qty: int) -> Order {
      route: "POST /v1/orders"
      effects: store.insert, uuid.new, events.publish
      errors: Invalid, Conflict
      post: result != null
      on error Invalid: result == null
      on error Conflict: result == null
    }
  }

  examples {

    // The unique rule is a promise, not a comment: the second order with the
    // same sku gets the declared Conflict instead of a duplicate row.
    example create_then_conflict {
      when {
        let first = create("sku-1", 2)
        let second = create("sku-1", 1)
      }
      then {
        first.qty == 2
        second is Conflict
      }
    }
  }
}

environment dev {
  bind store -> mysql
  bind uuid -> local
  bind events -> redis
  deploy docker
}

// The cloud has no managed mysql in the provider table: a real deployment
// binds postgres (the managed equivalent) and the dialect follows the bind.
environment prod {
  bind store -> postgres
  bind uuid -> local
  bind events -> redis
  deploy yandex(region: "ru-central1", folder: "arcod-prod", service: "orders", image: "cr.yandex/arcod/orders:0.1.0")
}
