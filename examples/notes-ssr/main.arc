module notes_ssr @0.1.0 {
  meta {
    owner: "@arcod"
    status: draft
    since: "2026-11-17"
  }
}

use capability arcod.std.kv @1

type NoteText = string
type Note = { id: uuid, text: NoteText }

service Notes : http {
  uses store: kv(ttl: 31536000s, consistency: strong)

  contract {
    public op list() -> list<Note> {
      route: "GET /api/notes"
    }

    public op create(text: NoteText) -> Note {
      route: "POST /api/notes"
    }
  }

  effects {
    allow store.get, store.set, store.scan, store.del
    deny net, fs, exec
  }
}

// render: ssr serves the page from the service itself. The first screen is
// `list` — the first public GET without a path parameter — so its notes are
// already in the HTML and the browser script hydrates them instead of
// fetching again.
ui NotesUi {
  kind:  spa
  route: "/"
  title: "Notes (server-rendered)"
  uses  Notes.list, Notes.create
  render: ssr
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  deploy docker
}
