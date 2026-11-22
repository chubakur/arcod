module files @0.1.0 {
  meta {
    owner: "@andrey"
    status: "draft"
    since: "2026-11-11"
  }
}

use capability arcod.std.sql @1
use capability arcod.std.ids @1
use capability arcod.std.identity @1
use capability arcod.std.blob @1

type FileId = uuid
type UserId = string
type FileName = bytes(min: 1, max: 255)
type Contents = bytes(min: 1, max: 64kb)
type Visibility = string

// A listing row as the browser renders it: the share sheet shows a name and a
// size, so handing back ids alone would force one fetch per row.
type FileRef = { id: FileId, name: FileName, owner: UserId, ownerName: UserId, visibility: Visibility, allowed: list<UserId>, size: int }

error Unauthorized
error Forbidden
error NotFound
error Invalid

service FileShare : http {
  uses store: sql(ttl: 31536000s)
  uses uuid: ids
  uses auth: identity
  uses files: blob

  effects {
    allow store.get, store.set, store.del, store.scan, uuid.new, auth.actor, auth.users, files.put, files.get
    deny net, fs, exec
  }

  contract {
    auth op upload(name: FileName, body: Contents, visibility: Visibility, allowed: list<UserId>) -> FileId {
      route: "POST /v1/files"
      effects: store.set, uuid.new, auth.actor, files.put
      errors: Unauthorized, Invalid
      post: result != null
      on error Unauthorized: name != null
      on error Invalid: visibility != null
    }

    public op list() -> list<FileRef> {
      route: "GET /v1/files"
      effects: store.scan
      errors: none
    }

    public op download(id: FileId) -> { name: FileName, body: Contents } {
      route: "GET /v1/files/:id"
      effects: store.get, files.get
      errors: Unauthorized, NotFound, Forbidden
      on error Unauthorized: id != null
      on error NotFound: id != null
      on error Forbidden: id != null
    }

    auth op setVisibility(id: FileId, visibility: Visibility, allowed: list<UserId>) -> bool {
      route: "PUT /v1/files/:id/visibility"
      owner: id
      effects: store.get, store.set
      errors: Unauthorized, NotFound, Forbidden, Invalid
      on error Unauthorized: id != null
      on error NotFound: id != null
      on error Forbidden: id != null
      on error Invalid: visibility != null
    }

    auth op users() -> list<UserId> {
      route: "GET /v1/users"
      effects: auth.users
      errors: Unauthorized
      on error Unauthorized: result != null
    }
  }

  examples {

    // The owner uploads, reads the bytes back and narrows who may read them.
    // The contents live in the blob store; the row keeps only the metadata.
    example upload_read_and_share {
      when {
        let id = upload("notes.txt", "hello", "public", [])
        let got = download(id)
        let shared = setVisibility(id, "authenticated", [])
      }
      then {
        got.name == "notes.txt"
        got.body == "hello"
        shared == true
      }
    }

    // A listing carries what the browser renders (name, size, sharing), and the
    // name sorts first so the assertion does not depend on the scan order.
    example listing_carries_metadata {
      when {
        let id = upload("a-plan.txt", "v1", "public", [])
        let listing = list()
        let got = download(listing[0].id)
      }
      then {
        listing[0].name == "a-plan.txt"
        listing[0].size == 2
        got.body == "v1"
      }
    }

    // The audience picker reads the identity provider's users, not the store.
    example users_are_listed {
      when {
        let people = users()
      }
      then {
        people != null
      }
    }
  }

  budget {
    latency: p95 <= 120ms
    concurrency: 200
    tokens: <= 60000
    time: 3h
  }
}

environment dev {
  bind store -> mysql(host: "db", port: 3306)
  bind auth -> keycloak(host: "idp", port: 8080, import: "realm.json")
  bind files -> s3(host: "s3", port: 9000)
  bind uuid -> local
  deploy docker
}

environment prod {
  bind store -> postgres
  bind auth -> keycloak(host: "idp", port: 8080)
  bind files -> s3(host: "s3", port: 9000)
  bind uuid -> local
  deploy yandex(region: "ru-central1", folder: "arcod-prod", service: "files", image: "cr.yandex/arcod/files:0.1.0")
}

ui Web {
  kind: spa
  route: "/"
  title: "Files"
  uses FileShare.upload, FileShare.list, FileShare.download, FileShare.setVisibility, FileShare.users
}
