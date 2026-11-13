import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchema } from 'graphql';
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
