// B53: reference mode derives a body from the contract instead of shipping the
// one-time-message pair. These tests pin the derivation itself (a body per CRUD
// form, a refusal for anything else), and the two shapes the bug named: an
// anonymous record stored as a value (project1) and a declared entity
// (create/read/update/delete/list over one table).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { referenceBodies } from '../src/reference.ts';
import { emitService } from '../src/emit/service.ts';
import { startService } from './harness.ts';

const project1 = await readFile(new URL('../examples/project1/main.arc', import.meta.url), 'utf8');

test('project1 derives create/read from its declaration, not the demo template', () => {
  const mod = parse(project1, 'main.arc');
  const derived = referenceBodies(mod, mod.services[0]!);
  assert.deepEqual(derived.gaps, []);
  const create = derived.bodies.create!;
  const read = derived.bodies.read!;
  assert.match(create, /input\.author/);
  assert.match(create, /input\.body/);
  assert.match(create, /io\.set/);
  assert.doesNotMatch(create, /expiresIn/);
  // Reading must return the declared shape and consume only because the
  // contract declares once(read, ...).
  assert.match(read, /io\.load/);
  assert.match(read, /io\.takeIf/);
  assert.doesNotMatch(read, /text\/plain/);
});

test('a declared entity gets insert/fetch/update/remove/find bodies', () => {
  const mod = parse(entitySpec, 'main.arc');
  const derived = referenceBodies(mod, mod.services[0]!);
  assert.deepEqual(derived.gaps, []);
  assert.deepEqual(derived.entities, ['Task']);
  assert.match(derived.bodies.create!, /io\.insert\("Task"/);
  assert.match(derived.bodies.read!, /io\.fetch\("Task"/);
  assert.match(derived.bodies.update!, /io\.update\("Task"/);
  assert.match(derived.bodies.delete!, /io\.remove\("Task"/);
  assert.match(derived.bodies.list!, /io\.find\("Task"/);
  // delete is not a JavaScript identifier: the body spells it delete_ and the
  // emitter renames it from the declaration.
  assert.match(derived.bodies.delete!, /function delete_/);
});

test('a non-CRUD operation is a named gap, not a built 501', () => {
  const mod = parse(chargeSpec, 'main.arc');
  const derived = referenceBodies(mod, mod.services[0]!);
  assert.deepEqual(derived.gaps.map((gap) => gap.op), ['charge']);
  assert.match(derived.gaps[0]!.reason, /CRUD form/);
  assert.throws(() => emitService(mod, { reference: true }), /charge \(not a CRUD form/);
});

test('project1 reference answers the declared record and consumes once', async () => {
  const svc = await startService(project1, { reference: true });
  try {
    const created = await fetch(svc.base + '/v1/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'baby', body: 'hi' }),
    });
    assert.equal(created.status, 201);
    const id = await created.text();
    assert.match(id, /^[0-9a-f-]{36}$/);

    const first = await fetch(svc.base + '/v1/api/messages/' + id);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { author: 'baby', body: 'hi' });

    const second = await fetch(svc.base + '/v1/api/messages/' + id);
    assert.equal(second.status, 410);
    assert.equal((await second.json()).error, 'Gone');

    const missing = await fetch(svc.base + '/v1/api/messages/00000000-0000-0000-0000-000000000000');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'NotFound');
  } finally {
    await svc.stop();
  }
});

test('a declared entity reference round-trips create/read/update/list/delete', async () => {
  const svc = await startService(entitySpec, { reference: true });
  try {
    const created = await fetch(svc.base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'write', status: 'open' }),
    });
    assert.equal(created.status, 201);
    const task = await created.json();
    assert.equal(task.title, 'write');

    const read = await fetch(svc.base + '/v1/tasks/' + task.id);
    assert.deepEqual(await read.json(), { id: task.id, title: 'write', status: 'open' });

    const updated = await fetch(svc.base + '/v1/tasks/' + task.id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'write', status: 'done' }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).status, 'done');

    const listed = await fetch(svc.base + '/v1/tasks?status=done');
    assert.deepEqual((await listed.json()).map((item: { id: string }) => item.id), [task.id]);

    const removed = await fetch(svc.base + '/v1/tasks/' + task.id, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).id, task.id);

    const gone = await fetch(svc.base + '/v1/tasks/' + task.id);
    assert.equal(gone.status, 404);
  } finally {
    await svc.stop();
  }
});

