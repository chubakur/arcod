// B95.2: ClickHouse DDL is the compiler's job, not the body's. These tests pin
// the type table and the two statements the migrate step sends; the adapter
// (B95.3) is what carries them over HTTP, so a wrong CREATE TABLE would be
// discovered on a running server instead of here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { clickhouseType, olapColumns, createTableSql, insertSql, readOnlySql, selectSql } from '../src/emit/olap.ts';

const mod = parse([
  'module demo @0.1.0 {',
  '}',
  '',
  'type DeliveryEvent = {',
  '  id: uuid,',
  '  campaignId: uuid,',
  '  day: string,',
  '  sent: int,',
  '  failed: int,',
  '  at: datetime,',
  '  tags: list<string>,',
  '}',
  '',
].join('\n'), 'main.arc');

const record = mod.types[0].type;
const named = new Map(mod.types.map((decl) => [decl.name, decl.type]));

test('the scalar table matches the ClickHouse column types', () => {
  const fields = record.kind === 'record' ? record.fields : [];
  const { columns, problems } = olapColumns(fields, named);
  assert.deepEqual(problems, []);
  assert.deepEqual(columns.map((column) => column.name + ' ' + column.type), [
    'id String',
    'campaignId String',
    'day String',
    'sent Int64',
    'failed Int64',
    'at DateTime64(3)',
    'tags Array(String)',
  ]);
});

test('an unrepresentable column is named, not guessed to String', () => {
  const unknown = parse('module demo @0.1.0 {}\ntype Row = { when: wheneer }\n', 'main.arc');
  const decl = unknown.types[0].type;
  assert.equal(decl.kind, 'record');
  const { columns, problems } = olapColumns(decl.kind === 'record' ? decl.fields : [], new Map());
  assert.deepEqual(columns, []);
  assert.deepEqual(problems, ['column when has no ClickHouse type']);
});

test('CREATE TABLE carries the sorting key the capability declared', () => {
  const sql = createTableSql({
    name: 'DeliveryEvent',
    columns: [{ name: 'id', type: 'String' }, { name: 'at', type: 'DateTime64(3)' }],
    orderBy: ['at', 'id'],
    ttl: 'at',
  });
  assert.equal(sql, [
    'CREATE TABLE IF NOT EXISTS "DeliveryEvent" ("id" String, "at" DateTime64(3), TTL toDateTime("at"))',
    'ENGINE = MergeTree',
    'ORDER BY ("at", "id")',
  ].join('\n'));
});

test('a table without orderBy falls back to tuple(), never to an error', () => {
  const sql = createTableSql({ name: 'Row', columns: [{ name: 'id', type: 'String' }], orderBy: [] });
  assert.match(sql, /ORDER BY \(tuple\(\)\)$/);
});

test('an append is JSONEachRow', () => {
  assert.equal(insertSql('DeliveryEvent'), 'INSERT INTO "DeliveryEvent" FORMAT JSONEachRow');
});

test('the raw escape hatch takes one read-only statement', () => {
  assert.equal(readOnlySql('SELECT day, sum(sent) FROM events GROUP BY day'), true);
  assert.equal(readOnlySql('  with x as (select 1) select * from x;'), true);
  assert.equal(readOnlySql('DROP TABLE events'), false);
  assert.equal(readOnlySql('SELECT 1; DROP TABLE events'), false);
  assert.equal(readOnlySql('SELECT 1; -- then'), false);
  assert.equal(readOnlySql(''), false);
});

const EVENTS = [
  { name: 'day', type: 'String' },
  { name: 'sent', type: 'Int64' },
  { name: 'failed', type: 'Int64' },
  { name: 'at', type: 'DateTime64(3)' },
];

test('a typed select groups by the declared columns and names the metrics', () => {
  const { sql, params } = selectSql('DeliveryEvent', EVENTS, {
    groupBy: ['day'],
    metrics: [
      { name: 'sent', op: 'sum', field: 'sent' },
      { name: 'failed', op: 'sum', field: 'failed' },
    ],
    order: 'day desc',
    limit: 90,
  });
  assert.equal(sql, [
    'SELECT "day", sum("sent") AS "sent", sum("failed") AS "failed"',
    'FROM "DeliveryEvent"',
    'GROUP BY "day"',
    'ORDER BY "day" DESC',
    'LIMIT 90',
    'FORMAT JSON',
  ].join('\n'));
  assert.deepEqual(params, {});
});

test('a filter value is a parameter, never a piece of SQL', () => {
  const { sql, params } = selectSql('DeliveryEvent', EVENTS, {
    where: { day: '2026-01-01\' OR 1=1', sent: { gte: 3 } },
    limit: 1,
  });
  assert.match(sql, /"day" = \{p1:String\}/);
  assert.match(sql, /"sent" >= \{p2:Int64\}/);
  assert.equal(params.p1, '2026-01-01\' OR 1=1');
  assert.equal(params.p2, '3');
  assert.doesNotMatch(sql, /OR 1=1/);
});

test('count distinct rides on a column so a retry does not inflate it', () => {
  const { sql } = selectSql('DeliveryEvent', EVENTS, {
    metrics: [{ name: 'events', op: 'count', field: 'day', distinct: true }],
  });
  assert.equal(sql.split('\n')[0], 'SELECT count(DISTINCT "day") AS "events"');
});

test('an unknown column, metric or operator is refused by name', () => {
  assert.throws(() => selectSql('DeliveryEvent', EVENTS, { groupBy: ['week'] }), /unknown column week; declared: day, sent, failed, at/);
  assert.throws(() => selectSql('DeliveryEvent', EVENTS, { where: { sent: { like: 1 } } }), /unknown operator like/);
  assert.throws(() => selectSql('DeliveryEvent', EVENTS, { metrics: [{ name: 'x', op: 'median', field: 'sent' }] }), /unknown metric median/);
  assert.throws(() => selectSql('DeliveryEvent', EVENTS, { limit: 0 }), /limit must be a positive whole number/);
});

test('an empty in-list matches nothing instead of everything', () => {
  const { sql } = selectSql('DeliveryEvent', EVENTS, { where: { day: { in: [] } } });
  assert.match(sql, /WHERE 0/);
});

test('contains is a position, not a LIKE with user text in the pattern', () => {
  const { sql, params } = selectSql('DeliveryEvent', EVENTS, { where: { day: { contains: '%' } } });
  assert.match(sql, /position\("day", \{p1:String\}\) > 0/);
  assert.equal(params.p1, '%');
});

test('an optional column is Nullable, and a named type resolves', () => {
  const decl = parse('module demo @0.1.0 {}\ntype Id = uuid\ntype Row = { id: Id, note: string? }\n', 'main.arc');
  const names = new Map(decl.types.map((item) => [item.name, item.type]));
  const row = decl.types.find((item) => item.name === 'Row')!.type;
  const { columns } = olapColumns(row.kind === 'record' ? row.fields : [], names);
  assert.deepEqual(columns.map((column) => column.type), ['String', 'Nullable(String)']);
});
