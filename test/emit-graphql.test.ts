import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchema, isInputObjectType, isUnionType } from 'graphql';
import { parse } from '../src/parser.ts';
import { graphqlSchema } from '../src/emit/graphql.ts';

const repo = new URL('..', import.meta.url).pathname;

const tasksSource = `module tasks @0.1.0 {
}
use capability arcod.std.sql @1

type Task = {
  id: uuid,
  title: string,
  notes: string?,
  priority: int,
  createdAt: datetime,
}

type Page = {
  items: list<Task>,
  next: string?,
}

service TaskBoard : http {
  uses db: sql
  contract {
    public op list(status: string?, limit: int?) -> Page {
      route: "GET /v1/tasks"
    }

    public op create(task: Task) -> Task {
      route: "POST /v1/tasks"
      errors: Invalid
    }

    public op remove(id: uuid) -> void {
      route: "DELETE /v1/tasks/:id"
      errors: NotFound
    }
  }
}
`;

function schemaOf(source: string): string {
  return graphqlSchema(parse(source, 'main.arc'));
}

test('graphql: the schema is a real GraphQL schema, not just text', () => {
  const sdl = schemaOf(tasksSource);
  const schema = buildSchema(sdl);
  assert.equal(schema.getQueryType()?.name, 'Query');
  assert.equal(schema.getMutationType()?.name, 'Mutation');
  assert.ok(schema.getType('Task'));
  assert.ok(schema.getType('TaskInput'));
});

test('graphql: GET routes become queries, everything else mutations', () => {
  const sdl = schemaOf(tasksSource);
  const query = sdl.slice(sdl.indexOf('type Query'), sdl.indexOf('type Mutation'));
  const mutation = sdl.slice(sdl.indexOf('type Mutation'));

  assert.ok(query.includes('list('));
  assert.equal(query.includes('create('), false);

  assert.ok(mutation.includes('create('));
  assert.ok(mutation.includes('remove('));
  assert.equal(mutation.includes('list('), false);
});

test('graphql: optional params are nullable, required args are not, uuid is ID', () => {
  const sdl = schemaOf(tasksSource);
  assert.ok(sdl.includes('list(status: String, limit: Int): Page!'));
  assert.ok(sdl.includes('remove(id: ID!): Boolean!'));
  assert.ok(sdl.includes('  id: ID!'));
  assert.ok(sdl.includes('  notes: String\n'));
  assert.ok(sdl.includes('  createdAt: DateTime!'));
});

test('graphql: a body param uses the input twin, never the output type', () => {
  const sdl = schemaOf(tasksSource);
  assert.ok(sdl.includes('create(task: TaskInput!): Task!'));
  assert.ok(sdl.includes('input TaskInput {'));
  // Only types used as arguments get an input twin.
  assert.equal(sdl.includes('input PageInput'), false);
  assert.equal(sdl.includes('input Task {'), false);
});

test('graphql: the field description keeps the HTTP route and the error statuses', () => {
  const sdl = schemaOf(tasksSource);
  assert.ok(sdl.includes('HTTP: POST /v1/tasks'));
  assert.ok(sdl.includes('Errors: Invalid (400)'));
  assert.ok(sdl.includes('Errors: NotFound (404)'));
});

test('graphql: a record nested in a record keeps its own input and output twins', () => {
  const source = [
    'module nested @0.1.0 {}',
    'type Meta = { color: string, tags: list<string> }',
    'type Task = { id: uuid, title: string, meta: Meta }',
    'service S : http {',
    '  contract {',
    '    public op create(t: Task) -> Task { route: "POST /v1/tasks" }',
    '  }',
    '}',
  ].join('\n');
  const sdl = graphqlSchema(parse(source, 'nested.arc'));
  // The field is the output twin inside a type and the input twin inside an
  // input; a single Meta shape in both places would let a client send fields
  // the server assigns.
  assert.match(sdl, /input MetaInput \{\n  color: String!\n  tags: \[String!\]!\n\}/);
  assert.match(sdl, /input TaskInput \{\n  id: ID!\n  title: String!\n  meta: MetaInput!\n\}/);
  assert.match(sdl, /type Task \{\n  id: ID!\n  title: String!\n  meta: Meta!\n\}/);
  assert.match(sdl, /create\(t: TaskInput!\): Task!/);
  buildSchema(sdl);
});

test('graphql: an alias of a record keeps the record name, not the alias', () => {
  // type Item = Task is a second name for the same shape: one object and one
  // input twin, named after the record, so a client never sees Item and Task
  // as two shapes with the same fields.
  const source = [
    'module alias @0.1.0 {}',
    'type Task = { id: uuid, title: string }',
    'type Item = Task',
    'service S : http {',
    '  contract {',
    '    public op create(it: Item) -> Item { route: "POST /v1/items" }',
    '  }',
    '}',
  ].join('\n');
  const sdl = graphqlSchema(parse(source, 'alias.arc'));
  assert.match(sdl, /create\(it: TaskInput!\): Task!/);
  assert.equal(sdl.includes('type Item'), false, 'the alias does not become a second object');
  assert.equal(sdl.includes('input ItemInput'), false);
  buildSchema(sdl);
});

