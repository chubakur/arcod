// One spec per diagnostic that had no test of its own. Each case is the
// smallest model that must produce the code: if a check silently stops firing,
// or starts firing on a clean model, this file names the promise that broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

function codes(source: string): Set<string> {
  return new Set(check(parse(source, 'gaps.arc')).filter((d) => d.severity === 'error').map((d) => d.code));
}

function messages(source: string, code: string): string[] {
  return check(parse(source, 'gaps.arc')).filter((d) => d.code === code).map((d) => d.message);
}

const service = (body: string, extra = ''): string => [
  'module gaps @0.1.0 {',
  '}',
  '',
  'error NotFound',
  'error Gone',
  '',
  'service S : http {',
  body,
  '}',
  '',
  extra,
].join('\n');

test('A005: a write call inside an invariant', () => {
  const source = service([
    '  uses store: kv',
    '  effects {',
    '    allow store.get, store.set',
    '  }',
    '',
    '  rules {',
    '    invariant touch: store.set("k", 1)',
    '  }',
    '',
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      effects: store.get',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.ok(codes(source).has('A005'), 'a write in an invariant is refused');
  assert.match(messages(source, 'A005')[0] ?? '', /write call store\.set in an invariant/);
});

test('A007: a declared error that is neither handled nor asserted', () => {
  const source = service([
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      errors: NotFound',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.ok(codes(source).has('A007'));
  assert.match(messages(source, 'A007')[0] ?? '', /error NotFound is declared but not handled/);
});

test('A078: an error name nothing declares', () => {
  const listed = service([
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      errors: Missing',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.ok(codes(listed).has('A078'), 'errors: names an undeclared error');
  assert.match(messages(listed, 'A078')[0] ?? '', /unknown error Missing/);
  const hinted = check(parse(listed, 'gaps.arc')).find((item) => item.code === 'A078');
  assert.match(hinted?.hint ?? '', /declared: NotFound, Gone/, 'the hint lists what exists');
  assert.ok(!codes(listed).has('A007'), 'A007 is about a declared error, not a typo');

  const handled = service([
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      errors: NotFound',
    '      on error Missing: k != null',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.ok(codes(handled).has('A078'), 'on error names an undeclared error too');

  const clean = service([
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      errors: NotFound',
    '      on error NotFound: k != null',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.ok(!codes(clean).has('A078'), 'a declared error passes');
  assert.ok(!codes(clean).has('A007'), 'and it is handled');
});

test('W039: a handler for an error the contract does not list', () => {
  const body = (list: boolean) => service([
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    ...(list ? ['      errors: Gone'] : []),
    '      on error Gone: k != null',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));

  const diags = check(parse(body(false), 'gaps.arc'));
  const w039 = diags.find((item) => item.code === 'W039');
  assert.ok(w039, 'an unlisted handler is a warning');
  assert.equal(w039!.severity, 'warning');
  assert.match(w039!.message, /on error Gone is not listed in errors: read/);
  assert.match(w039!.hint ?? '', /add Gone to errors:/);

  const listed = check(parse(body(true), 'gaps.arc'));
  assert.equal(listed.filter((item) => item.code === 'W039').length, 0, 'listing the error silences the warning');
});

test('A008: a budget line without a comparison', () => {
  const source = service([
    '  budget {',
    '    latency: 50ms',
    '    concurrency: 100',
    '  }',
    '',
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.ok(codes(source).has('A008'), 'latency without <= is not a budget');
  assert.match(messages(source, 'A008')[0] ?? '', /budget without a metric or unit/);
});

test('A009: one alias declared twice', () => {
  const source = service([
    '  uses store: kv',
    '  uses store: kv',
    '',
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      effects: store.get',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.ok(codes(source).has('A009'));
  assert.match(messages(source, 'A009')[0] ?? '', /alias store is declared twice/);
});

test('A010: a cycle in ordering', () => {
  const source = service([
    '  rules {',
    '    ordering {',
    '      read before write',
    '      write before read',
    '    }',
    '  }',
    '',
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      post: result != null',
    '    }',
    '',
    '    public op write(k: string) -> string {',
    '      route: "POST /v1/k"',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.ok(codes(source).has('A010'));
  assert.match(messages(source, 'A010')[0] ?? '', /cycle in ordering/);
});

test('A010: a chain of ordering rules is a DAG, not a cycle', () => {
  // The other half of the cycle check: walking a graph that ends must finish
  // nodes instead of reporting the first path it happened to take.
  const source = service([
    '  rules {',
    '    ordering {',
    '      read before write',
    '      write before sync',
    '      read before sync',
    '    }',
    '  }',
    '',
    '  contract {',
    '    public op read() -> string {',
    '      route: "GET /v1/read"',
    '    }',
    '    public op write() -> string {',
    '      route: "POST /v1/write"',
    '    }',
    '    public op sync() -> string {',
    '      route: "POST /v1/sync"',
    '    }',
    '  }',
  ].join('\n'));
  assert.deepEqual(messages(source, 'A010'), []);
});

test('A019: a ui kind other than spa', () => {
  const source = [
    'module gaps @0.1.0 {',
    '}',
    '',
    'service S : http {',
    '  contract {',
    '    public op list() -> { items: list<string> } {',
    '      route: "GET /v1/items"',
    '      post: result != null',
    '    }',
    '  }',
    '}',
    '',
    'ui Web {',
    '  kind: web',
    '  route: "/"',
    '  title: "Web"',
    '  uses S.list',
    '}',
  ].join('\n');
  assert.ok(codes(source).has('A019'));
  assert.match(messages(source, 'A019')[0] ?? '', /ui kind web is not supported in v0\.1/);
});

test('A027: an effect under an alias the service never declared', () => {
  const source = service([
    '  uses store: kv',
    '',
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      effects: ghost.write',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.ok(codes(source).has('A027'));
  assert.match(messages(source, 'A027')[0] ?? '', /alias ghost is not declared in uses/);
});

test('A032: one step name declared twice in a workflow', () => {
  const source = [
    'module gaps @0.1.0 {',
    '}',
    '',
    'service S : http {',
    '  contract {',
    '    public op list() -> { items: list<string> } {',
    '      route: "GET /v1/items"',
    '      post: result != null',
    '    }',
    '  }',
    '}',
    '',
    'workflow Night {',
    '  trigger manual',
    '  step touch() {',
    '    call: S.list',
    '  }',
    '',
    '  step touch() {',
    '    call: S.list',
    '  }',
    '}',
  ].join('\n');
  assert.ok(codes(source).has('A032'));
  assert.match(messages(source, 'A032')[0] ?? '', /step touch is declared twice/);
});
// Warnings are promises too: a warning that stops firing hides a model smell
// that the author would otherwise never see.
function warnings(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of check(parse(source, 'gaps.arc'))) {
    if (d.severity !== 'warning') continue;
    const list = out.get(d.code) ?? [];
    list.push(d.message);
    out.set(d.code, list);
  }
  return out;
}

test('W011: a capability declared but never used', () => {
  const source = service([
    '  uses store: kv',
    '',
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.match(warnings(source).get('W011')?.[0] ?? '', /capability kv is declared but not used/);
});

test('W012: an operation without examples', () => {
  const source = service([
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  assert.match(warnings(source).get('W012')?.[0] ?? '', /operation read has no examples/);
});

test('W015: a module error nobody mentions', () => {
  // `Gone` and `NotFound` are declared at module level in this helper and no
  // contract names them.
  const source = service([
    '  contract {',
    '    public op read(k: string) -> string {',
    '      route: "GET /v1/k"',
    '      post: result != null',
    '    }',
    '  }',
  ].join('\n'));
  const gone = warnings(source).get('W015') ?? [];
  assert.ok(gone.some((message) => /error Gone is declared but never used/.test(message)), gone.join(' | '));
});

test('W019: a deploy provider does not know an argument', () => {
  const source = [
    'module gaps @0.1.0 {',
    '}',
    '',
    'service S : http {',
    '  contract {',
    '    public op list() -> { items: list<string> } {',
    '      route: "GET /v1/items"',
    '      post: result != null',
    '    }',
    '  }',
    '}',
    '',
    'environment prod {',
    '  deploy docker(bogus: 1)',
    '}',
  ].join('\n');
  assert.match(warnings(source).get('W019')?.[0] ?? '', /provider docker does not know argument bogus/);
});

test('W023 and W024: a step with no call, and a call to nothing', () => {
  const source = [
    'module gaps @0.1.0 {',
    '}',
    '',
    'service S : http {',
    '  contract {',
    '    public op list() -> { items: list<string> } {',
    '      route: "GET /v1/items"',
    '      post: result != null',
    '    }',
    '  }',
    '}',
    '',
    'workflow Night {',
    '  trigger manual',
    '  step bare() {',
    '    needs: known',
    '  }',
    '',
    '  step known() {',
    '    call: S.list',
    '  }',
    '}',
  ].join('\n');
  const found = warnings(source);
  assert.match(found.get('W024')?.[0] ?? '', /step without call/);

  const missing = source.replace('call: S.list', 'call: S.missing');
  assert.match(warnings(missing).get('W023')?.[0] ?? '', /call S\.missing is not declared in the module/);
});

test('W020: onFail skip starves a dependent step', () => {
  const source = [
    'module gaps @0.1.0 {',
    '}',
    '',
    'service S : http {',
    '  contract {',
    '    public op list() -> { items: list<string> } {',
    '      route: "GET /v1/items"',
    '      post: result != null',
    '    }',
    '  }',
    '}',
    '',
    'workflow Night {',
    '  trigger manual',
    '  step first() {',
    '    call: S.list',
    '    onFail: skip',
    '  }',
    '',
    '  step second() {',
    '    call: S.list',
    '    needs: first',
    '  }',
    '}',
  ].join('\n');
  assert.match(warnings(source).get('W020')?.[0] ?? '', /onFail: skip, but these steps depend on it: second/);
});

test('A063: an example argument that fits no union variant names the union', () => {
  // A union parameter is judged variant by variant: any variant accepting the
  // value keeps the example clean, and a value no variant accepts reports the
  // union spelling instead of the first variant it tried.
  const source = [
    'module gaps @0.1.0 {',
    '}',
    '',
    'service S : http {',
    '  contract {',
    '    public op submit(value: int | string) -> string {',
    '      route: "POST /v1/submit"',
    '    }',
    '  }',
    '',
    '  examples {',
    '    example accepts_both {',
    '      when {',
    '        submit(1)',
    '        submit("x")',
    '      }',
    '      then { true }',
    '    }',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(messages(source, 'A063'), []);

  const broken = source.replace('submit(1)', 'submit(true)');
  assert.deepEqual(messages(broken, 'A063'), [
    'example accepts_both: argument 1 of submit: expects int | string, got true',
  ]);
});

