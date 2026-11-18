// Declarations of one kind are a group in the module printer, and the printer
// used to write the group's members back to back. That is right for type
// aliases and `error NotFound`, but a service/workflow/environment block ends
// with a closing brace, so two of them ran together as
// "}\nworkflow Two {" — which reads like a syntax error in a formatted file and
// makes every added workflow a diff of the previous one's last line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../src/fmt.ts';

const head = `module m @0.1.0 {
}

type Item = { id: uuid }

service Items : http {
  contract {
    public op list() -> { items: list<Item> } {
      route: "GET /v1/items"
    }
  }
}
`;

function workflow(name: string, step: string): string {
  return `
workflow ${name} {
  trigger manual
  step ${step}() {
    call: Items.list
  }
}
`;
}

function fmt(source: string): string {
  const once = formatSource(source, 'layout.arc');
  assert.equal(formatSource(once, 'layout.arc'), once, 'formatting is idempotent');
  return once;
}

test('two workflows are separated by one blank line', () => {
  const out = fmt(head + workflow('One', 'touch') + workflow('Two', 'touch2'));
  assert.ok(out.includes('}\n\nworkflow Two {'), 'a blank line precedes the second workflow');
  assert.ok(!out.includes('}\nworkflow Two {'), 'no header glued to the previous brace');
  assert.equal(out.match(/\n\n\n/g), null, 'never more than one blank line');
});

test('two environments are separated by one blank line', () => {
  const out = fmt(head + `
environment prod {
  deploy docker
}

environment dev {
  deploy docker
}
`);
  assert.ok(out.includes('}\n\nenvironment dev {'));
});

test('single-line declarations of one group stay adjacent', () => {
  const out = fmt(head + `
error NotFound
error Conflict
`);
  assert.ok(out.includes('error NotFound\nerror Conflict'), 'one short declaration per line, no padding');
});

test('an error with fields is separated from a bare one', () => {
  const out = fmt(`module m @0.1.0 {
}

error NotFound
error Conflict {
  fence: int
}
`);
  assert.ok(out.includes('error NotFound\n\nerror Conflict {'), 'a field list is a block and gets its own paragraph');
});

test('comments above a block stay attached to it', () => {
  const out = fmt(head + `
// runs at night
workflow Night {
  trigger manual
  step touch() {
    call: Items.list
  }
}

workflow Day {
  trigger manual
  step touch2() {
    call: Items.list
  }
}
`);
  assert.ok(out.includes('}\n\n// runs at night\nworkflow Night {'), 'the blank line goes before the comment');
  assert.ok(out.includes('}\n\nworkflow Day {'));
});
