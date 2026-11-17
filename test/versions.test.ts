import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANG_VERSION, MIGRATIONS, VERSIONS, VersionError, assertVersionOrder,
  compareVersions, declaredVersion, isKnownVersion, migrateSpec, supportedVersions,
} from '../src/versions.ts';

// The migration seam is quiet today (one language version), which is exactly
// why its guards need pinning: the next version bump will lean on them.

test('the shipped version list is ascending and holds the current language', () => {
  assert.doesNotThrow(() => assertVersionOrder());
  assert.ok(VERSIONS.includes(LANG_VERSION));
  assert.equal(new Set(VERSIONS).size, VERSIONS.length, 'no duplicates');
});

test('supportedVersions hands out a copy', () => {
  const list = supportedVersions();
  assert.deepEqual(list, VERSIONS);
  list.push('9.9.9');
  assert.equal(VERSIONS.includes('9.9.9'), false, 'mutating the answer cannot rewrite the table');
});

test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0, 'missing segments count as zero');
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});

test('declaredVersion reads the header and isKnownVersion is a membership test', () => {
  const source = 'module demo @0.1.0 {\n  meta { owner: "@you" }\n}\n';
  assert.equal(declaredVersion(source, 'main.arc'), '0.1.0');
  assert.equal(isKnownVersion(LANG_VERSION), true);
  assert.equal(isKnownVersion('1.0.0'), false);
});

test('migrateSpec refuses what it cannot do instead of guessing', () => {
  const source = 'module demo @0.1.0 {\n  meta { owner: "@you" }\n}\n';
  assert.equal(migrateSpec(source, '0.1.0', '0.1.0'), source, 'same version is a no-op');

  // A downgrade needs two known versions; with one version the unknown-source
  // guard answers first, which is the same refusal from the caller's side.
  assert.throws(() => migrateSpec(source, '0.0.1', '0.1.0'), VersionError);
  assert.throws(() => migrateSpec(source, '0.1.0', '9.9.9'), /unknown target version 9\.9\.9/);
  assert.throws(() => migrateSpec(source, '9.9.9', '0.1.0'), /unknown language version 9\.9\.9/);
  assert.throws(() => migrateSpec(source, '0.1.0', '9.9.9'), /supported: 0\.1\.0/);
});

test('the chain is empty today and an identity migration still round-trips', () => {
  // VERSIONS is fixed at 0.1.0 today; the loop guard is what will catch a
  // version added without its rewrite rule.
  assert.deepEqual(Object.keys(MIGRATIONS), [], '0.1.0 needs no migrations yet');
  const source = 'module demo @0.1.0 {\n  meta { owner: "@you" }\n}\n';
  assert.equal(migrateSpec(source, LANG_VERSION, LANG_VERSION), source);
});
