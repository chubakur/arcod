import type { BindNode, DeployNode, EnvironmentNode, Expr, ModuleNode, TriggerNode } from './ast.ts';
import { providerFor } from './providers.ts';

// Deployment providers are separate from capability providers. A capability
// provider says what a service talks to (redis, postgres); a deployment provider
// says where the service itself runs (docker, aws, yandex cloud).
export type DeployKind = 'local' | 'cloud';

export interface DeploySpec {
  name: string;
  kind: DeployKind;
  summary: string;
  artifacts: 'compose' | 'manifest' | 'k8s' | 'helm';
  args: Record<string, string>;
}

export const DEPLOY_PROVIDERS: Record<string, DeploySpec> = {
  docker: {
    name: 'docker',
    kind: 'local',
    summary: 'local docker compose on this machine',
    artifacts: 'compose',
    args: {
      context: 'build directory (default: .arcod/build)',
    },
  },
  aws: {
    name: 'aws',
    kind: 'cloud',
    summary: 'Amazon Web Services (abstraction: manifest only, no API calls)',
    artifacts: 'manifest',
    args: {
      region: 'region, e.g. eu-west-1',
      cluster: 'cluster or service',
      service: 'cloud service name',
      image: 'image to be pushed (wins over registry/repository/tag)',
      registry: 'container registry; omit for docker hub',
      repository: 'image repository (default: arcod/<module>-<service>)',
      tag: 'image tag (default: spec version)',
    },
  },
  yandex: {
    name: 'yandex',
    kind: 'cloud',
    summary: 'Yandex Cloud (abstraction: manifest only, no API calls)',
    artifacts: 'manifest',
    args: {
      folder: 'cloud folder',
      region: 'region, e.g. ru-central1',
      cluster: 'cluster or service',
      service: 'cloud service name',
      image: 'image to be pushed (wins over registry/repository/tag)',
      registry: 'container registry; omit for docker hub',
      repository: 'image repository (default: arcod/<module>-<service>)',
      tag: 'image tag (default: spec version)',
    },
  },
  kubernetes: {
    name: 'kubernetes',
    kind: 'cloud',
    summary: 'Kubernetes manifests: Deployment, Service, ConfigMap, Ingress (no API calls)',
    artifacts: 'k8s',
    args: {
      image: 'container image for the service',
      registry: 'container registry; omit for docker hub',
      repository: 'image repository (default: arcod/<module>-<service>)',
      tag: 'image tag (default: spec version)',
      namespace: 'namespace (default: arcod-<module>)',
      replicas: 'replica count (default: 1)',
      host: 'ingress host; omit to skip the Ingress',
      ingressClass: 'ingress class (default: nginx)',
    },
  },
  helm: {
    name: 'helm',
    kind: 'cloud',
    summary: 'a Helm chart wrapping the same Kubernetes objects (no API calls)',
    artifacts: 'helm',
    args: {
      image: 'container image for the service',
      registry: 'container registry; omit for docker hub',
      repository: 'image repository (default: arcod/<module>-<service>)',
      tag: 'image tag (default: spec version)',
      namespace: 'namespace (default: release namespace)',
      replicas: 'default replica count',
      host: 'ingress host; sets ingress.enabled',
      ingressClass: 'ingress class (default: nginx)',
    },
  },
};

export function deployProvider(name: string): DeploySpec | null {
  // hasOwn first: an unknown name like `toString` would otherwise answer a
  // prototype member, which every caller reads as a real provider.
  return Object.hasOwn(DEPLOY_PROVIDERS, name) ? DEPLOY_PROVIDERS[name] : null;
}

export function deployNames(): string[] {
  return Object.keys(DEPLOY_PROVIDERS).sort();
}

// A container image name is a contract between the build and every runner:
// the mesh, the manifests, the CI job. Derive it once, from the spec version,
// and publish it in the deploy manifest instead of letting each emitter invent
// its own default.
export interface ImageContract {
  registry: string;
  repository: string;
  tag: string;
  image: string;
}

// Docker tags allow [A-Za-z0-9_.-]; semver build metadata (0.1.0+build.7)
// does not, so the same version has one legal spelling.
function tagOf(version: string): string {
  return version.replace(/[^A-Za-z0-9_.-]/g, '-');
}

function splitImage(image: string): { registry: string; repository: string; tag: string } {
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  const hasTag = colon > slash;
  const repository = hasTag ? image.slice(0, colon) : image;
  const tag = hasTag ? image.slice(colon + 1) : 'latest';
  const slash2 = repository.indexOf('/');
  // A first segment with a dot or a port is a registry, not a namespace.
  const first = slash2 > 0 ? repository.slice(0, slash2) : '';
  const registry = first.includes('.') || first.includes(':') ? first : '';
  const path = registry ? repository.slice(registry.length + 1) : repository;
  return { registry, repository: path, tag };
}

