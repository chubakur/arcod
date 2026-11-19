import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQL_STORE_SOURCE } from '../src/emit/sql-store.ts';

// The generated MySQL store writes a DATETIME literal itself. MySQL has no
// zone in that literal, so the codec must convert an offset to UTC rather than
// strip it: '2026-01-01T02:00:00+02:00' and '2026-01-01T00:00:00Z' are the same
// moment, and only one of them is a legal MySQL literal.
function emittedNormalize(): (value: unknown) => string {
  const start = SQL_STORE_SOURCE.indexOf('function normalizeDateTime');
  const end = SQL_STORE_SOURCE.indexOf('function isoDateTime');
  assert.ok(start >= 0 && end > start, 'the generated store carries the datetime codec');
  return new Function(SQL_STORE_SOURCE.slice(start, end) + '\nreturn normalizeDateTime;')() as (value: unknown) => string;
}

test('the generated codec writes a zoned instant as UTC', () => {
  const normalize = emittedNormalize();
  assert.equal(normalize('2026-01-01T00:00:00Z'), '2026-01-01 00:00:00');
  assert.equal(normalize('2026-01-01T02:00:00+02:00'), '2026-01-01 00:00:00', 'the offset is converted, not dropped');
  assert.equal(normalize('2025-12-31T19:00:00-05:00'), '2026-01-01 00:00:00');
  assert.equal(normalize('2026-01-01T00:00:00.500Z'), '2026-01-01 00:00:00.500', 'milliseconds survive DATETIME(3)');
});

test('the generated codec leaves a naive value alone apart from the separator', () => {
  const normalize = emittedNormalize();
  assert.equal(normalize('2026-01-01T12:34:56'), '2026-01-01 12:34:56');
  assert.equal(normalize('2026-01-01 12:34:56'), '2026-01-01 12:34:56');
});
