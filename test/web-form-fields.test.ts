import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { emitWeb } from '../src/emit/web.ts';

// The generated page reads its fields from the contract. A record parameter
// has no input control, so it becomes a JSON field; a bytes limit arrives as a
// max in characters, which means the kb/mb/gb units are converted, not copied.

const source = `module fields @0.1.0 {}

type Filter = { q: string, limit: int }

service S : http {
  contract {
    public op search(filter: Filter, body: bytes(max: 2kb), small: string(max: 12)) -> string {
      route: "POST /v1/search"
    }
    public op upload(a: bytes(max: 1mb), b: bytes(max: 1gb)) -> string {
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

function fields(html: string, name: string): { kind: string; where: string; optional: boolean; max: number | null } {
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
