// Language-version migration engine. The language has one public version today
// (0.1.0); this module is the seam where future version bumps get their rewrite
// rules, so `arcod upgrade` stays a single, tested path.

import { parse } from './parser.ts';

export const LANG_VERSION = '0.1.0';

// Ordered list of supported language versions (oldest first).
export const VERSIONS: string[] = ['0.1.0'];

// Each entry rewrites a spec at `from` into `to`. Applied in sequence when a
// spec must travel more than one version. Empty today: 0.1.0 is the only
// version, so there is nothing to rewrite.
export const MIGRATIONS: Record<string, (source: string) => string> = {};

export function supportedVersions(): string[] {
  return [...VERSIONS];
}

export class VersionError extends Error {}

export function declaredVersion(source: string, file = 'main.arc'): string {
  return parse(source, file).version;
}

export function isKnownVersion(v: string): boolean {
  return VERSIONS.includes(v);
}

export function migrateSpec(source: string, from: string, to: string, file = 'main.arc'): string {
  if (!isKnownVersion(from)) {
    throw new VersionError('unknown language version ' + from + ' (supported: ' + VERSIONS.join(', ') + ')');
  }
  if (!isKnownVersion(to)) {
    throw new VersionError('unknown target version ' + to + ' (supported: ' + VERSIONS.join(', ') + ')');
  }
  let fromIdx = VERSIONS.indexOf(from);
  const toIdx = VERSIONS.indexOf(to);
  if (toIdx < fromIdx) {
    throw new VersionError('downgrade ' + from + ' -> ' + to + ' is not supported');
  }
  let out = source;
  while (fromIdx < toIdx) {
    const step = VERSIONS[fromIdx] + '->' + VERSIONS[fromIdx + 1];
    const migrate = MIGRATIONS[step];
    if (!migrate) {
      throw new VersionError('no migration from ' + VERSIONS[fromIdx] + ' to ' + VERSIONS[fromIdx + 1] + ' (language moved faster than the tool)');
    }
    out = migrate(out);
    fromIdx++;
  }
  return out;
}
