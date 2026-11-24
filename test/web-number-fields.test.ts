import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { emitWeb } from '../src/emit/web.ts';

// A number field carries three contract facts: the bounds, whether a fraction
// is allowed, and therefore the step. Missing any of them makes the browser
// reject a value the service accepts (or send a string where the schema says
// number), so each one is checked against the emitted page, not a guess.

const source = `module money @0.1.0 {}

type Money = decimal(min: 0.5, max: 99.5)

service Shop : http {
  contract {
    public op buy(price: Money, qty: int(min: 1, max: 5), ratio: number(min: 0, max: 1), score: float) -> string {
      route: "POST /v1/buy"
    }
  }
}

ui Web {
  kind: spa
  route: "/"
  title: "Shop"
  uses Shop.buy
}
`;

type Field = { name: string; kind: string; max: number | null; min: number | null; integer: boolean };

function field(html: string, name: string): Field {
  const match = html.match(new RegExp('\\{"name":"' + name + '"[^}]*\\}'));
  assert.ok(match, 'field ' + name + ' exists');
  return JSON.parse(match![0]) as Field;
}

const html = emitWeb(parse(source, 'money.arc'), { maxBytes: 65536 });

test('a decimal parameter is a number field, with its bounds', () => {
  const price = field(html, 'price');
  assert.equal(price.kind, 'number', 'decimal is published as type: number');
  assert.equal(price.min, 0.5);
  assert.equal(price.max, 99.5);
  assert.equal(price.integer, false, 'a decimal accepts a fraction');
});

test('only int is a whole number', () => {
  assert.equal(field(html, 'qty').integer, true);
  assert.equal(field(html, 'ratio').integer, false);
  assert.equal(field(html, 'score').integer, false, 'an unbounded float still allows a fraction');
});

type FakeEl = { tag: string; [key: string]: unknown };

function fakeDoc() {
  return {
    createElement: (tag: string): FakeEl => ({
      tag,
      setAttribute(name: string, value: string) {
        this[name] = value;
      },
    }),
  };
}

// The page is plain DOM, so the emitted control builder runs against a minimal
// document instead of a browser.
function controlBuilder(): (p: Record<string, unknown>) => FakeEl {
  const body = html.match(/function fieldControl\(p\) \{[\s\S]*?\n\}/);
  assert.ok(body, 'the page ships fieldControl');
  const build = new Function('document', body![0] + '; return fieldControl;') as (doc: unknown) => (p: Record<string, unknown>) => FakeEl;
  return (p) => build(fakeDoc())(p);
}

test('a fractional number field does not inherit step 1', () => {
  const control = controlBuilder();
  const price = control({ name: 'price', kind: 'number', min: 0.5, max: 99.5, integer: false });
  assert.equal(price.type, 'number');
  assert.equal(price.step, 'any', '1.5 is a step mismatch with the browser default');
  assert.equal(price.min, '0.5');
  assert.equal(price.max, '99.5');
  const qty = control({ name: 'qty', kind: 'number', min: 1, max: 5, integer: true });
  assert.equal(qty.step, '1', 'an int keeps the whole-number step');
});