test('graphql: a service with no routed operation says so instead of inventing a root', () => {
  // check reports A050 for the missing route, but the emitter is also called
  // directly (SDK, editors): it says why the root is empty instead of
  // printing an empty `type Query` that no field could ever fill.
  const source = 'module m @0.1.0 {}\nservice S : http { contract { public op x() -> string { } } }';
  const sdl = graphqlSchema(parse(source, 'm.arc'));
  assert.match(sdl, /# No routed operation was found: the schema has no root fields\./);
  assert.equal(sdl.includes('type Query'), false);
  assert.equal(sdl.includes('type Mutation'), false);
});

test('graphql: output is deterministic for the same model', () => {
  assert.equal(schemaOf(tasksSource), schemaOf(tasksSource));
});

test('graphql: every example produces a schema that GraphQL itself accepts', async () => {
  const root = join(repo, 'examples');
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let checked = 0;
  for (const name of names) {
    const source = await readFile(join(root, name, 'main.arc'), 'utf8');
    const mod = parse(source, 'main.arc');
    for (const svc of mod.services) {
      if (svc.external) continue;
      const sdl = graphqlSchema(mod, { service: svc.name });
      buildSchema(sdl);
      checked += 1;
    }
  }
  assert.ok(checked >= 12, 'expected a schema per example service, got ' + checked);
});

test('graphql CLI writes the schema to --out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-graphql-'));
  try {
    const result = spawnSync(
      process.execPath,
      [join(repo, 'bin', 'arcod.mjs'), 'graphql', join(repo, 'examples', 'tasks-sql'), '--out', join(dir, 'tasks.graphql')],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const sdl = await readFile(join(dir, 'tasks.graphql'), 'utf8');
    buildSchema(sdl);
    assert.ok(sdl.includes('type Query'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphql: access clauses appear in the field description', () => {
  const source = `module shelf @0.1.0 {
}
use capability arcod.std.identity @1

service Shelf : http {
  uses auth: identity
  roles: admin, member

  contract {
    auth op purge(id: uuid) -> void {
      route: "DELETE /v1/shelf/:id"
      roles: admin
    }

    auth op edit(id: uuid, title: string) -> void {
      route: "PATCH /v1/shelf/:id"
      owner: id
    }

    auth op read(id: uuid) -> string {
      route: "GET /v1/shelf/:id"
    }

    public op home() -> string {
      route: "GET /v1/home"
    }
  }
}

environment dev {
  bind auth -> keycloak
}
`;
  const sdl = graphqlSchema(parse(source, 'main.arc'));
  assert.ok(sdl.includes('Requires one of the roles: admin.'));
  assert.ok(sdl.includes('The record must belong to the caller.'));
  assert.ok(sdl.includes('Requires an authenticated actor.'));
  // A GET auth op is a Query field and still says a token is needed.
  assert.ok(sdl.includes('HTTP: GET /v1/shelf/:id\n  Requires an authenticated actor.'));
  // The public field carries the route and nothing else.
  assert.ok(sdl.includes('HTTP: GET /v1/home\n  \"\"\"\n  home: String!'));
});

const unionSource = `module u @0.1.0 {
}
use capability arcod.std.sql @1

type OkBody = { ok: bool }
type ErrBody = { message: string }
type Result = OkBody | ErrBody

service S : http {
  uses db: sql
  contract {
    public op get(id: uuid) -> Result {
      route: "GET /v1/x/:id"
    }
    public op put(r: Result) -> Result {
      route: "POST /v1/x"
    }
    public op inline(id: uuid) -> OkBody | ErrBody {
      route: "GET /v1/y/:id"
    }
  }
}
`;

test('graphql: a named union is a real union, not a JSON hole', () => {
  const sdl = schemaOf(unionSource);
  const schema = buildSchema(sdl);
  assert.ok(sdl.includes('union Result = OkBody | ErrBody'), sdl);
  const result = schema.getType('Result');
  assert.ok(isUnionType(result), 'Result must be a GraphQL union');
  assert.deepEqual(result.getTypes().map((t) => t.name).sort(), ['ErrBody', 'OkBody']);
  // Before the fix a named union fell through to the unknown-type hole.
  assert.equal(sdl.includes('scalar JSON'), false);
  assert.ok(sdl.includes('get(id: ID!): Result!'), sdl);
});

test('graphql: a union argument accepts every variant through optional input fields', () => {
  const sdl = schemaOf(unionSource);
  const schema = buildSchema(sdl);
  const input = schema.getType('ResultInput');
  assert.ok(isInputObjectType(input), 'ResultInput must be an input object');
  assert.ok(sdl.includes('put(r: ResultInput!): Result!'), sdl);
  const fields = input.getFields();
  assert.deepEqual(Object.keys(fields).sort(), ['message', 'ok']);
  // Either variant alone has to satisfy the input: no field is required.
  for (const field of Object.values(fields)) {
    assert.equal(String(field.type).endsWith('!'), false, field.name + ' is optional');
  }
});

test('graphql: an inline union gets its own named union type', () => {
  const sdl = schemaOf(unionSource);
  const schema = buildSchema(sdl);
  assert.ok(sdl.includes('union InlineResult = OkBody | ErrBody'), sdl);
  assert.ok(isUnionType(schema.getType('InlineResult')));
  assert.ok(sdl.includes('inline(id: ID!): InlineResult!'), sdl);
});
