// The provider lookup: built-in tables (providers.ts) plus one fallback layer
// that reads plugin manifests (docs/plugin-registry.md, step 2). check() and
// the emitters take a registry instead of reaching into PROVIDERS directly, so
// a provider declared by a plugin is as real as a built-in one — and check can
// still prove it implements the capability.
import { PROVIDERS, providerImplements, type ProviderSpec } from './providers.ts';
import { scanPlugins, type PluginProvider, type PluginScan } from './plugins.ts';

export interface ProviderRegistry {
  specs: Record<string, ProviderSpec>;
  // Provider name -> package that declared it; empty for built-ins.
  origin: Record<string, string>;
  // Capabilities a plugin declares that the compiler does not know.
  extraCapabilities: string[];
  get(name: string): ProviderSpec | null;
  names(): string[];
  forCapability(capability: string): string[];
}

function shortCapability(capability: string): string {
  return capability.includes('.') ? capability.split('.').pop()! : capability;
}

function makeRegistry(specs: Record<string, ProviderSpec>, origin: Record<string, string>, extraCapabilities: string[]): ProviderRegistry {
  return {
    specs,
    origin,
    extraCapabilities,
    get(name) {
      return specs[name] ?? null;
    },
    names() {
      return Object.keys(specs).sort();
    },
    forCapability(capability) {
      const name = shortCapability(capability);
      return Object.values(specs)
        .filter((spec) => providerImplements(spec, name))
        .map((spec) => spec.name)
        .sort();
    },
  };
}

// A plugin provider is configured, never provisioned: arcod does not know its
// image. Its appEnv is data — ${arg} is the bind's argument, ${host}/${port}
// the resolved address — and secrets are secret names, not values.
export function pluginProviderSpec(provider: PluginProvider, args: Record<string, string | number | boolean> = {}): ProviderSpec {
  const declarations = provider.args ?? {};
  return {
    name: provider.name,
    capability: provider.capability,
    external: true,
    requires: Object.keys(declarations),
    secrets: provider.secrets ?? [],
    appEnv: ({ host, port, args: bound }) => {
      const values: Record<string, string> = { host, port: String(port) };
      for (const [key, value] of Object.entries({ ...args, ...bound })) values[key] = String(value);
      const out: Record<string, string> = {};
      for (const [key, template] of Object.entries(provider.appEnv ?? {})) {
        out[key] = String(template).replace(/\$\{([a-z0-9_]+)\}/gi, (_, name: string) => values[name] ?? '');
      }
      return out;
    },
  };
}

export function registryFromScan(scan: PluginScan): ProviderRegistry {
  const specs: Record<string, ProviderSpec> = { ...PROVIDERS };
  const origin: Record<string, string> = {};
  const extraCapabilities: string[] = [];
  for (const plugin of scan.plugins) {
    for (const capability of plugin.capabilities) {
      if (!extraCapabilities.includes(capability.name)) extraCapabilities.push(capability.name);
    }
    for (const provider of plugin.providers) {
      // Collisions are reported by checkCollisions() and leave the built-in in
      // place; the registry never lets a plugin win silently.
      if (specs[provider.name]) continue;
      specs[provider.name] = pluginProviderSpec(provider);
      origin[provider.name] = plugin.package;
    }
  }
  return makeRegistry(specs, origin, extraCapabilities.sort());
}

export function builtinRegistry(): ProviderRegistry {
  return makeRegistry({ ...PROVIDERS }, {}, []);
}

let cached: { cwd: string; registry: ProviderRegistry } | null = null;

// One scan per working directory per process: check runs many times per
// command, the manifests do not change under it.
export function loadRegistry(cwd: string = process.cwd()): ProviderRegistry {
  if (cached && cached.cwd === cwd) return cached.registry;
  const registry = registryFromScan(scanPlugins(cwd));
  cached = { cwd, registry };
  return registry;
}

export function resetRegistryCache(): void {
  cached = null;
}

