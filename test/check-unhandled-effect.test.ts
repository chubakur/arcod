// A request that reaches a model endpoint or a foreign service can be refused:
// 403 from a gateway, 429 from a provider, an unreachable host. The runtime
// turns an undeclared throw into 500 Internal, so the body's contract is the
// only place the client learns the call may fail. W048 says it at the effects
// clause, the line that is the body in this language (B63).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const NL = String.fromCharCode(10);

const lines = (...rows: string[]) => rows.join(NL);

const llmSpec = (opExtra: string[]) => lines(
  'module m @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.llm @1',
  'error Unavailable',
  'service S : http {',
  '  uses store: kv',
  '  uses llm: llm',
  '  effects {',
  '    allow store.get, store.set, llm.chat, llm.embed',
  '  }',
  '  contract {',
  '    public op ask(text: string) -> string {',
  '      route: "POST /v1/ask"',
  '      effects: store.get, llm.chat',
  ...opExtra.map((row) => '  ' + row),
  '      post: result != null',
  '    }',
  '  }',
  '}',
);

const externalSpec = (errors: string[]) => lines(
  'module m @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'error Unavailable',
  'external service Ledger : http {',
  '  contract {',
  '    op record(entry: string) -> string {',
  '      route: "POST /v1/entries"',
  '    }',
  '  }',
  '}',
  'service Orders : http {',
  '  uses store: kv',
  '  effects {',
  '    allow store.set, Ledger.record',
  '  }',
  '  contract {',
  '    public op charge(entry: string) -> string {',
  '      route: "POST /v1/orders"',
  '      effects: store.set, Ledger.record',
  ...errors.map((row) => '  ' + row),
  '      post: result != null',
  '    }',
  '  }',
  '}',
);

const codes = (src: string) => check(parse(src, 'main.arc'));

test('llm.chat without a covering error is W048', () => {
  const diags = codes(llmSpec([])).filter((d) => d.code === 'W048');
  assert.equal(diags.length, 1, JSON.stringify(diags));
  assert.equal(diags[0].severity, 'warning');
  assert.match(diags[0].message, /ask calls llm\.chat, which can fail, and declares no error for it/);
  assert.match(diags[0].hint ?? '', /add Unavailable to errors: ask/);
});

test('a declared Unavailable covers llm.chat', () => {
  const diags = codes(llmSpec(['errors: Unavailable', 'on error Unavailable: text != null'])).filter((d) => d.code === 'W048');
  assert.deepEqual(diags, []);
});

test('RateLimited and Forbidden cover the failure too', () => {
  for (const name of ['RateLimited', 'Forbidden']) {
    const src = llmSpec(['errors: ' + name, 'on error ' + name + ': text != null']).replace('error Unavailable', 'error ' + name);
    assert.deepEqual(codes(src).filter((d) => d.code === 'W048'), [], name);
  }
});

test('llm.embed is reported as well', () => {
  const src = llmSpec([]).replace('effects: store.get, llm.chat', 'effects: store.get, llm.embed');
  const diags = codes(src).filter((d) => d.code === 'W048');
  assert.equal(diags.length, 1, JSON.stringify(diags));
  assert.match(diags[0].message, /ask calls llm\.embed/);
});

test('an external service effect without a covering error is W048', () => {
  const diags = codes(externalSpec([])).filter((d) => d.code === 'W048');
  assert.equal(diags.length, 1, JSON.stringify(diags));
  assert.match(diags[0].message, /charge calls Ledger\.record/);
});

test('a declared Unavailable silences the external call as well', () => {
  const diags = codes(externalSpec(['errors: Unavailable', 'on error Unavailable: entry != null']))
    .filter((d) => d.code === 'W048');
  assert.deepEqual(diags, []);
});

test('a local store effect is not a W048: every bind can be remote', () => {
  const diags = codes(llmSpec(['errors: Unavailable']).replace('llm.chat', 'store.set'));
  assert.deepEqual(diags.filter((d) => d.code === 'W048'), []);
});

test('the hint does not name an error the module never declared', () => {
  const src = llmSpec([]).replace('error Unavailable' + NL, '');
  const diags = codes(src).filter((d) => d.code === 'W048');
  assert.equal(diags.length, 1, JSON.stringify(diags));
  assert.match(diags[0].hint ?? '', /declare error Unavailable, then add it to errors: ask/);
});

test('the hint names the covering error the module does declare', () => {
  const src = llmSpec([]).replace('error Unavailable', 'error RateLimited');
  const diags = codes(src).filter((d) => d.code === 'W048');
  assert.equal(diags.length, 1, JSON.stringify(diags));
  assert.match(diags[0].hint ?? '', /add RateLimited to errors: ask/);
});

test('a job is not reported: there is no error contract to answer', () => {
  const src = lines(
    'module m @0.1.0 {}',
    'use capability arcod.std.llm @1',
    'use capability arcod.std.kv @1',
    'use capability arcod.std.queue @1',
    'service S : http {',
    '  uses llm: llm',
    '  uses store: kv',
    '  uses events: queue',
    '  effects {',
    '    allow llm.chat, store.set, events.publish',
    '  }',
    '  contract {',
    '    job tick(text: string) {',
    '      on: events.tick',
    '      effects: llm.chat',
    '    }',
    '  }',
    '}',
    '',
    'environment dev {',
    '  bind llm -> openai(model: "gpt-4o-mini")',
    '  bind store -> redis(host: "kv")',
    '  bind events -> redis(host: "events")',
    '}',
  );
  assert.deepEqual(codes(src).filter((d) => d.code === 'W048'), []);
});

test('Forbidden covers a foreign call', () => {
  const diags = codes(externalSpec(['errors: Forbidden', 'on error Forbidden: entry != null']).replace('error Unavailable', 'error Forbidden'))
    .filter((d) => d.code === 'W048');
  assert.deepEqual(diags, []);
});

test('the same effect named twice is reported once', () => {
  const src = llmSpec([]).replace('      effects: store.get, llm.chat', '      effects: llm.chat' + NL + '      effects: store.get, llm.chat');
  const diags = codes(src).filter((d) => d.code === 'W048');
  assert.equal(diags.length, 1, JSON.stringify(diags));
});

test('two different fallible effects are two warnings', () => {
  const src = llmSpec([]).replace('effects: store.get, llm.chat', 'effects: llm.chat, llm.embed');
  const diags = codes(src).filter((d) => d.code === 'W048').map((d) => d.message);
  assert.equal(diags.length, 2, JSON.stringify(diags));
  assert.match(diags.join(' '), /llm\.chat/);
  assert.match(diags.join(' '), /llm\.embed/);
});
