import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { entitiesFromBodies, migrationPlan } from '../src/migrate.ts';
import { MYSQL, POSTGRES } from '../src/dialects.ts';

// A response shape is not a table. The bodies are what says which record type
// a store call targets, so a DTO returned by an operation that inserts
// something else must not get a table of its own (issue #27).
const spec = `
module lake @0.1.0 {}

use capability arcod.std.sql @1
use capability arcod.std.ids @1

type Sample = { id: uuid, value: float, at: datetime }
type AlertAck = { ok: bool, id: string }

service Lake : http {
  uses store: sql
  uses uuid: ids

  effects {
    allow store.insert, store.find, uuid.new
  }

  contract {
    public op record(value: float) -> AlertAck {
      route: "POST /v1/samples"
      effects: store.insert, uuid.new
    }

    public op create(value: float) -> Sample {
      route: "POST /v1/samples/direct"
      effects: store.insert, uuid.new
    }

    public op read() -> Sample {
      route: "GET /v1/sample"
      effects: store.find
    }
  }
}

environment dev {
  bind store -> mysql
  bind uuid -> local
  deploy docker
}
`;

const bodies = {
  record: "export async function record(input, io) { await io.insert('Sample', { id: await io.new(), value: input.value }); return { result: { ok: true, id: 'x' } }; }",
  create: "export async function create(input, io) { return { result: io.insert('Sample', { id: await io.new(), value: input.value }) }; }",
  read: "export async function read(input, io) { const page = await io.find('Sample', { limit: 1 }); return { result: page.items[0] ?? null }; }",
};

test('a DTO returned by an operation is not a table', () => {
  const mod = parse(spec, 'main.arc');
  const svc = mod.services[0];
  const plan = migrationPlan(mod, svc, { entities: entitiesFromBodies(bodies) });
  const names = plan.migrations.map((m) => m.name);
  assert.ok(names.includes('sample'), 'the stored entity gets a table');
  assert.ok(!names.includes('alertack'), 'the DTO does not');
  assert.match(plan.migrations.find((m) => m.name === 'sample')!.up, /CREATE TABLE IF NOT EXISTS `sample`/);
});

test('without bodies the old behaviour is kept and documented', () => {
  const mod = parse(spec, 'main.arc');
  const plan = migrationPlan(mod, mod.services[0], { entities: entitiesFromBodies(undefined) });
  const names = plan.migrations.map((m) => m.name);
  assert.ok(names.includes('sample') && names.includes('alertack'), 'a scaffold plan cannot tell a DTO from an entity');
});

test('a string key is bounded, never a TEXT primary key', () => {
  const stringKey = `
module keys @0.1.0 {}

use capability arcod.std.sql @1

type Receipt = { id: string, note: string }

service Keys : http {
  uses store: sql
  effects { allow store.insert, store.find }
  contract {
    public op create(id: string, note: string) -> Receipt {
      route: "POST /v1/r"
      effects: store.insert
    }
    public op read() -> Receipt {
      route: "GET /v1/r"
      effects: store.find
    }
  }
}

environment dev {
  bind store -> mysql
  deploy docker
}
`;
  const mod = parse(stringKey, 'main.arc');
  const entities = ["Receipt"];
  const mysql = migrationPlan(mod, mod.services[0], { entities, dialect: MYSQL }).migrations.find((m) => m.name === 'receipt')!;
  assert.match(mysql.up, /`id` VARCHAR\(191\) NOT NULL/, 'a keyed string has a length');
  assert.match(mysql.up, /PRIMARY KEY \(`id`\)/);
  assert.doesNotMatch(mysql.up, /`id` TEXT/);

  const pg = migrationPlan(mod, mod.services[0], { entities, dialect: POSTGRES }).migrations.find((m) => m.name === 'receipt')!;
  assert.match(pg.up, /"id" VARCHAR\(191\) NOT NULL/);
});
