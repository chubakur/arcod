// Plugin manifests: a package can declare capabilities and providers without
// forking the compiler (see docs/plugin-registry.md). This module is step 1 of
// that RFC: read and validate manifests, report them. Nothing here executes
// plugin code or changes resolution yet — `arcod providers --plugins` is a
// read-only view, which is exactly what an operator needs before trusting a
// package.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROVIDERS } from './providers.ts';

export const PLUGIN_API = 1;

export interface PluginCapability {
  name: string;
  summary?: string;
  effects?: string[];
  signatures?: string[];
}

export interface PluginProvider {
  name: string;
  capability: string;
  summary?: string;
  args?: Record<string, string>;
  secrets?: string[];
  appEnv?: Record<string, string>;
  runtime?: { adapter: string; export?: string };
}

export interface PluginManifest {
  package: string;
  version: string;
  // The manifest file (what `providers --plugins` prints) and the package
  // directory it lives in (what runtime.adapter is relative to). They differ;
  // conflating them made the adapter path point inside the JSON file.
  path: string;
  dir: string;
  pluginApi: number;
  capabilities: PluginCapability[];
  providers: PluginProvider[];
}

export interface PluginIssue {
  path: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface PluginScan {
  plugins: PluginManifest[];
  issues: PluginIssue[];
}

const NAME = /^[a-z][a-z0-9_-]*$/;

// Search order is fixed and documented: env, project, home. No network, no
// installation: a plugin exists if its manifest is on that path.
export function pluginRoots(cwd: string): string[] {
  const roots: string[] = [];
  const env = process.env.ARC_PLUGIN_PATH;
  if (env) {
    for (const part of env.split(':')) if (part.length > 0) roots.push(part);
  }
  roots.push(join(cwd, '.arcod', 'plugins'));
  roots.push(join(homedir(), '.arcod', 'plugins'));
  return roots;
}

interface RawShape {
  name?: unknown;
  version?: unknown;
  arcod?: {
    pluginApi?: unknown;
    capabilities?: unknown;
    providers?: unknown;
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseManifest(path: string, raw: RawShape): { manifest: PluginManifest | null; issues: PluginIssue[] } {
  const issues: PluginIssue[] = [];
  const arcod = raw.arcod;
  if (!arcod || typeof arcod !== 'object') {
    return { manifest: null, issues: [{ path, severity: 'error', message: 'manifest has no "arcod" block' }] };
  }
  const api = arcod.pluginApi;
  if (typeof api !== 'number' || !Number.isInteger(api)) {
    return { manifest: null, issues: [{ path, severity: 'error', message: 'pluginApi must be an integer' }] };
  }
  if (api !== PLUGIN_API) {
    // A future API is not an error in this installation: the plugin is
    // ignored, and the operator sees why.
    return {
      manifest: null,
      issues: [{ path, severity: 'warning', message: 'pluginApi ' + api + ' is not supported (this arcod speaks ' + PLUGIN_API + '); plugin ignored' }],
    };
  }
  const capabilities: PluginCapability[] = [];
  for (const item of asArray(arcod.capabilities)) {
    const entry = item as PluginCapability;
    if (!entry || typeof entry.name !== 'string' || !NAME.test(entry.name)) {
      issues.push({ path, severity: 'error', message: 'capability name ' + JSON.stringify(entry?.name) + ' is not [a-z][a-z0-9_-]*' });
      continue;
    }
    capabilities.push({
      name: entry.name,
      summary: typeof entry.summary === 'string' ? entry.summary : undefined,
      effects: asArray(entry.effects).filter((value): value is string => typeof value === 'string'),
      signatures: asArray(entry.signatures).filter((value): value is string => typeof value === 'string'),
    });
  }
  const providers: PluginProvider[] = [];
  for (const item of asArray(arcod.providers)) {
    const entry = item as PluginProvider;
    if (!entry || typeof entry.name !== 'string' || !NAME.test(entry.name)) {
      issues.push({ path, severity: 'error', message: 'provider name ' + JSON.stringify(entry?.name) + ' is not [a-z][a-z0-9_-]*' });
      continue;
    }
    if (typeof entry.capability !== 'string' || !NAME.test(entry.capability)) {
      issues.push({ path, severity: 'error', message: 'provider ' + entry.name + ' names no capability' });
      continue;
    }
    const runtime = entry.runtime;
    if (runtime && (typeof runtime.adapter !== 'string' || runtime.adapter.includes('..') || runtime.adapter.startsWith('/'))) {
      issues.push({ path, severity: 'error', message: 'provider ' + entry.name + ' has a runtime.adapter outside its package' });
      continue;
    }
    providers.push({
      name: entry.name,
      capability: entry.capability,
      summary: typeof entry.summary === 'string' ? entry.summary : undefined,
      args: entry.args && typeof entry.args === 'object' ? entry.args : {},
      secrets: asArray(entry.secrets).filter((value): value is string => typeof value === 'string'),
      appEnv: entry.appEnv && typeof entry.appEnv === 'object' ? entry.appEnv : {},
      runtime: runtime && typeof runtime.adapter === 'string' ? { adapter: runtime.adapter, export: runtime.export } : undefined,
    });
  }
  return {
    manifest: {
      package: typeof raw.name === 'string' ? raw.name : path,
      version: typeof raw.version === 'string' ? raw.version : '0.0.0',
      path,
      dir: dirname(path),
      pluginApi: api,
      capabilities,
      providers,
    },
    issues,
  };
}

// A plugin cannot shadow a built-in provider or capability: that would make
// two installations of arcod disagree about what "bind db -> postgres" means.
function checkCollisions(scan: PluginScan): void {
  const seen = new Set(Object.keys(PROVIDERS));
  const capabilities = new Set<string>();
  for (const plugin of scan.plugins) {
    for (const capability of plugin.capabilities) {
      if (capabilities.has(capability.name)) {
        scan.issues.push({ path: plugin.path, severity: 'warning', message: 'capability ' + capability.name + ' is declared by more than one plugin' });
      }
      capabilities.add(capability.name);
    }
    for (const provider of plugin.providers) {
      // Keep the name as declared: a renamed entry would make the listing lie
      // about what the manifest says. The issue is the report.
      if (seen.has(provider.name)) {
        scan.issues.push({ path: plugin.path, severity: 'error', message: 'provider ' + provider.name + ' shadows a built-in or an earlier plugin' });
        continue;
      }
      seen.add(provider.name);
      const declared = plugin.capabilities.some((item) => item.name === provider.capability);
      if (!declared && !BUILTIN_CAPABILITIES.has(provider.capability)) {
        scan.issues.push({ path: plugin.path, severity: 'error', message: 'provider ' + provider.name + ' names capability ' + provider.capability + ', which neither it nor arcod declares' });
      }
    }
  }
}

// Capabilities the compiler itself knows; duplicated from capabilities.ts on
// purpose: this module must not depend on the runtime tables to validate a
// manifest, or a plugin could widen the language by existing.
const BUILTIN_CAPABILITIES = new Set([
  'kv', 'sql', 'blob', 'identity', 'llm', 'queue', 'stream', 'secrets',
  'ids', 'errors', 'email', 'sms', 'payment', 'search', 'document', 'cache',
]);

export function scanPlugins(cwd: string): PluginScan {
  const scan: PluginScan = { plugins: [], issues: [] };
  for (const root of pluginRoots(cwd)) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(root, entry, 'arcod.plugin.json');
      if (!existsSync(path)) continue;
      let raw: RawShape;
      try {
        raw = JSON.parse(readFileSync(path, 'utf8')) as RawShape;
      } catch (error) {
        scan.issues.push({ path, severity: 'error', message: 'manifest is not valid JSON: ' + (error instanceof Error ? error.message : String(error)) });
        continue;
      }
      const parsed = parseManifest(path, raw);
      scan.issues.push(...parsed.issues);
      if (parsed.manifest) scan.plugins.push(parsed.manifest);
    }
  }
  checkCollisions(scan);
  return scan;
}

