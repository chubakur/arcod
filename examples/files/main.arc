module files @0.1.0 {
  meta {
    owner: "@andrey"
    status: draft
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

error Unauthorized
error Forbidden
error NotFound
error Invalid

service FileShare : http {
  uses store: sql(ttl: 31536000s, consistency: strong)
  uses uuid: ids
  uses auth: identity
  uses files: blob

  contract {
    public op upload(name: FileName, body: Contents, visibility: Visibility, allowed: list<UserId>) -> FileId {
      route: "POST /v1/files"
      effects: store.set, uuid.new, auth.actor, files.put
      errors: Unauthorized, Invalid
      post: result != null
      on error Unauthorized: name != null
      on error Invalid: visibility != null
    }

    public op list() -> list<FileId> {
      route: "GET /v1/files"
      effects: store.scan, auth.actor
      errors: Unauthorized
      on error Unauthorized: result != null
    }

    public op download(id: FileId) -> { name: FileName, body: Contents } {
      route: "GET /v1/files/:id"
      effects: store.get, auth.actor, files.get
      errors: Unauthorized, NotFound, Forbidden
      on error Unauthorized: id != null
      on error NotFound: id != null
      on error Forbidden: id != null
    }

    public op setVisibility(id: FileId, visibility: Visibility, allowed: list<UserId>) -> bool {
      route: "PUT /v1/files/:id/visibility"
      effects: store.get, store.set, auth.actor
      errors: Unauthorized, NotFound, Forbidden, Invalid
      on error Unauthorized: id != null
      on error NotFound: id != null
      on error Forbidden: id != null
      on error Invalid: visibility != null
    }

    public op users() -> list<UserId> {
      route: "GET /v1/users"
      effects: auth.actor, auth.users
      errors: Unauthorized
      on error Unauthorized: result != null
    }
  }

  effects {
    allow store.get, store.set, store.del, store.scan, uuid.new, auth.actor, auth.users, files.put, files.get
    deny net, fs, exec
  }

  budget {
    latency: p95 <= 120ms
    concurrency: 200
    tokens: <= 60000
    time: 3h
  }
}

ui Web {
  kind: spa
  route: "/"
  title: "Файлы"
  uses FileShare.upload, FileShare.list, FileShare.download, FileShare.setVisibility, FileShare.users
}

environment dev {
  bind store -> mysql(host: "db", port: 3306)
  bind auth -> keycloak(host: "idp", port: 8080, import: "realm.json")
  bind files -> s3(host: "s3", port: 9000)
  bind uuid -> local
}
