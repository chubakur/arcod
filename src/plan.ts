import { createHash } from 'node:crypto';
import type { Expr, ModuleNode, OpNode, ServiceNode } from './ast.ts';

export interface PlanTask {
  id: string;
  title: string;
  kind: 'contract' | 'implement' | 'test' | 'infra';
  service: string;
  op?: string;
  deps: string[];
  files: { create: string[]; modify: string[]; forbid: string[] };
  acceptance: string[];
  budget: { tokens: number | null; time: string | null } | null;
}

export interface Plan {
  plan: 1;
  module: string;
  version: string;
  modelHash: string;
  tasks: PlanTask[];
}

export function buildPlan(mod: ModuleNode): Plan {
  const tasks: PlanTask[] = [];
  let seq = 1;
  const nextId = () => 'T-' + String(seq++).padStart(4, '0');

  for (const svc of [...mod.services].sort((a, b) => a.name.localeCompare(b.name))) {
    if (svc.external) continue;
    const slug = kebab(svc.name);
    const budget = taskBudget(svc);

    const contractId = nextId();
    tasks.push({
      id: contractId,
      title: 'описать контракт ' + svc.name,
      kind: 'contract',
      service: svc.name,
      deps: [],
      files: { create: ['src/' + slug + '/contract.ts'], modify: [], forbid: [] },
      acceptance: ['arcod check', 'arcod ast --check'],
      budget,
    });

    for (const op of svc.contract) {
      if (op.kind === 'job') continue;
      const implId = nextId();
      const siblings = svc.contract
        .filter((item) => item.kind === 'op' && item.name !== op.name)
        .map((item) => 'src/' + slug + '/' + kebab(item.name) + '.ts');
      tasks.push({
        id: implId,
        title: 'реализовать ' + svc.name + '.' + op.name,
        kind: 'implement',
        service: svc.name,
        op: op.name,
        deps: [contractId],
        files: {
          create: ['src/' + slug + '/' + kebab(op.name) + '.ts'],
          modify: ['src/' + slug + '/index.ts'],
          forbid: siblings,
        },
        acceptance: ['arcod test --op ' + svc.name + '.' + op.name, 'arcod check'],
        budget,
      });

      tasks.push({
        id: nextId(),
        title: 'покрыть ' + svc.name + '.' + op.name + ' примерами',
        kind: 'test',
        service: svc.name,
        op: op.name,
        deps: [implId],
        files: { create: ['test/' + slug + '/' + kebab(op.name) + '.test.ts'], modify: [], forbid: [] },
        acceptance: ['arcod test --op ' + svc.name + '.' + op.name],
        budget,
      });
    }

    for (const rule of svc.rules) {
      if (rule.kind !== 'invariant') continue;
      tasks.push({
        id: nextId(),
        title: 'проверка инварианта ' + rule.name,
        kind: 'test',
        service: svc.name,
        deps: tasks.filter((t) => t.kind === 'implement' && t.service === svc.name).map((t) => t.id),
        files: { create: ['test/' + slug + '/rules.test.ts'], modify: [], forbid: [] },
        acceptance: ['arcod test'],
        budget,
      });
    }
  }

  for (const ui of mod.uis) {
    tasks.push({
      id: nextId(),
      title: 'собрать интерфейс ' + ui.name,
      kind: 'infra',
      service: '*',
      deps: tasks.filter((t) => t.kind === 'implement').map((t) => t.id),
      files: { create: ['web/index.html', 'web/nginx.conf'], modify: [], forbid: [] },
      acceptance: ['arcod build', 'arcod run --detach'],
      budget: null,
    });
  }

  // A workflow is a graph, so the plan states the graph explicitly: which steps
  // run, what each one waits for, and what "done" means.
  for (const wf of mod.workflows) {
    tasks.push({
      id: nextId(),
      title: 'собрать workflow ' + wf.name + ' (' + wf.steps.length + ' шаг(ов))',
      kind: 'infra',
      service: '*',
      deps: tasks.filter((t) => t.kind === 'implement').map((t) => t.id),
      files: { create: ['workflows/' + wf.name + '.json'], modify: [], forbid: [] },
      acceptance: [
        'arcod check',
        'граф без циклов, у каждого порта ровно один производитель',
        'deploy.<env>.json содержит шаги и зависимости',
      ],
      budget: null,
    });
  }

  // A deployment target is a property of the environment: the same module is
  // built locally and, separately, packaged for a cloud provider.
  for (const env of mod.environments) {
    const provider = env.deploy ? env.deploy.provider : 'docker';
    if (provider === 'docker') {
      tasks.push({
        id: nextId(),
        title: 'собрать docker-окружение (' + env.name + ')',
        kind: 'infra',
        service: '*',
        deps: tasks.filter((t) => t.kind === 'implement').map((t) => t.id),
        files: { create: ['Dockerfile', 'docker-compose.yml'], modify: [], forbid: [] },
        acceptance: ['arcod run --detach', 'curl -fsS localhost:8080/healthz'],
        budget: null,
      });
    } else {
      tasks.push({
        id: nextId(),
        title: 'упаковать для ' + provider + ' (' + env.name + ')',
        kind: 'infra',
        service: '*',
        deps: tasks.filter((t) => t.kind === 'implement').map((t) => t.id),
        files: { create: ['deploy.' + env.name + '.json'], modify: [], forbid: [] },
        acceptance: ['arcod deploy --env ' + env.name + ' --dry-run', 'манифест описывает сервисы и провайдеров'],
        budget: null,
      });
    }
  }

  return {
    plan: 1,
    module: mod.name,
    version: mod.version,
    modelHash: 'sha256:' + createHash('sha256').update(mod.source).digest('hex'),
    tasks,
  };
}

function taskBudget(svc: ServiceNode): { tokens: number | null; time: string | null } | null {
  const items = svc.budget?.items ?? [];
  const tokens = items.find((item) => item.key === 'tokens');
  const time = items.find((item) => item.key === 'time');

  const tokenValue = tokens && tokens.expr.kind === 'literal' && typeof tokens.expr.value === 'number'
    ? tokens.expr.value
    : null;
  const timeValue = time ? budgetText(time.expr) : null;

  if (tokenValue === null && timeValue === null) return null;
  return { tokens: tokenValue, time: timeValue };
}

function budgetText(expr: Expr): string | null {
  if (expr.kind === 'duration') return expr.value + expr.unit;
  if (expr.kind === 'literal') return String(expr.value);
  return null;
}

export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push('plan ' + plan.module + '@' + plan.version + ' (' + plan.modelHash.slice(0, 19) + ')');
  lines.push('');
  for (const task of plan.tasks) {
    lines.push(task.id + '  ' + task.title);
    lines.push('        kind: ' + task.kind + (task.deps.length ? '   deps: ' + task.deps.join(', ') : ''));
    if (task.files.create.length) lines.push('        create: ' + task.files.create.join(', '));
    if (task.files.modify.length) lines.push('        modify: ' + task.files.modify.join(', '));
    if (task.files.forbid.length) lines.push('        forbid: ' + task.files.forbid.join(', '));
    lines.push('        accept: ' + task.acceptance.join(' && '));
  }
  lines.push('');
  lines.push('tasks: ' + plan.tasks.length);
  return lines.join('\n');
}
