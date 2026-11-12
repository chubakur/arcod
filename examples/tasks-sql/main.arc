module tasks_sql @0.1.0 {
  meta {
    owner: "@andrey"
    status: draft
    since: "2026-11-12"
  }
}

use capability arcod.std.sql @1
use capability arcod.std.ids @1

type TaskId = uuid
type Status = string
type Priority = int
type Task = {
  id: TaskId,
  title: string,
  status: Status,
  priority: Priority,
  createdAt: datetime,
  dueAt: datetime?,
  doneAt: datetime?
}

error Invalid
error NotFound
error Conflict

service TaskBoard : http {
  uses store: sql(ttl: 604800s)
  uses uuid: ids

  effects {
    allow store.insert, store.find, store.update, uuid.new
  }

  rules {
    // A title is the human key of a task: two open tasks may not share one.
    unique Task.title
  }

  contract {
    public op create(title: string, priority: Priority, dueAt: datetime?) -> Task {
      route: "POST /v1/tasks"
      effects: store.insert, uuid.new
      errors: Invalid, Conflict
      post: result != null
      on error Invalid: title != null
      on error Conflict: title != null
    }

    // Filter, order and keyset pagination live in the query, not in the body.
    public op list(status: Status?, sort: string?, limit: int?, cursor: string?) -> { items: list<Task>, next: string? } {
      route: "GET /v1/tasks"
      effects: store.find
      errors: Invalid
      post: result.items != null
      on error Invalid: limit != null
    }

    public op move(id: TaskId, status: Status) -> Task {
      route: "POST /v1/tasks/:id/move"
      effects: store.update
      errors: NotFound, Invalid
      post: result != null
      on error NotFound: id != null
      on error Invalid: id != null
    }
  }

  examples {
    example create_then_move {
      when {
        let task = create("write the docs", 2, null)
      }
      then {
        move(task.id, "done").status == "done"
      }
    }

    // The same title twice is a declared Conflict, not an accidental overwrite.
    example duplicate_title_is_conflict {
      when {
        let first = create("unique title", 1, null)
        let second = create("unique title", 2, null)
      }
      then {
        second is Conflict
      }
    }
  }
}

environment dev {
  bind store -> mysql()
  bind uuid -> local
  deploy docker
}

environment prod {
  bind store -> mysql()
  bind uuid -> local
  deploy yandex(region: "ru-central1", folder: "arcod-prod", service: "tasks-sql", image: "cr.yandex/arcod/tasks-sql:0.1.0")
}
