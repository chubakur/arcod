module payments @0.1.0 {
  meta {
    owner: "@andrey"
    status: draft
    since: "2026-11-11"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1

// Чужой сервис. Описываем только то, что вызываем: маршруты и типы.
// Ни контейнера, ни тела, ни тестов для него не генерируется.
external service Ledger : http {
  contract {
    op record(entry: Entry) -> Receipt {
      route: "POST /v1/entries"
    }
  }
}

type OrderId = uuid
type Amount = int
type Entry = { order: OrderId, amount: Amount }
type Receipt = { id: string, accepted: bool }

error Invalid
error Unavailable

service Orders : http {
  uses store: kv(ttl: 86400s)
  uses uuid: ids

  effects {
    allow store.set, uuid.new, Ledger.record
  }

  contract {
    public op charge(amount: Amount) -> Receipt {
      route: "POST /v1/orders"
      effects: store.set, uuid.new, Ledger.record
      errors: Invalid, Unavailable
      post: result != null
      on error Invalid: amount != null
      on error Unavailable: amount != null
    }
  }
}

environment dev {
  bind store  -> redis(host: "kv", port: 6379)
  bind uuid   -> local
  // Адрес чужого сервиса. localhost перепишется в host.docker.internal,
  // чтобы контейнер дотянулся до процесса на машине разработчика.
  bind Ledger -> endpoint(url: "http://localhost:9009")
  deploy docker
}

environment prod {
  bind store  -> postgres(host: "pg", port: 5432)
  bind uuid   -> local
  bind Ledger -> endpoint(url: "https://ledger.internal.example.com", network: "shared")
  deploy yandex(region: "ru-central1", folder: "arcod-prod", service: "orders", image: "cr.yandex/arcod/orders:0.1.0")
}
