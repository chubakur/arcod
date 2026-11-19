import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { buildPrompts, formatPrompts } from '../src/prompts.ts';

// The full prompt is what `arcod prompts --full` hands to a model: a task
// header, the wire signature, the contract with io.* names, only the rules of
// this operation, the io methods the service allows and the storage shape.
// The compact prompt is covered by arcod.test.ts; this file pins the full form.

const load = async (name: string) => parse(await readFile(new URL('../examples/' + name + '/main.arc', import.meta.url), 'utf8'), 'main.arc');

const once = await load('onetimemessage');
const guarded = await load('onetimemessage-pwd');
const files = await load('files');

function task(set: ReturnType<typeof buildPrompts>, op: string) {
  const found = set.tasks.find((item) => item.op === op);
  assert.ok(found, 'task ' + op + ' exists');
  return found;
}

test('full prompt names its file, signature, wire types and declared errors', () => {
  const prompt = task(buildPrompts(guarded, { format: 'full' }), 'create').prompt;
  assert.match(prompt, /^# Task T-\d{4}\nmodule onetimemessagepwd@0\.1\.0\nservice GuardedMessage\noperation create \(http\)\nroute POST \/api\/messages/);
  assert.match(prompt, /Write exactly one file: impl\/create\.mjs/);
  assert.match(prompt, /export async function create\(input, io\)/);
  // A refined type reaches the body as its wire type, not as "bytes".
  assert.match(prompt, /input: \{ body: string, password: string \| null \}/);
  assert.match(prompt, /returns: \{ result: string \} \| \{ error: "Invalid" \}/);
  assert.match(prompt, /Reply with exactly one ```js block/);
});

test('full prompt rewrites aliases and keeps only the rules of this operation', () => {
  const set = buildPrompts(once, { format: 'full' });
  const read = task(set, 'read').prompt;
  const create = task(set, 'create').prompt;
  // contractText maps store.has to io.has: the body never sees the alias.
  assert.match(read, /post: !io\.has\(id\)/);
  assert.ok(!read.includes('store.'), 'no alias survives in the contract');
  assert.match(read, /invariant read\.at_most_once/);
  assert.match(read, /atomic read \{ get; del \}/);
  // A create body must not carry read's once rule or its atomic block.
  assert.ok(!create.includes('at_most_once'));
  assert.ok(!create.includes('atomic read'));
});

test('full prompt of a guarded service explains the stored record', () => {
  const prompt = task(buildPrompts(guarded, { format: 'full' }), 'create').prompt;
  assert.match(prompt, /## Storage/);
  assert.match(prompt, /stored value = JSON \{ b: string, h: string \| null \}/);
  assert.match(prompt, /h is a salted password hash, null when the message is open\./);
  assert.match(prompt, /io\.hash\(password: string\) -> string/);
  // Without a password anywhere the plain service stores the text as is.
  const plain = task(buildPrompts(once, { format: 'full' }), 'create').prompt;
  assert.match(plain, /stored value = the message text as is\./);
});

test('full prompt of an auth operation says the guards already ran', () => {
  const prompt = task(buildPrompts(files, { format: 'full' }), 'upload').prompt;
  assert.match(prompt, /auth and owner: guards before the body runs: do not re-check them/);
  // Only the service allow-list becomes io: a method nobody allowed is absent.
  assert.match(prompt, /io\.actor\(\) -> \{ id: string, name: string, admin: boolean \} \| null/);
  assert.ok(!prompt.includes('no signature registered'));
  // The same list is the whole io section: no method from another capability.
  const ioSection = prompt.slice(prompt.indexOf('## io'), prompt.indexOf('## Storage'));
  assert.ok(!ioSection.includes('io.takeIf'), 'kv extras do not leak into a sql service');
});

test('full prompt reports an unresolved plan instead of hiding it', () => {
  const spec = `module demo @0.1.0 {}

use capability arcod.std.kv @1
use capability arcod.std.ids @1

type MessageId = uuid
type Body = bytes(min: 1, max: 64kb)

error NotFound

service Notes : http {
  uses store: kv(ttl: 900s)
  uses uuid: ids

  rules {
    atomic read { get; del }
  }

  contract {
    public op create(body: Body) -> MessageId {
      route: "POST /v1/notes"
      post: result != null
    }
    public op read(id: MessageId) -> Body {
      route: "GET /v1/notes/:id"
      errors: NotFound
    }
  }
}
`;
  const set = buildPrompts(parse(spec, 'main.arc'), { format: 'full' });
  // An atomic read consumes the key, so the operation must be able to say
  // "already gone". The prompt names the task, not the whole set.
  assert.deepEqual(set.unresolved, [task(set, 'read').id + ': consume is required but the operation declares no error for an already consumed value']);
  assert.deepEqual(set.overBudget, []);
});

test('budget is enforced per task and formatPrompts marks the overflow', () => {
  const tight = buildPrompts(files, { format: 'full', budget: 10 });
  assert.equal(tight.budget, 10);
  assert.equal(tight.tasks.length, 5);
  assert.deepEqual(tight.overBudget, tight.tasks.map((item) => item.id));
  const text = formatPrompts(tight);
  assert.match(text, /^prompts: 5 \(model sha256:[0-9a-f]{64}\)/);
  assert.match(text, /budget: 10 tokens/);
  assert.equal(text.split('\n').filter((line) => line.includes('over-budget')).length, 5);

  const roomy = buildPrompts(files, { format: 'full' });
  assert.deepEqual(roomy.overBudget, []);
  assert.ok(!formatPrompts(roomy).includes('over-budget'));
});

test('full prompts are deterministic and differ per operation', async () => {
  const first = buildPrompts(once, { format: 'full' });
  const second = buildPrompts(parse(await sourceOf('onetimemessage'), 'main.arc'), { format: 'full' });
  assert.deepEqual(second.tasks.map((item) => item.sha256), first.tasks.map((item) => item.sha256));
  const [create, read] = first.tasks;
  assert.notEqual(create.sha256, read.sha256);
  assert.equal(create.tokens, Math.ceil(create.prompt.length / 4));
});

async function sourceOf(name: string): Promise<string> {
  return readFile(new URL('../examples/' + name + '/main.arc', import.meta.url), 'utf8');
}

test('a module without a service is an error, not an empty prompt set', () => {
  assert.throws(() => buildPrompts(parse('module empty @0.1.0 {}', 'main.arc')), /no service to build prompts for/);
});
