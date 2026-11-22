module nightly @0.1.0 {
  meta {
    owner: "@arcod"
    status: "draft"
    since: "2026-11-22"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1

type Snapshot = { id: uuid, label: string, takenAt: datetime }
type Report = { rows: int, snapshot: uuid }

error NotFound

service Reports : http {
  uses store: kv
  uses uuid: ids

  effects {
    allow store.insert, store.find, uuid.new
  }

  contract {
    public op prepare(label: string?) -> Snapshot {
      route: "POST /v1/prepare"
      effects: store.insert, uuid.new
    }

    public op render(snapshot: Snapshot) -> Report {
      route: "POST /v1/render"
      effects: store.find
      errors: NotFound
      post: result != null
      on error NotFound: snapshot != null
    }

    public op send(report: Report) -> bool {
      route: "POST /v1/send"
    }
  }

  examples {

    example prepare_snapshot {
      when {
        let snapshot = prepare("nightly")
      }
      then {
        snapshot.label == "nightly"
      }
    }

    example render_report {
      when {
        let snapshot = prepare("nightly")
        let report = render(snapshot)
      }
      then {
        report.rows == 7
        report.snapshot == snapshot.id
      }
    }

    example send_report {
      when {
        let snapshot = prepare("nightly")
        let report = render(snapshot)
        let receipt = send(report)
      }
      then {
        receipt == true
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

  step prepare(label: string?) -> Snapshot {
    call: Reports.prepare
  }

  step render(snapshot: Snapshot) -> Report {
    call: Reports.render
    needs: prepare
  }

  step send(report: Report) -> bool {
    call: Reports.send
    needs: render
    onFail: stop
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  deploy docker
}
