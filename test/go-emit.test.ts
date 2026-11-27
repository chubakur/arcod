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
    assert.match(ops, /func opRead\(in map\[string\]any\) \(any, error\)/);
    assert.match(ops, /func opRename\(in map\[string\]any\) \(any, error\)/);
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

test('the go kit refuses a store it cannot serve, by name', async () => {
  const source = spec().replace('  language: go', '  language: go\n  uses store: kv');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-go-'));
  try {
    const mod = parse(source, 'main.arc');
    await assert.rejects(
      buildExample(mod, dir, { reference: true, implDir: null }),
      /service Catalog is language: go, but the Go kit does not carry store: kv/,
    );
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

test('a go body on disk is refused, not silently ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-go-'));
  try {
    const implDir = join(dir, 'impl');
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, 'read.go'), 'package main\n', 'utf8');
    const mod = parse(spec(), 'main.arc');
    await assert.rejects(
      buildExample(mod, dir, { reference: true, implDir }),
      /Go bodies are not wired yet: impl\/read\.go/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
