// The Go port kit (B107) generates a service that answers the same contract as
// the Node emitter: routes, the input-kind table and success statuses come from
// the contract IR. The kit is deliberately narrow — a feature it cannot carry is
// refused by name instead of being half-generated.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { goUnsupported } from '../src/emit/go.ts';

const spec = (extra = ''): string => `module gokit @0.1.0 {}

type ItemId = uuid
type Name = bytes(min: 1, max: 64)

error NotFound
error Invalid
${extra}
service Catalog : http {
  language: go

  contract {
    public op list(limit: int) -> { items: list<Name> } {
      route: "GET /v1/items"
      errors: Invalid
    }

    public op read(id: ItemId) -> { name: Name } {
      route: "GET /v1/items/:id"
      errors: NotFound
    }

    public op create(id: ItemId, name: Name) -> { name: Name } {
      route: "POST /v1/items"
      errors: Invalid
    }

    public op rename(id: ItemId, name: Name) -> { name: Name } {
      route: "POST /v1/items/:id/name"
      errors: Invalid, NotFound
      status: 200
    }
  }
}

environment dev {
  deploy docker
}
`;

async function build(source: string) {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-go-'));
  const mod = parse(source, 'main.arc');
  const result = await buildExample(mod, dir, { reference: true, implDir: null });
  return { dir, result };
}