const entitySpec = [
  'module crud @0.1.0 {',
  '  meta {',
  '    owner: "@me"',
  '  }',
  '}',
  'use capability arcod.std.kv @1',
  'type TaskId = uuid',
  'type Task = { id: TaskId, title: string, status: string }',
  'error NotFound',
  'error Invalid',
  'service Tasks : http {',
  '  uses store: kv',
  '  effects {',
  '    allow store.insert, store.find, store.update, store.del, store.get, store.set',
  '    deny net, fs, exec',
  '  }',
  '  contract {',
  '    public op create(title: string, status: string) -> Task {',
  '      route: "POST /v1/tasks"',
  '      errors: Invalid',
  '      on error Invalid: title != null',
  '    }',
  '    public op read(id: TaskId) -> Task {',
  '      route: "GET /v1/tasks/:id"',
  '      errors: NotFound',
  '      on error NotFound: id != null',
  '    }',
  '    public op update(id: TaskId, title: string, status: string) -> Task {',
  '      route: "PATCH /v1/tasks/:id"',
  '      status: 200',
  '      errors: NotFound, Invalid',
  '      on error NotFound: id != null',
  '      on error Invalid: id != null',
  '    }',
  '    public op delete(id: TaskId) -> Task {',
  '      route: "DELETE /v1/tasks/:id"',
  '      status: 200',
  '      errors: NotFound',
  '      on error NotFound: id != null',
  '    }',
  '    public op list(status: string?) -> list<Task> {',
  '      route: "GET /v1/tasks"',
  '    }',
  '  }',
  '  examples {',
  '    example roundtrip {',
  '      when {',
  '        let task = create("write", "open")',
  '        let found = read(task.id)',
  '      }',
  '      then {',
  '        found.title == "write"',
  '      }',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  deploy docker',
  '}',
  '',
].join('\n');

const chargeSpec = [
  'module charge @0.1.0 {',
  '  meta {',
  '    owner: "@me"',
  '  }',
  '}',
  'use capability arcod.std.kv @1',
  'type Card = { id: uuid, amount: int }',
  'error NotFound',
  'error Invalid',
  'service Pay : http {',
  '  uses store: kv',
  '  effects {',
  '    allow store.insert, store.get, store.set, store.del',
  '    deny net, fs, exec',
  '  }',
  '  contract {',
  '    public op create(amount: int) -> Card {',
  '      route: "POST /v1/cards"',
  '      errors: Invalid',
  '      on error Invalid: amount != null',
  '    }',
  '    public op read(id: uuid) -> Card {',
  '      route: "GET /v1/cards/:id"',
  '      errors: NotFound',
  '      on error NotFound: id != null',
  '    }',
  '    public op charge(id: uuid, amount: int) -> Card {',
  '      route: "POST /v1/cards/:id/charge"',
  '      errors: NotFound',
  '      on error NotFound: id != null',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  deploy docker',
  '}',
  '',
].join('\n');

const noteSpec = [
  'module notes @0.1.0 {',
  '  meta {',
  '    owner: "@me"',
  '  }',
  '}',
  'use capability arcod.std.kv @1',
  'error NotFound',
  'error Invalid',
  'service Notes : http {',
  '  uses store: kv',
  '  effects {',
  '    allow store.insert, store.find, store.update, store.del, store.get, store.set, store.scan',
  '    deny net, fs, exec',
  '  }',
  '  contract {',
  '    public op create(title: string) -> string {',
  '      route: "POST /v1/notes"',
  '      errors: Invalid',
  '      on error Invalid: title != null',
  '    }',
  '    public op read(id: string) -> { id: string, title: string } {',
  '      route: "GET /v1/notes/:id"',
  '      errors: NotFound',
  '      on error NotFound: id != null',
  '    }',
  '    public op update(id: string, title: string) -> { id: string, title: string } {',
  '      route: "PATCH /v1/notes/:id"',
  '      status: 200',
  '      errors: NotFound, Invalid',
  '      on error NotFound: id != null',
  '      on error Invalid: id != null',
  '    }',
  '    public op delete(id: string) -> { id: string, title: string } {',
  '      route: "DELETE /v1/notes/:id"',
  '      status: 200',
  '      errors: NotFound',
  '      on error NotFound: id != null',
  '    }',
  '    public op list() -> list<{ id: string, title: string }> {',
  '      route: "GET /v1/notes"',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  deploy docker',
  '}',
  '',
].join('\n');

test('an inline record gets the value-store CRUD bodies', async () => {
  const mod = parse(noteSpec, 'main.arc');
  const derived = referenceBodies(mod, mod.services[0]!);
  assert.deepEqual(derived.gaps, []);
  assert.deepEqual(derived.entities, []);
  assert.match(derived.bodies.create!, /io\.set/);
  assert.match(derived.bodies.update!, /io\.load/);
  assert.match(derived.bodies.delete!, /io\.del/);
  assert.match(derived.bodies.list!, /io\.scan/);
});

test('an inline record reference round-trips update/delete/list', async () => {
  const svc = await startService(noteSpec, { reference: true });
  try {
    const created = await fetch(svc.base + '/v1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first' }),
    });
    assert.equal(created.status, 201);
    const id = await created.text();

    const read = await fetch(svc.base + '/v1/notes/' + id);
    assert.deepEqual(await read.json(), { id, title: 'first' });

    const updated = await fetch(svc.base + '/v1/notes/' + id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'second' }),
    });
    assert.equal((await updated.json()).title, 'second');

    const listed = await fetch(svc.base + '/v1/notes');
    assert.deepEqual((await listed.json()).map((item: { title: string }) => item.title), ['second']);

    const removed = await fetch(svc.base + '/v1/notes/' + id, { method: 'DELETE' });
    assert.equal((await removed.json()).title, 'second');
    assert.equal((await fetch(svc.base + '/v1/notes/' + id)).status, 404);
  } finally {
    await svc.stop();
  }
});
