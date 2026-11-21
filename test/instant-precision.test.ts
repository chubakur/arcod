// A millisecond is the resolution every layer keeps: MySQL's DATETIME(3), the
// canonical spelling (`canonicalInstant`), and the runtime field. A default
// written with more digits is cut — so the compiler either cuts a digit that
// changes nothing (`.1230` is the millisecond `.123`) or refuses the default
// (`.1234` names an instant no column can hold). A trigger `at(...)` is the
// other side of the rule: the manifest carries the instant verbatim for the
// runner, so a finer fraction survives there and is not an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { deployManifest } from '../src/deploy.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';

function spec(defaultLiteral: string): string {
  return `module m @0.1.0 {
}

type Event = {
  id: uuid,
  at: datetime = ${defaultLiteral}
}

service Events : http {
  contract {
    public op one(id: uuid) -> Event {
      route: "GET /v1/events/:id"
    }
  }
}
`;
}

function errorsOf(source: string): ReturnType<typeof check> {
  return check(parse(source, 'default.arc')).filter((item) => item.severity === 'error');
}

function publishedDefault(source: string): unknown {
  const mod = parse(source, 'default.arc');
  const doc = emitOpenapi(mod) as {
    components: { schemas: Record<string, { properties: Record<string, { default?: unknown }> }> };
  };
  return doc.components.schemas.Event.properties.at.default;
}

test('a digit past the millisecond that is a zero is cut, not refused', () => {
  const source = spec('"2026-01-01T00:00:00.1230Z"');
  assert.deepEqual(errorsOf(source), []);
  assert.equal(publishedDefault(source), '2026-01-01T00:00:00.123Z');
});

test('a digit past the millisecond that is not a zero is refused', () => {
  const source = spec('"2026-01-01T00:00:00.1234Z"');
  const errors = errorsOf(source);
  assert.equal(errors.length, 1, 'one error for the default');
  assert.equal(errors[0].code, 'A059');
  assert.match(errors[0].message, /finer than a millisecond/);
});

test('a trigger keeps the instant verbatim, fractions included', () => {
  const source = `module m @0.1.0 {
}

type Item = { id: uuid }

service Items : http {
  contract {
    public op list() -> { items: list<Item> } {
      route: "GET /v1/items"
    }
  }
}

workflow Once {
  trigger at("2026-11-18T12:00:05.123456Z")
  step touch() {
    call: Items.list
  }
}

environment dev {
  deploy docker
}
`;
  assert.deepEqual(errorsOf(source), []);
  const manifest = deployManifest(parse(source, 'default.arc'), parse(source, 'default.arc').environments[0]) as {
    workflows: Array<{ trigger: { at: string | null } }>;
  };
  assert.equal(manifest.workflows[0].trigger.at, '2026-11-18T12:00:05.123456Z');
});
