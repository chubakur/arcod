import { test } from 'node:test';
import assert from 'node:assert/strict';
// The bodies are plain JS with no declarations. The path stays dynamic so
// TypeScript does not look for a .d.ts: this test drives exactly the module
// the generated service loads, at the path the example ships.
const addModule = '../examples/vector/impl/add.mjs';
const searchModule = '../examples/vector/impl/search.mjs';
const { add } = await import(addModule);
const { search } = await import(searchModule);

// examples/vector is the contract for io.embed: the body asks for vectors and
// compares them; it never hashes text and never names a model. The bodies are
// plain modules, so the scoring and the guards can be driven without a
// service, an endpoint or a store.

function fakeIo(notes: Array<Record<string, unknown>>, vectors: number[][] = [[1, 0]]) {
  const calls = { embed: [] as unknown[], insert: [] as unknown[], find: [] as unknown[] };
  return {
    calls,
    new: async () => 'id-1',
    embed: async (texts: unknown[]) => {
      calls.embed.push(texts);
      return vectors;
    },
    insert: async (entity: string, record: unknown) => {
      calls.insert.push([entity, record]);
      return record;
    },
    find: async (entity: string) => {
      calls.find.push(entity);
      return { items: notes, next: null };
    },
  };
}

test('add embeds once and stores the vector with the text', async () => {
  const io = fakeIo([], [[0.1, 0.2, 0.3]]);
  const out = await add({ text: '  hello  ' }, io);
  assert.deepEqual(out, { result: { id: 'id-1', dim: 3 } });
  assert.deepEqual(io.calls.embed, [['hello']]);
  const [entity, record] = io.calls.insert[0] as [string, Record<string, unknown>];
  assert.equal(entity, 'Note');
  assert.equal(record.text, 'hello');
  assert.deepEqual(record.vector, [0.1, 0.2, 0.3]);
  assert.equal(record.id, 'id-1');
});

test('add refuses a blank text and an empty vector instead of storing either', async () => {
  const blank = fakeIo([]);
  assert.deepEqual(await add({ text: '   ' }, blank), { error: 'Invalid' });
  assert.deepEqual(blank.calls.embed, [], 'a blank text is not sent to the model');
  assert.deepEqual(blank.calls.insert, []);

  const empty = fakeIo([], [[]]);
  assert.deepEqual(await add({ text: 'x' }, empty), { error: 'Invalid' });
  assert.deepEqual(empty.calls.insert, [], 'an empty vector is not a record');
});

test('search ranks by cosine and honours the limit', async () => {
  const io = fakeIo([
    { id: 'a', text: 'same', vector: [1, 0] },
    { id: 'b', text: 'orthogonal', vector: [0, 1] },
    { id: 'c', text: 'opposite', vector: [-1, 0] },
  ]);
  const all = await search({ q: 'same' }, io);
  assert.deepEqual(all, { result: { items: [
    { id: 'a', text: 'same', score: 1 },
    { id: 'b', text: 'orthogonal', score: 0 },
    { id: 'c', text: 'opposite', score: -1 },
  ] } });

  const top = await search({ q: 'same', limit: 2 }, io);
  assert.deepEqual((top.result as { items: Array<{ id: string }> }).items.map((hit) => hit.id), ['a', 'b']);
  assert.deepEqual(io.calls.embed[0], ['same']);
  assert.deepEqual(io.calls.find, ['Note', 'Note']);
});

test('search skips records without a usable vector and refuses a blank query', async () => {
  const io = fakeIo([
    { id: 'bad', text: 'no vector', vector: null },
    { id: 'ok', text: 'ok', vector: [1, 0] },
  ]);
  const out = await search({ q: 'ok' }, io);
  assert.deepEqual((out.result as { items: Array<{ id: string }> }).items.map((hit) => hit.id), ['ok']);

  const blank = fakeIo([]);
  assert.deepEqual(await search({ q: '  ' }, blank), { error: 'Invalid' });
  assert.deepEqual(blank.calls.embed, [], 'nothing is embedded for an empty query');
});