export function imageContract(mod: ModuleNode, env: EnvironmentNode, service: string): ImageContract {
  const args = env.deploy ? literalMap(env.deploy.args) : {};
  const tag = tagOf(args.tag ?? mod.version);
  if (args.image) {
    // An explicit image wins verbatim; the contract only splits it into parts.
    const split = splitImage(args.image);
    return { registry: split.registry, repository: split.repository, tag: split.tag, image: args.image };
  }
  const registry = args.registry ?? '';
  const repository = args.repository ?? 'arcod/' + mod.name + '-' + service;
  return { registry, repository, tag, image: (registry ? registry + '/' : '') + repository + ':' + tag };
}

export function literalMap(args: Record<string, Expr>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, expr] of Object.entries(args)) {
    out[key] = expr.kind === 'literal' ? String(expr.value) : '<expr>';
  }
  return out;
}

function bindMap(bind: BindNode): Record<string, string> {
  return literalMap(bind.args);
}

// What would be deployed: the same module, a different target. Cloud providers
// stop at a manifest on purpose — no credentials, no API calls, no surprises.
export function deployManifest(mod: ModuleNode, env: EnvironmentNode): Record<string, unknown> {
  const deploy = env.deploy;
  if (!deploy) throw new Error('environment ' + env.name + ' declares no deploy target');
  const spec = deployProvider(deploy.provider);
  if (!spec) throw new Error('unknown deploy provider ' + deploy.provider);
  const args = literalMap(deploy.args);

  return {
    module: mod.name,
    version: mod.version,
    environment: env.name,
    target: {
      provider: spec.name,
      kind: spec.kind,
      summary: spec.summary,
      args,
    },
    services: mod.services
      .filter((svc) => !svc.external)
      .map((svc) => {
        const contract = imageContract(mod, env, svc.name);
        return {
          name: svc.name,
          kind: svc.impl,
          image: contract.image,
          registry: contract.registry,
          repository: contract.repository,
          tag: contract.tag,
        };
      }),
    // One record per image for a CI job: build these and push nothing without
    // the owner's decision (B7 stays declarative).
    images: Object.fromEntries(
      mod.services
        .filter((svc) => !svc.external)
        .map((svc) => [svc.name, imageContract(mod, env, svc.name)]),
    ),
    // Graphs travel with the manifest: a runner elsewhere can read them
    // without re-parsing the spec.
    workflows: mod.workflows.map((wf) => ({
      name: wf.name,
      trigger: wf.trigger ? triggerManifest(wf.trigger) : null,
      overlap: wf.overlap,
      catchup: wf.catchup,
      retry: wf.retry,
      steps: wf.steps.map((step) => ({
        name: step.name,
        call: step.call,
        needs: step.needs,
        effects: step.effects,
        onFail: step.onFail,
        retry: step.retry,
        returns: step.returns && step.returns.kind === 'named' ? step.returns.name : null,
      })),
      executed: false,
    })),
    providers: env.binds.map((bind) => ({
      alias: bind.alias,
      provider: bind.provider,
      args: bindMap(bind),
    })),
    executed: false,
  };
}

export function formatDeploy(mod: ModuleNode, env: EnvironmentNode): string {
  const deploy = env.deploy;
  if (!deploy) return env.name + ': deploy is not declared';
  const spec = deployProvider(deploy.provider);
  const where = spec ? spec.summary : 'unknown provider';
  const args = literalMap(deploy.args);
  const tail = Object.entries(args).map(([key, value]) => key + '=' + value).join(' ');
  return env.name + ': ' + deploy.provider + ' — ' + where + (tail ? ' · ' + tail : '');
}

// A trigger travels as data so a runner outside this repo can schedule it
// without re-parsing the spec. at/afterSeconds are the two forms the v0.1
// language defines; args keeps the source text for diagnostics.
const TRIGGER_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function triggerManifest(trigger: TriggerNode): {
  kind: string;
  at: string | null;
  afterSeconds: number | null;
  args: Array<{ name: string | null; value: string }>;
} {
  const first = trigger.args.length === 1 ? trigger.args[0].value : null;
  const at = trigger.kind === 'at' && first?.kind === 'literal' && typeof first.value === 'string'
    ? first.value
    : null;
  const afterSeconds = trigger.kind === 'after' && first?.kind === 'duration'
    ? (first.value * (TRIGGER_UNIT_MS[first.unit] ?? 1000)) / 1000
    : null;
  return {
    kind: trigger.kind,
    at,
    afterSeconds,
    args: trigger.args.map((arg) => ({
      name: arg.name ?? null,
      value: arg.value.kind === 'literal'
        ? String(arg.value.value)
        : arg.value.kind === 'duration'
          ? arg.value.value + arg.value.unit
          : arg.value.kind === 'ident'
            ? arg.value.name
            : '<expr>',
    })),
  };
}
