import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { emitWeb } from '../src/emit/web.ts';

// The generated page reads its fields from the contract. A record parameter
// has no input control, so it becomes a JSON field; a bytes limit arrives as a
// max in characters, which means the kb/mb/gb units are converted, not copied.

const source = `module fields @0.1.0 {}

type Filter = { q: string, limit: int }

enum Plan { free, pro, team }

service S : http {
  contract {
    public op search(filter: Filter, plan: Plan, coupon: Plan?, body: bytes(max: 2kb), small: string(max: 12)) -> string {
      route: "POST /v1/search"
    }
    public op upload(a: bytes(max: 1mb), b: bytes(max: 1gb), mail: email, n: int(min: 2, max: 7)) -> string {
      route: "POST /v1/upload"
    }
  }
}

ui Web {
  kind: spa
  route: "/"
  title: "Fields"
  uses S.search, S.upload
}

environment dev {
  deploy docker
}
`;

function fields(html: string, name: string): { kind: string; where: string; optional: boolean; max: number | null; min?: number | null; options?: string[]; format?: string | null } {
  const match = html.match(new RegExp('\\{"name":"' + name + '"[^}]*\\}'));
  assert.ok(match, 'field ' + name + ' exists');
  return JSON.parse(match![0]);
}

test('a record parameter of a form becomes a JSON field', () => {
  const html = emitWeb(parse(source, 'fields.arc'), { maxBytes: 65536 });
  const field = fields(html, 'filter');
  assert.equal(field.kind, 'json');
  assert.equal(field.where, 'body');
});

test('a textarea field carries the limit the API enforces', () => {
  const html = emitWeb(parse(source, 'fields.arc'), { maxBytes: 65536 });
  const body = html.match(/function fieldControl\(p\) \{[\s\S]*?\n\}/);
  assert.ok(body, 'the page ships fieldControl');
  // Run the emitted control builder against a minimal document: the form is
  // plain DOM, so the check needs no browser.
  const build = new Function('document', body![0] + '; return fieldControl;') as (doc: unknown) => (p: unknown) => Record<string, unknown>;
  const doc = {
    createElement: (tag: string) => ({
      tag,
      setAttribute(name: string, value: string) {
        (this as Record<string, unknown>)[name] = value;
      },
    }),
  };
  const textarea = build(doc)({ name: 'body', kind: 'textarea', max: 2048, optional: false });
  assert.equal(textarea.tag, 'textarea');
  assert.equal(textarea.maxLength, 2048, '2kb is a character ceiling on the textarea too');
  const plain = build(doc)({ name: 'small', kind: 'text', max: 12, optional: false });
  assert.equal(plain.maxLength, 12);
});

test('a bytes limit is converted from its unit before it reaches maxlength', () => {
  const html = emitWeb(parse(source, 'fields.arc'), { maxBytes: 65536 });
  assert.equal(fields(html, 'body').max, 2048);
  assert.equal(fields(html, 'body').kind, 'textarea', '2kb is over the default input threshold');
  assert.equal(fields(html, 'small').max, 12);
  assert.equal(fields(html, 'small').kind, 'text');
  assert.equal(fields(html, 'a').max, 1024 * 1024);
  assert.equal(fields(html, 'b').max, 1024 * 1024 * 1024);
});

// An enum is a closed set in the contract: the service answers 400 "must be one
// of ..." for anything else, so the form offers the values instead of a text
// field. The same resolver feeds OpenAPI, so the list cannot drift.
test('a declared enum becomes a dropdown of the accepted values', () => {
  const html = emitWeb(parse(source, 'fields.arc'), { maxBytes: 65536 });
  const plan = fields(html, 'plan');
  assert.equal(plan.kind, 'select');
  assert.deepEqual(plan.options, ['free', 'pro', 'team']);
  const coupon = fields(html, 'coupon');
  assert.equal(coupon.kind, 'select', 'an optional enum is still a closed set');
  assert.equal(coupon.optional, true);
  assert.deepEqual(coupon.options, ['free', 'pro', 'team']);
  assert.equal(fields(html, 'small').kind, 'text', 'a plain string stays a text field');
});

type FakeEl = { tag: string; children: FakeEl[]; [key: string]: unknown; setAttribute(name: string, value: string): void; appendChild(child: FakeEl): void };

function fakeDoc() {
  return {
    createElement: (tag: string): FakeEl => ({
      tag,
      children: [],
      setAttribute(name: string, value: string) {
        this[name] = value;
      },
      appendChild(child: FakeEl) {
        this.children.push(child);
      },
    }),
  };
}

// The page is plain DOM, so the emitted control builder runs against a minimal
// document instead of a browser.
function controlBuilder(html: string): (p: Record<string, unknown>) => FakeEl {
  const body = html.match(/function fieldControl\(p\) \{[\s\S]*?\n\}/);
  assert.ok(body, 'the page ships fieldControl');
  const build = new Function('document', body![0] + '; return fieldControl;') as (doc: unknown) => (p: Record<string, unknown>) => FakeEl;
  return (p) => build(fakeDoc())(p);
}

test('the dropdown keeps an empty choice only when the parameter is optional', () => {
  const control = controlBuilder(emitWeb(parse(source, 'fields.arc'), { maxBytes: 65536 }));
  const required = control({ name: 'plan', kind: 'select', options: ['free', 'pro', 'team'], optional: false });
  assert.equal(required.tag, 'select');
  assert.deepEqual(required.children.map((child) => child.value), ['free', 'pro', 'team']);
  const optional = control({ name: 'coupon', kind: 'select', options: ['free'], optional: true });
  assert.deepEqual(optional.children.map((child) => child.value), ['', 'free']);
  assert.equal(optional['aria-required'], undefined, 'an optional field is not marked required');
});

test('an email parameter is an email field and a bounded int carries its bounds', () => {
  const html = emitWeb(parse(source, 'fields.arc'), { maxBytes: 65536 });
  assert.equal(fields(html, 'mail').format, 'email');
  assert.equal(fields(html, 'n').min, 2);
  assert.equal(fields(html, 'n').max, 7);
  const control = controlBuilder(html);
  const mail = control({ name: 'mail', kind: 'text', format: 'email' });
  assert.equal(mail.type, 'email', 'the browser checks the format the API enforces');
  const bounded = control({ name: 'n', kind: 'number', min: 2, max: 7 });
  assert.equal(bounded.type, 'number');
  assert.equal(bounded.min, '2');
  assert.equal(bounded.max, '7');
  const unbounded = control({ name: 'limit', kind: 'number', min: null, max: null });
  assert.equal(unbounded.min, undefined, 'no invented bound when the contract has none');
});
