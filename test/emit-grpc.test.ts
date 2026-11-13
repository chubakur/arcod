import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import protobuf from 'protobufjs';
import { parse } from '../src/parser.ts';
import { grpcProto } from '../src/emit/grpc.ts';

const repo = new URL('..', import.meta.url).pathname;

// The imports the emitter may produce point at the standard well-known files.
// protobufjs ships no copies of them, so the test seeds the same definitions
// protoc would load, then resolves the generated file against them.
const WELL_KNOWN = `syntax = "proto3";
package google.protobuf;

message Timestamp { int64 seconds = 1; int32 nanos = 2; }

enum NullValue { NULL_VALUE = 0; }

message Struct { map<string, Value> fields = 1; }

message ListValue { repeated Value values = 1; }

message Value {
  oneof kind {
    NullValue null_value = 1;
    double number_value = 2;
    string string_value = 3;
    bool bool_value = 4;
    Struct struct_value = 5;
    ListValue list_value = 6;
  }
}
`;

function parseProto(source: string): protobuf.Root {
  const root = new protobuf.Root();
  protobuf.parse(WELL_KNOWN, root, { keepCase: true });
  protobuf.parse(source, root, { keepCase: true });
  root.resolveAll();
  return root;
}

const source = `module catalog @0.1.0 {
}
use capability arcod.std.sql @1

enum Status { draft, live, archived }

type Item = {
  id: uuid,
  title: string,
  status: Status,
  price: decimal,
  tags: list<string>,
  meta: map<string, string>,
  createdAt: datetime,
  publishedAt: datetime?,
}

type Page = {
  items: list<Item>,
  next: string?,
}

service Catalog : http {
  uses db: sql
  contract {
    public op list(status: Status?, limit: int?) -> Page {
      route: "GET /v1/items"
    }

    public op create(item: Item) -> Item {
      route: "POST /v1/items"
      errors: Invalid, Conflict
    }

    public op remove(id: uuid) -> void {
      route: "DELETE /v1/items/:id"
      errors: NotFound
    }
  }
}
`;

test('grpc: the proto is structurally valid and every reference resolves', () => {
  const root = parseProto(grpcProto(parse(source, 'main.arc')));
  assert.ok(root.lookupType('arcod.catalog.ListRequest'));
  assert.ok(root.lookupType('arcod.catalog.CreateResponse'));
  assert.ok(root.lookupEnum('arcod.catalog.Status'));
});

test('grpc: one rpc per routed operation, named after it', () => {
  const proto = grpcProto(parse(source, 'main.arc'));
  assert.ok(proto.includes('service Catalog {'));
  assert.ok(proto.includes('rpc List(ListRequest) returns (ListResponse);'));
  assert.ok(proto.includes('rpc Create(CreateRequest) returns (CreateResponse);'));
  assert.ok(proto.includes('rpc Remove(RemoveRequest) returns (RemoveResponse);'));
  assert.equal(proto.includes('rpc list('), false);
});

test('grpc: request messages flatten path, query and body params', () => {
  const proto = grpcProto(parse(source, 'main.arc'));
  const request = proto.slice(proto.indexOf('message RemoveRequest'), proto.indexOf('message RemoveResponse'));
  assert.ok(request.includes('string id = 1;'));

  const create = proto.slice(proto.indexOf('message CreateRequest'), proto.indexOf('message CreateResponse'));
  assert.ok(create.includes('Item item = 1;'));
});

test('grpc: a void return is an empty response, a record is wrapped as result', () => {
  const proto = grpcProto(parse(source, 'main.arc'));
  const remove = proto.slice(proto.indexOf('message RemoveResponse'));
  assert.ok(remove.startsWith('message RemoveResponse {\n}'));

  assert.ok(proto.includes('message CreateResponse {\n  Item result = 1;\n}'));
  assert.ok(proto.includes('message ListResponse {\n  Page result = 1;\n}'));
});

test('grpc: types keep their meaning instead of collapsing to string', () => {
  const proto = grpcProto(parse(source, 'main.arc'));
  assert.ok(proto.includes('optional google.protobuf.Timestamp publishedAt'));
  assert.ok(proto.includes('google.protobuf.Timestamp createdAt'));
  assert.ok(proto.includes('repeated string tags'));
  assert.ok(proto.includes('map<string, string> meta'));
  assert.ok(proto.includes('Status status'));
  assert.ok(proto.includes('string price'));
  assert.ok(proto.includes('import "google/protobuf/timestamp.proto";'));
});

test('grpc: a proto3 enum starts at zero with a prefixed value set', () => {
  const proto = grpcProto(parse(source, 'main.arc'));
  assert.ok(proto.includes('enum Status {'));
  assert.ok(proto.includes('STATUS_UNSPECIFIED = 0;'));
  assert.ok(proto.includes('STATUS_DRAFT = 1;'));
  assert.ok(proto.includes('STATUS_LIVE = 2;'));
  assert.ok(proto.includes('STATUS_ARCHIVED = 3;'));
});

test('grpc: route and error statuses stay in the file as comments', () => {
  const proto = grpcProto(parse(source, 'main.arc'));
  assert.ok(proto.includes('// HTTP: POST /v1/items'));
  assert.ok(proto.includes('Invalid (INVALID_ARGUMENT)'));
  assert.ok(proto.includes('NotFound (NOT_FOUND)'));
  assert.ok(proto.includes('// Errors: Invalid (INVALID_ARGUMENT), Conflict (ABORTED)'));
});

test('grpc: output is deterministic for the same model', () => {
  assert.equal(grpcProto(parse(source, 'main.arc')), grpcProto(parse(source, 'main.arc')));
});

test('grpc: every example produces a proto that resolves', async () => {
  const root = join(repo, 'examples');
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let checked = 0;
  for (const name of names) {
    const text = await readFile(join(root, name, 'main.arc'), 'utf8');
    const mod = parse(text, 'main.arc');
    for (const svc of mod.services) {
      if (svc.external) continue;
      parseProto(grpcProto(mod, { service: svc.name }));
      checked += 1;
    }
  }
  assert.ok(checked >= 12, 'expected a proto per example service, got ' + checked);
});

test('grpc CLI writes the proto to --out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-grpc-'));
  try {
    const result = spawnSync(
      process.execPath,
      [join(repo, 'bin', 'arcod.mjs'), 'grpc', join(repo, 'examples', 'tasks-sql'), '--out', join(dir, 'tasks.proto')],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const proto = await readFile(join(dir, 'tasks.proto'), 'utf8');
    parseProto(proto);
    assert.ok(proto.includes('service TaskBoard {'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
