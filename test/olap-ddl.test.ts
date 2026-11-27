// B95.2: ClickHouse DDL is the compiler's job, not the body's. These tests pin
// the type table and the two statements the migrate step sends; the adapter
// (B95.3) is what carries them over HTTP, so a wrong CREATE TABLE would be
// discovered on a running server instead of here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { clickhouseType, olapColumns, createTableSql, insertSql, readOnlySql } from '../src/emit/olap.ts';

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

test('an optional column is Nullable, and a named type resolves', () => {
  const decl = parse('module demo @0.1.0 {}\ntype Id = uuid\ntype Row = { id: Id, note: string? }\n', 'main.arc');
  const names = new Map(decl.types.map((item) => [item.name, item.type]));
  const row = decl.types.find((item) => item.name === 'Row')!.type;
  const { columns } = olapColumns(row.kind === 'record' ? row.fields : [], names);
  assert.deepEqual(columns.map((column) => column.type), ['String', 'Nullable(String)']);
});
