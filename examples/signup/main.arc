module signup @0.1.0 {
  meta {
    owner: "@andrey"
    status: "draft"
    since: "2026-11-17"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1

// The address and the site are strings with a promise attached. The promise is
// published as OpenAPI format, checked by check() on defaults and enforced by
// the generated service before the body runs.
type Account = { id: uuid, email: email, website: url?, plan: Plan = "free", createdAt: datetime }

error Invalid
error Conflict
error NotFound

// A plan is a closed set: an unknown value is a client mistake, and the
// service rejects it at the boundary instead of storing a typo.
enum Plan { free, pro, team }

service Signup : http {
  uses store: kv(ttl: 604800s)
  uses uuid: ids

  effects {
    allow store.insert, store.find, uuid.new
  }

  rules {
    unique Account.email
  }

  contract {
    public op create(email: email, website: url?, plan: Plan?) -> Account {
      route: "POST /v1/accounts"
      effects: store.insert, uuid.new
      errors: Invalid, Conflict
      post: result != null
      on error Invalid: email != null
      on error Conflict: email != null
    }

    public op find(id: uuid) -> Account {
      route: "GET /v1/accounts/:id"
      effects: store.find
      errors: NotFound
      post: result != null
      on error NotFound: id != null
    }
  }

  examples {

    example create_account {
      when {
        let account = create("a@example.com", "https://example.com", "pro")
      }
      then {
        account.plan == "pro"
      }
    }
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  deploy docker
}
