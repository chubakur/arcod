module vector @0.1.0 {
  meta {
    owner: "@andrey"
    status: "draft"
    since: "2026-11-19"
  }
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1
use capability arcod.std.llm @1

type DocId = uuid
type Text = bytes(min: 1, max: 8kb)

// A note keeps the vector next to the text: the body never invents an
// embedding and never hashes one itself.
type Note = { id: DocId, text: Text, vector: list<float> }

type Hit = { id: DocId, text: Text, score: float }

error Invalid

// The embedding call leaves the process: a provider can be down or throttle,
// and the route has to say so instead of answering 500 Internal.
error Unavailable

service Docs : http {
  uses store: kv
  uses uuid: ids
  uses model: llm

  effects {
    allow store.insert, store.find, uuid.new, model.embed
  }

  contract {
    public op add(text: Text) -> { id: DocId, dim: int } {
      route: "POST /v1/notes"
      effects: store.insert, uuid.new, model.embed
      errors: Invalid, Unavailable
      post: result != null
      on error Invalid: text != null
      on error Unavailable: text != null
    }

    public op search(q: Text, limit: int?) -> { items: list<Hit> } {
      route: "POST /v1/search"
      effects: store.find, model.embed
      errors: Invalid, Unavailable
      post: result != null
      on error Invalid: q != null
      on error Unavailable: q != null
    }
  }

  examples {

    // The body never invents an embedding: add() stores the vector the model
    // returned, and the declared dim is the width it checked. arcod test
    // supplies a memory model of the declared width.
    example add_then_search {
      when {
        let note = add("the quick brown fox")
        let found = search("quick", 3)
      }
      then {
        note.dim == 768
        found.items[0].id == note.id
      }
    }
  }
}

environment dev {
  bind store -> redis(host: "kv")
  bind uuid -> local
  // A local model on the host; port and model are binding arguments, not part
  // of the module. dim is the promise the binding makes about every vector it
  // returns: a model whose width differs fails the operation instead of
  // storing a vector that cannot be compared with the rest.
  bind model -> ollama(host: "host.docker.internal", port: 11434, model: "nomic-embed-text", dim: 768)
  deploy docker
}
