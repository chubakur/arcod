module chat @0.1.0 {
  meta {
    owner: "@andrey"
    status: draft
    since: "2026-11-11"
  }
}

use capability arcod.std.sql @1
use capability arcod.std.ids @1
use capability arcod.std.llm @1

type ConversationId = uuid
type UserText = bytes(min: 1, max: 8kb)
type ModelText = bytes(min: 0, max: 32kb)
type Message = { role: string, text: ModelText }

error NotFound
error Invalid
error Unavailable

service Chat : http {
  uses store: sql(ttl: 31536000s, consistency: strong)
  uses uuid: ids
  uses llm: llm

  effects {
    allow store.get, store.set, uuid.new, llm.chat, llm.model
  }

  contract {
    public op start() -> ConversationId {
      route: "POST /v1/conversations"
      effects: store.set, uuid.new
      post: result != null
    }

    public op send(id: ConversationId, text: UserText) -> Message {
      route: "POST /v1/conversations/:id/messages"
      effects: store.get, store.set, llm.chat
      errors: NotFound, Invalid, Unavailable
      post: result != null
      on error NotFound: id != null
      on error Invalid: text != null
      on error Unavailable: text != null
    }

    public op history(id: ConversationId) -> list<Message> {
      route: "GET /v1/conversations/:id"
      effects: store.get
      errors: NotFound
      post: result != null
      on error NotFound: id != null
    }
  }
}

ui Web {
  kind:    spa
  route:   "/"
  title:   "Chat with an agent"
  layout:  chat
  history: Chat.history
  send:    Chat.send
  start:   Chat.start
  uses     Chat.start, Chat.send, Chat.history
}

environment dev {
  bind store -> mysql(host: "db", port: 3306)
  bind uuid -> local
  // A local model. host.docker.internal is the machine running Ollama; the
  // port and the model are binding arguments, not part of the model.
  bind llm -> ollama(host: "host.docker.internal", port: 11434, model: "qwen2.5-coder:7b")
  deploy docker
}

environment prod {
  bind store -> postgres(host: "pg", port: 5432)
  bind uuid -> local
  // Same contract, another provider: any OpenAI-compatible endpoint.
  bind llm -> openai(model: "gpt-4o-mini")
  deploy yandex(region: "ru-central1", folder: "arcod-prod", service: "chat", image: "cr.yandex/arcod/chat:0.1.0")
}
