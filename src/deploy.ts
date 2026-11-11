import type { BindNode, DeployNode, EnvironmentNode, Expr, ModuleNode } from './ast.ts';
import { providerFor } from './providers.ts';

// Deployment providers are separate from capability providers. A capability
// provider says what a service talks to (redis, postgres); a deployment provider
// says where the service itself runs (docker, aws, yandex cloud).
export type DeployKind = 'local' | 'cloud';

export interface DeploySpec {
  name: string;
  kind: DeployKind;
  summary: string;
  artifacts: 'compose' | 'manifest';
  args: Record<string, string>;
}

export const DEPLOY_PROVIDERS: Record<string, DeploySpec> = {
  docker: {
    name: 'docker',
    kind: 'local',
    summary: 'локальный docker compose на этой машине',
    artifacts: 'compose',
    args: {
      context: 'каталог сборки (по умолчанию .arcod/build)',
    },
  },
  aws: {
    name: 'aws',
    kind: 'cloud',
    summary: 'Amazon Web Services (абстракция: манифест, без вызовов API)',
    artifacts: 'manifest',
    args: {
      region: 'регион, например eu-west-1',
      cluster: 'кластер или сервис',
      service: 'имя сервиса в облаке',
      image: 'образ, который будет залит',
    },
  },
  yandex: {
    name: 'yandex',
    kind: 'cloud',
    summary: 'Yandex Cloud (абстракция: манифест, без вызовов API)',
    artifacts: 'manifest',
    args: {
      folder: 'каталог в облаке',
      region: 'регион, например ru-central1',
      cluster: 'кластер или сервис',
      service: 'имя сервиса в облаке',
      image: 'образ, который будет залит',
    },
  },
  kubernetes: {
    name: 'kubernetes',
    kind: 'cloud',
    summary: 'кластер Kubernetes (абстракция: манифест, без вызовов API)',
    artifacts: 'manifest',
    args: {
      context: 'контекст kubeconfig',
      namespace: 'namespace',
      image: 'образ, который будет залит',
    },
  },
};

export function deployProvider(name: string): DeploySpec | null {
  return DEPLOY_PROVIDERS[name] ?? null;
}

export function deployNames(): string[] {
  return Object.keys(DEPLOY_PROVIDERS).sort();
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
      .map((svc) => ({
        name: svc.name,
        kind: svc.impl,
        image: args.image ?? 'arcod/' + mod.name + '-' + svc.name + ':' + mod.version,
      })),
    // Graphs travel with the manifest: a runner elsewhere can read them
    // without re-parsing the spec.
    workflows: mod.workflows.map((wf) => ({
      name: wf.name,
      trigger: wf.trigger
        ? {
            kind: wf.trigger.kind,
            args: wf.trigger.args.map((arg) => ({
              name: arg.name ?? null,
              value: arg.value.kind === 'literal' ? String(arg.value.value) : '<expr>',
            })),
          }
        : null,
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
  if (!deploy) return env.name + ': deploy не объявлен';
  const spec = deployProvider(deploy.provider);
  const where = spec ? spec.summary : 'неизвестный провайдер';
  const args = literalMap(deploy.args);
  const tail = Object.entries(args).map(([key, value]) => key + '=' + value).join(' ');
  return env.name + ': ' + deploy.provider + ' — ' + where + (tail ? ' · ' + tail : '');
}
