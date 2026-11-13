module kanban @0.1.0 {
  meta {
    owner: "@andrey"
    status: draft
    since: "2026-11-13"
  }
}

use capability arcod.std.sql @1
use capability arcod.std.ids @1
use capability arcod.std.identity @1
use capability arcod.std.blob @1

type CardId = uuid
type UserId = string
type Status = string
type CardText = string
type Image = bytes(min: 1, max: 5mb)
type Card = {
  id: CardId,
  owner: UserId,
  text: CardText,
  status: Status,
  createdAt: datetime,
  imageId: uuid?
}

error Unauthorized
error Forbidden
error NotFound
error Invalid

service Kanban : http {
  uses store: sql(ttl: 31536000s, consistency: strong)
  uses uuid: ids
  uses auth: identity
  uses files: blob

  effects {
    allow store.get, store.set, store.del, store.scan, uuid.new, auth.actor, files.put, files.get, files.del
    deny net, fs, exec
  }

  contract {
    // A card is always created for the signed-in caller; there is no owner input.
    auth op create(text: CardText, image: Image?) -> Card {
      route: "POST /v1/cards"
      effects: store.set, uuid.new, auth.actor, files.put
      errors: Unauthorized, Invalid
      post: result != null
      on error Unauthorized: text != null
      on error Invalid: text != null
    }

    // The board of the caller only: the body filters by actor, never by client input.
    auth op list(status: Status?) -> list<Card> {
      route: "GET /v1/cards"
      effects: store.scan, auth.actor
      errors: Unauthorized
      on error Unauthorized: result != null
    }

    auth op move(id: CardId, status: Status) -> Card {
      route: "POST /v1/cards/:id/move"
      owner: id
      effects: store.get, store.set
      errors: Unauthorized, NotFound, Forbidden, Invalid
      post: result != null
      on error Unauthorized: id != null
      on error NotFound: id != null
      on error Forbidden: id != null
      on error Invalid: status != null
    }

    auth op remove(id: CardId) -> bool {
      route: "DELETE /v1/cards/:id"
      owner: id
      effects: store.get, store.del, files.del
      errors: Unauthorized, NotFound, Forbidden
      on error Unauthorized: id != null
      on error NotFound: id != null
      on error Forbidden: id != null
    }

    auth op image(id: CardId) -> Image {
      route: "GET /v1/cards/:id/image"
      owner: id
      effects: store.get, files.get
      errors: Unauthorized, NotFound, Forbidden
      on error Unauthorized: id != null
      on error NotFound: id != null
      on error Forbidden: id != null
    }
  }

  examples {
    example create_then_move {
      when {
        let card = create("write the spec", null)
      }
      then {
        move(card.id, "done").status == "done"
      }
    }

    example move_missing_card {
      when {
        let e = move("00000000-0000-0000-0000-000000000000", "done")
      }
      then {
        e is NotFound
      }
    }
  }
}

ui Web {
  kind: spa
  route: "/"
  title: "Kanban"
  uses Kanban.create, Kanban.list, Kanban.move, Kanban.remove, Kanban.image
}

environment dev {
  bind store -> mysql(host: "db", port: 3306)
  bind auth -> keycloak(host: "idp", port: 8080, import: "realm.json")
  bind files -> s3(host: "s3", port: 9000)
  bind uuid -> local
  deploy docker
}
