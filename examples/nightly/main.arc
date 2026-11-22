module nightly @0.1.0 {
  meta {
    owner: "@arcod"
    status: "draft"
    since: "2026-11-22"
  }
}

use capability arcod.std.kv @1

type Snapshot = { label: string }
type Report = { rows: int }

service Reports : http {
  uses store: kv

  effects {
    allow store.insert, store.find
  }

  contract {
    public op prepare() -> Snapshot {
      route: "POST /v1/prepare"
      effects: store.insert
    }

    public op render(snapshot: Snapshot) -> Report {
      route: "POST /v1/render"
      effects: store.insert
    }

    public op send(report: Report) -> string {
      route: "POST /v1/send"
      effects: store.insert
    }
  }

  examples {

    example prepare_snapshot {
      when {
        let snapshot = prepare()
      }
      then {
        snapshot.label == "nightly"
      }
    }

    example render_report {
      when {
        let snapshot = prepare()
        let report = render(snapshot)
      }
      then {
        report.rows == 3
      }
    }

    example send_report {
      when {
        let snapshot = prepare()
        let report = render(snapshot)
        let receipt = send(report)
      }
      then {
        receipt != null
      }
    }
  }
}

workflow Nightly {
  trigger cron("0 3 * * *", tz: "UTC")
  overlap: skip
  catchup: last
  retry: 2
  timeout: 30m

  step prepare() -> Snapshot {
    call: Reports.prepare
  }

  step render(snapshot: Snapshot) -> Report {
    call: Reports.render
    needs: prepare
  }

  step send(report: Report) -> string {
    call: Reports.send
    needs: render
    onFail: stop
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  deploy docker
}
