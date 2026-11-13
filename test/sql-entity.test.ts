import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startService } from './harness.ts';

// The sql driver's in-memory store must serve typed entities (insert/find/
// update/remove + unique -> Conflict) so `arcod test` runs sql examples
// without a live MySQL. This exercises that path end to end.

const specUrl = new URL('../examples/tasks-sql/main.arc', import.meta.url);

test('the sql memory driver serves typed entities end to end', async () => {
  const source = await readFile(specUrl, 'utf8');
  const impl: Record<string, string> = {};
  for (const op of ['create', 'list', 'move']) {
    impl[op] = await readFile(new URL('../examples/tasks-sql/impl/' + op + '.mjs', import.meta.url), 'utf8');
  }
  const svc = await startService(source, { impl });
  try {
    const created = await fetch(svc.base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first', priority: 1 }),
    });
    assert.equal(created.status, 201, 'create returns 201');
    const task = await created.json();
    assert.ok(task.id, 'the created task carries an id');

    const dup = await fetch(svc.base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first', priority: 2 }),
    });
    assert.equal(dup.status, 409, 'a duplicate title is Conflict');

    const listed = await fetch(svc.base + '/v1/tasks');
    assert.equal(listed.status, 200, 'list returns 200');
    const page = await listed.json();
    assert.ok(Array.isArray(page.items), 'list returns items');
    assert.equal(page.items.length, 1, 'exactly one task');
    assert.equal(page.items[0].title, 'first');

    const moved = await fetch(svc.base + '/v1/tasks/' + task.id + '/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(moved.status, 201, 'move returns 201');
    const movedTask = await moved.json();
    assert.equal(movedTask.status, 'done');
  } finally {
    await svc.stop();
  }
});
