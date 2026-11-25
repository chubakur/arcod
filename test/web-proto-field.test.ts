// The page's submit handler reads one control per parameter. It asked the
// form's element collection for a *name*: \`form.elements[p.name]\`. A named
// read on that collection falls through to Object.prototype, so a parameter
// called toString returned a function instead of the input, and the field
// silently left the request body (JSON.stringify drops undefined). The control
// is now found by its name attribute.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parse } from '../src/parser.ts';
import { emitWeb } from '../src/emit/web.ts';

const SPEC = `module webproto @0.1.0 {}

service S : http {
  contract {
    public op mark(toString: string, note: string) -> string {
      route: "POST /v1/mark"
    }
  }
}

ui Web {
  kind: spa
  route: "/"
  title: "Proto"
  uses S.mark
}

environment dev {
  deploy docker
}
`;

// The page script is one <script> block with OPS inlined. Extract the helpers
// the submit handler needs, so the test runs the emitted code, not a copy.
function script(html: string): string {
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>');
  assert.ok(start >= 0 && end > start, 'the page has no script block');
  return html.slice(start + '<script>'.length, end);
}

function block(source: string, from: string): string {
  const at = source.indexOf(from);
  assert.ok(at >= 0, 'missing ' + from);
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('unbalanced block: ' + from);
}

test('a parameter named toString keeps its value in the request body', async () => {
  const html = emitWeb(parse(SPEC, 'main.arc'), { maxBytes: 65536 });
  const code = script(html);
  const ops = code.match(/var OPS = ([\s\S]*?);\n/);
  assert.ok(ops, 'OPS is not in the script');
  const op = (JSON.parse(ops[1]) as Array<{ name: string }>).find((item) => item.name === 'mark');
  assert.ok(op, 'the page has no form for mark');

  const body: string[] = [];
  const sandbox: Record<string, unknown> = {
    OPS: [op],
    TOKEN_KEY: 'token',
    localStorage: { getItem: () => null },
    fetch: async (_url: string, init: { body?: string }) => {
      body.push(String(init.body));
      return { status: 200, text: async () => '{}' };
    },
    showError: () => {},
    renderResult: () => {},
    URLSearchParams,
  };
  vm.createContext(sandbox);
  vm.runInContext(block(code, 'function fillPath'), sandbox);
  vm.runInContext(block(code, 'async function run'), sandbox);

  // A form whose element collection is a plain object: exactly the shape a
  // named read falls through on, while querySelector answers the control.
  const values: Record<string, { value: string }> = {
    toString: { value: 'proto' },
    note: { value: 'hello' },
  };
  const form = {
    elements: {},
    querySelector: (selector: string) => {
      const found = selector.match(/\[name="(.+)"\]/);
      return found ? values[found[1]] ?? null : null;
    },
  };
  const button = { disabled: false };
  const out = { hidden: true, innerHTML: '' };

  await (sandbox.run as (op: unknown, form: unknown, out: unknown, button: unknown) => Promise<void>)(op, form, out, button);
  assert.equal(body.length, 1, 'the form did not submit');
  assert.deepEqual(JSON.parse(body[0]), { toString: 'proto', note: 'hello' });
});
