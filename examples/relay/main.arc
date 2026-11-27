module relay @0.1.0 {
  meta {
    owner: "@andrey"
    status: "draft"
    since: "2026-11-27"
  }
}

use capability arcod.std.endpoint @1

type Receipt = { status: int, body: string }

error Unavailable

service Relay : http {
  uses hook: endpoint

  effects {
    allow hook.call
  }

  contract {
    // One outbound call per request. The body chooses the path; the binding
    // owns the host, so this service can never reach a host the environment
    // did not declare - and W053 catches a literal path that tries.
    public op notify(label: string) -> Receipt {
      route: "POST /v1/notify"
      effects: hook.call
      errors: Unavailable
    }
  }

  examples {

    // A test process binds no URL, so the call answers the declared
    // Unavailable instead of a generic 500. A real run gets API_URL from the
    // bind and the same body returns { status, body }.
    example unbound_endpoint {
      when {
        let receipt = notify("hello")
      }
      then {
        receipt is Unavailable
      }
    }
  }
}

environment dev {
  bind hook -> endpoint(url: "https://api.example.com")
  deploy docker
}