test('a go service gets main.go with the contract routes and input kinds', async () => {
  const { dir, result } = await build(spec());
  try {
    const main = await readFile(join(dir, '.arcod', 'build', 'service', 'main.go'), 'utf8');
    // ':id' becomes Go 1.22's '{id}'; the method stays uppercased from the IR.
    assert.match(main, /mux\.HandleFunc\("GET \/v1\/items\/\{id\}", handleRead\)/);
    assert.match(main, /mux\.HandleFunc\("POST \/v1\/items\/\{id\}\/name", handleRename\)/);
    // Only the int is coerced: a uuid or a bytes value already arrives as text.
    assert.match(main, /input\(r, map\[string\]string\{"limit": "int"\}, \[\]string\{"limit"\}\)/);
    assert.match(main, /input\(r, nil, \[\]string\{"id"\}\)/);
    // A declared status wins; the default follows the method.
    assert.match(main, /writeJSON\(w, 200, out\)/);
    assert.match(main, /writeJSON\(w, 201, out\)/);
    assert.match(main, /ErrNotFound = &OpError\{Name: "NotFound", Status: 404, Message: "not found"\}/);
    assert.match(main, /ErrInvalid = &OpError\{Name: "Invalid", Status: 400, Message: "invalid request"\}/);
    assert.match(main, /mux\.HandleFunc\("GET \/healthz", health\)/);

    const ops = await readFile(join(dir, '.arcod', 'build', 'service', 'ops.go'), 'utf8');
    // The body receives the facade and the inputs; one signature for every op.
    assert.match(ops, /func opRead\(io \*arcodio\.IO, in map\[string\]any\) \(any, error\)/);
    assert.match(ops, /func opRename\(io \*arcodio\.IO, in map\[string\]any\) \(any, error\)/);
    assert.match(ops, /import arcodio "arcod\/catalog\/arcodio"/);
    assert.match(main, /out, err := opRead\(arc, in\)/);
    // The facade is package-level: every handler closure reads it, and a
    // service with no op keeps it unused (legal for a package var, not a local).
    assert.match(main, /var arc = arcodio\.Connect\(\)/);
    assert.match(ops, /NotImplemented/);

    const dockerfile = await readFile(join(dir, '.arcod', 'build', 'service', 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^FROM golang:1\.23-alpine/m);
    assert.match(dockerfile, /go build -trimpath/);
    assert.match(dockerfile, /^EXPOSE 3000$/m);

    const gomod = await readFile(join(dir, '.arcod', 'build', 'service', 'go.mod'), 'utf8');
    assert.match(gomod, /^module arcod\/catalog$/m);
    assert.match(gomod, /^go 1\.23$/m);

    // The Node runtime is not written beside the Go one.
    assert.equal(result.files.some((file) => file.endsWith(join('service', 'index.mjs'))), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The refusal list is the contract of the first kit. A feature that quietly
// drops off it would be generated as a service that ignores the declaration,
// so every name is pinned here, not only the store and the stream.
test('every feature the go kit cannot carry is named', () => {
  const loc = { line: 1, column: 1, offset: 0 };
  const base = { contract: [], sagas: [], roles: [], uses: [] };
  const named = (svc: object, mod: object = { uis: [] }): string[] =>
    goUnsupported(mod as never, { ...base, ...svc } as never);
  // kv is carried by the arcodio facade, so it is not a refusal any more.
  assert.deepEqual(named({ uses: [{ alias: 'store', capability: 'arcod.std.kv', params: {}, loc }] }), []);
  assert.deepEqual(named({ uses: [{ alias: 'store', capability: 'arcod.std.sql', params: {}, loc }] }), ['store: sql']);
  assert.deepEqual(named({ uses: [{ alias: 'live', capability: 'arcod.std.stream', params: {}, loc }] }), ['stream']);
  // The queue is carried whole: arcodio/queue.go publishes, and a job op is
  // run by the consumer loop in main.go.
  assert.deepEqual(named({ uses: [{ alias: 'events', capability: 'arcod.std.queue', params: {}, loc }] }), []);
  assert.deepEqual(named({ uses: [{ alias: 'api', capability: 'arcod.std.graphql', params: {}, loc }] }), ['graphql']);
  assert.deepEqual(named({ uses: [{ alias: 'reports', capability: 'arcod.std.olap', params: {}, loc }] }), ['olap']);
  assert.deepEqual(named({ uses: [{ alias: 'mailer', capability: 'arcod.std.mail', params: {}, loc }] }), ['mail']);
  assert.deepEqual(named({ uses: [{ alias: 'files', capability: 'arcod.std.files', params: {}, loc }] }), ['files']);
  assert.deepEqual(named({}, { uis: [{}] }), ['ui page']);
  assert.deepEqual(named({ roles: ['admin'] }), ['roles']);
  assert.deepEqual(named({ sagas: [{}] }), ['saga']);
  assert.deepEqual(named({ contract: [{ kind: 'job', name: 'fulfil', clauses: [], loc }] }), []);
  // A job that drives a saga instead of a body is still refused by name: the
  // Go kit carries no saga runner, and a loop that dropped the message would
  // lose the work silently.
  assert.deepEqual(
    named({ contract: [{ kind: 'job', name: 'fulfil', clauses: [{ kind: 'saga', name: 'checkout', loc }], loc }] }),
    ['saga job fulfil'],
  );
  assert.deepEqual(named({ contract: [{ kind: 'op', auth: true, loc }] }), ['auth']);
});

// The queue's publish half (B107.5b): the message has to land in
// the format the Node consumer already reads — RPUSH on 'arcod:q:<topic>' with
// {"payload":…,"attempts":0} — because the two languages may share one broker.
test('a queue-bound go service publishes in the node wire format', async () => {
  const source = `module goq @0.1.0 {}

use capability arcod.std.queue @1

type OrderId = uuid
error Invalid

service Orders : http {
  language: go
  uses events: queue

  contract {
    public op place(id: OrderId) -> { id: OrderId } {
      route: "POST /v1/orders"
      errors: Invalid
    }
  }
}

environment dev {
  bind events -> redis(host: "q", port: 6379)
  deploy docker
}
`;
  const { dir, result } = await build(source);
  try {
    const queue = await readFile(join(dir, '.arcod', 'build', 'service', 'arcodio', 'queue.go'), 'utf8');
    assert.match(queue, /const queuePrefix = "arcod:q:"/);
    assert.match(queue, /"RPUSH", queuePrefix\+topic/);
    assert.match(queue, /map\[string\]any\{"payload": message, "attempts": 0\}/);
    assert.match(queue, /QUEUE_REDIS_URL/);
    assert.match(queue, /func \(io \*IO\) QueuePublish\(topic string, message any\) \(bool, error\)/);
    // The body reaches it through the facade it already receives.
    const ops = await readFile(join(dir, '.arcod', 'build', 'service', 'ops.go'), 'utf8');
    assert.match(ops, /func opPlace\(io \*arcodio\.IO, in map\[string\]any\)/);
    // Still no Node runtime beside the Go one.
    assert.equal(result.files.some((file) => file.endsWith(join('service', 'index.mjs'))), false);
    assert.ok(result.files.some((file) => file.endsWith(join('arcodio', 'queue.go'))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a go service without a queue carries no queue code', async () => {
  const { dir, result } = await build(spec());
  try {
    assert.equal(result.files.some((file) => file.endsWith(join('arcodio', 'queue.go'))), false);
    const facade = await readFile(join(dir, '.arcod', 'build', 'service', 'arcodio', 'arcodio.go'), 'utf8');
    assert.doesNotMatch(facade, /QueuePublish/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('the go kit refuses the stores it cannot serve, by name', async () => {
  const source = 'module gosql @0.1.0 {}\n\nservice Catalog : http {\n  language: go\n  uses store: sql\n\n  contract {\n    public op list() -> string {\n      route: "GET /v1/items"\n    }\n  }\n}\n\nenvironment dev {}\n';
  const dir = await mkdtemp(join(tmpdir(), 'arcod-go-'));
  try {
    const mod = parse(source, 'main.arc');
    await assert.rejects(
      buildExample(mod, dir, { reference: true, implDir: null }),
      /service Catalog is language: go, but the Go kit does not carry store: sql/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a kv store comes with the arcodio facade, its env and its Dockerfile copy', async () => {
  const source = 'module gokv @0.1.0 {}\n\ntype Id = uuid\n\nservice Cache : http {\n  language: go\n  uses store: kv(ttl: 60s)\n\n  contract {\n    public op read(id: Id) -> string {\n      route: "GET /v1/items/:id"\n    }\n  }\n}\n\nenvironment dev {\n  bind store -> redis(host: "kv", port: 6379)\n}\n';
  const dir = await mkdtemp(join(tmpdir(), 'arcod-go-'));
  try {
    const mod = parse(source, 'main.arc');
    const result = await buildExample(mod, dir, { reference: true, implDir: null });
    const io = await readFile(join(dir, '.arcod', 'build', 'service', 'arcodio', 'arcodio.go'), 'utf8');
    assert.match(io, /^package arcodio$/m);
    // The four kv verbs of the contract, not a general redis client.
    for (const command of ['GET', 'DEL', 'EXISTS']) {
      assert.match(io, new RegExp('kv\\.call\\("' + command + '", key\\)'));
    }
    assert.match(io, /args := \[\]string\{"SET", key, value\}/);
    assert.match(io, /args = append\(args, "PX", strconv\.FormatInt\(ttl\.Milliseconds\(\), 10\)\)/);
    // RESP framing: a bulk array, one bulk string per argument.
    assert.match(io, /strconv\.Itoa\(len\(args\)\)/);
    assert.match(io, /for _, arg := range args/);
    assert.match(io, /KV_HOST/);
    const main = await readFile(join(dir, '.arcod', 'build', 'service', 'main.go'), 'utf8');
    assert.match(main, /arcodio "arcod\/cache\/arcodio"/);
    const dockerfile = await readFile(join(dir, '.arcod', 'build', 'service', 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^COPY arcodio \.\/arcodio$/m);
    assert.equal(result.files.some((file) => file.endsWith(join('arcodio', 'arcodio.go'))), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the go kit names an unsupported stream instead of generating half a service', async () => {
  const source = 'module live @0.1.0 {}\n\nuse capability arcod.std.stream @1\n\nservice Feed : http {\n  language: go\n  uses live: stream\n\n  contract {\n    public op watch() -> string {\n      route: "GET /v1/watch"\n    }\n  }\n}\n\nenvironment dev {}\n';
  const dir = await mkdtemp(join(tmpdir(), 'arcod-go-'));
  try {
    const mod = parse(source, 'main.arc');
    await assert.rejects(
      buildExample(mod, dir, { reference: true, implDir: null }),
      /does not carry stream/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a go body is spliced into ops.go, and the op without one stays a stub', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-go-'));
  try {
    const implDir = join(dir, 'impl');
    await mkdir(implDir, { recursive: true });
    const body = 'func opRead(io *arcodio.IO, in map[string]any) (any, error) {\n\treturn map[string]any{"name": "from body"}, nil\n}\n';
    await writeFile(join(implDir, 'read.go'), body, 'utf8');
    const mod = parse(spec(), 'main.arc');
    await buildExample(mod, dir, { implDir });
    const ops = await readFile(join(dir, '.arcod', 'build', 'service', 'ops.go'), 'utf8');
    assert.match(ops, /from body/);
    assert.match(ops, /func opCreate\(io \*arcodio\.IO, in map\[string\]any\) \(any, error\) \{\n\treturn nil, &OpError\{Name: "NotImplemented"/);
    // The body is not wrapped in a second package clause.
    assert.equal(ops.match(/^package main$/gm)?.length, 1);
    // A body shares the ops.go imports (arcodio) and cannot add its own.
    assert.match(ops, /import arcodio "arcod\/catalog\/arcodio"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('routes that differ only by capture name are refused, not left for ServeMux to panic on', async () => {
  const source = 'module clash @0.1.0 {}\n\ntype ItemId = uuid\n\nservice Catalog : http {\n  language: go\n\n  contract {\n    public op read(id: ItemId) -> string {\n      route: "GET /v1/items/:id"\n    }\n\n    public op show(key: ItemId) -> string {\n      route: "GET /v1/items/:key"\n    }\n  }\n}\n\nenvironment dev {}\n';
  const dir = await mkdtemp(join(tmpdir(), 'arcod-go-'));
  try {
    const mod = parse(source, 'main.arc');
    await assert.rejects(
      buildExample(mod, dir, { reference: true, implDir: null }),
      /Go ServeMux would panic on GET \/v1\/items\/\{id\} is read and show/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a go body that repeats the package clause is refused with its file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-go-'));
  try {
    const implDir = join(dir, 'impl');
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, 'read.go'), 'package main\n\nfunc opRead(in map[string]any) (any, error) { return nil, nil }\n', 'utf8');
    const mod = parse(spec(), 'main.arc');
    await assert.rejects(
      buildExample(mod, dir, { reference: true, implDir }),
      /impl\/read\.go declares a package/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
