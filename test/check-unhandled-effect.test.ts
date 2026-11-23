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
  'use capability arcod.std.sql @1',
  'error Unavailable',
  'external service Ledger : http {',
  '  contract {',
  '    op record(entry: string) -> string {',
  '      route: "POST /v1/entries"',
  '    }',
  '  }',
  '}',
  'service Orders : http {',
  '  uses store: sql',
  '  effects {',
  '    allow store.insert, Ledger.record',
  '  }',
  '  contract {',
  '    public op charge(entry: string) -> string {',
  '      route: "POST /v1/orders"',
  '      effects: store.insert, Ledger.record',
  ...errors.map((row) => '  ' + row),
  '      post: result != null',
  '    }',
  '  }',
  '}',
);

const sqlBind = (host: string) => lines(
  '',
  'environment dev {',
  '  bind store -> postgres(' + host + ')',
  '}',
);

const sqlSpec = (host: string | null) => lines(
  'module m @0.1.0 {}',
  'use capability arcod.std.sql @1',
  'error Unavailable',
  'service S : http {',
  '  uses store: sql',
  '  effects {',
  '    allow store.insert',
  '  }',
  '  contract {',
  '    public op save(entry: string) -> string {',
  '      route: "POST /v1/entries"',
  '      effects: store.insert',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  host === null ? '' : sqlBind(host),
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

test('an external service effect without a covering error is W048', () => {
  const diags = codes(externalSpec([])).filter((d) => d.code === 'W048');
  assert.equal(diags.length, 1, JSON.stringify(diags));
  assert.match(diags[0].message, /charge calls Ledger\.record/);
});

test('a named Unavailable silences the external call as well', () => {
  const diags = codes(externalSpec(['errors: Unavailable', 'on error Unavailable: entry != null']))
    .filter((d) => d.code === 'W048');
  assert.deepEqual(diags, []);
});

test('a sql effect on a host-bound alias is W048; a local bind is not', () => {
  const remote = codes(sqlSpec('host: "db.example.com", port: 5432')).filter((d) => d.code === 'W048');
  assert.equal(remote.length, 1, JSON.stringify(remote));
  assert.match(remote[0].message, /save calls store\.insert/);

  assert.deepEqual(codes(sqlSpec(null)).filter((d) => d.code === 'W048'), []);
  assert.deepEqual(codes(sqlSpec('')).filter((d) => d.code === 'W048'), []);
});
