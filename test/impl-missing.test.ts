// W049 says a body file matches no operation; W050 is the other side of the
// same typo: the operation has no body, so its route answers 501
// NotImplemented at request time. An external service describes someone else's
// API and a saga job is orchestrated by its steps, so neither owns a body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';

const HEAD = `module missing @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
    since: "2026-11-23"
  }
}

use capability arcod.std.sql @1

type Line = { id: string, amount: int }
`;

const BODY = (op: string): string =>
  'export async function ' + op + '(input, io) {\n' +
  '  return { result: await io.aggregate("Line", { field: "amount", op: "sum" }) };\n' +
  '}\n';

function spec(body: string): string {
  return HEAD + body;
}

function warnings(source: string, impl: Record<string, string> | undefined) {
  return check(parse(source, 'main.arc'), { impl }).filter((item) => item.code === 'W050');
}

test('W050: an operation with no body is a warning with the operation name', () => {
  const source = spec(`
service Lines : http {
  uses store: sql

  effects {
    allow store.aggregate
  }

  contract {
    public op totals() -> int {
      route: "GET /v1/totals"
      effects: store.aggregate
      post: result != null
    }

    public op audit() -> int {
      route: "GET /v1/audit"
      effects: store.aggregate
      post: result != null
    }
  }
}

environment dev {
  bind store -> mysql
  deploy docker
}
`);
  const found = warnings(source, { totals: BODY('totals') });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].message, /operation audit has no body in impl\//);
  assert.match(String(found[0].hint), /impl\/audit\.mjs/);
});

test('W050: no impl at all stays quiet (the project may be all 501)', () => {
  const source = spec(`
service Lines : http {
  uses store: sql

  contract {
    public op totals() -> int {
      route: "GET /v1/totals"
      post: result != null
    }
  }
}
`);
  assert.deepEqual(warnings(source, undefined), []);
});

test('W050: an external service and a saga job own no body here', () => {
  const source = spec(`
external service Ledger : http {
  contract {
    op record(amount: int) -> int {
      route: "POST /v1/records"
    }
  }
}

service Checkout : http {
  uses store: sql

  effects {
    allow store.get
  }

  contract {
    job run_checkout(label: string) {
      saga: checkout
    }
  }

  saga checkout {
    step charge { call: get_total }
  }
}

environment dev {
  bind store -> mysql
  deploy docker
}
`);
  const found = warnings(source, {});
  assert.deepEqual(found.map((item) => item.message), []);
});
