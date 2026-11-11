import type { Diagnostic } from './diagnostics.ts';
import type { Expr, Loc, ModuleNode, OpNode, ServiceNode, UiNode } from './ast.ts';
import { templateFor } from './templates.ts';
import { providerFor, providerNames, providersForCapability } from './providers.ts';
import { storageUse } from './capabilities.ts';
import { deployNames, deployProvider } from './deploy.ts';

const WRITE_OPS = new Set(['set', 'del', 'put', 'push', 'incr', 'decr', 'update', 'write', 'delete']);
const FORBIDDEN_IN_MODEL = ['redis', 'postgres', 'postgresql', 'dynamodb', 'mysql', 'mongodb', 'localhost', '127.0.0.1', 'ollama', 'openai', 'anthropic'];

export interface CheckOptions {
  environment?: string;
  // Budgets are a design decision, not a prerequisite: a draft may not know
  // its latency or cost yet. Strict mode asks for them explicitly.
  strict?: boolean;
}

export function check(mod: ModuleNode, options: CheckOptions = {}): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const env = options.environment
    ? mod.environments.find((e) => e.name === options.environment)
    : mod.environments[0];
  // A028 — unknown deploy provider; W019 — unknown deploy argument.
  // Every environment is checked, not only the selected one.
  for (const environment of mod.environments) {
    const deploy = environment.deploy;
    if (!deploy) continue;
    const spec = deployProvider(deploy.provider);
    if (!spec) {
      diags.push(diag('A028', 'error', mod.file, deploy.loc, 'environments.' + environment.name + '.deploy',
        'unknown deploy provider ' + deploy.provider, 'available: ' + deployNames().join(', ')));
      continue;
    }
    for (const key of Object.keys(deploy.args)) {
      if (!(key in spec.args)) {
        diags.push(diag('W019', 'warning', mod.file, deploy.loc, 'environments.' + environment.name + '.deploy',
          'provider ' + deploy.provider + ' does not know argument ' + key,
          'known: ' + Object.keys(spec.args).join(', ')));
      }
    }
  }

  const bound = new Map<string, string>();
  for (const bind of env?.binds ?? []) bound.set(bind.alias, bind.provider);

  for (const svc of mod.services) {
    if (svc.external) continue;
    const sourceSlice = mod.source.slice(svc.loc.offset, svc.loc.end);
    const aliases = new Set(svc.uses.map((u) => u.alias));

    // A003 — provider, host or secret mentioned in the model
    for (const word of FORBIDDEN_IN_MODEL) {
      if (sourceSlice.toLowerCase().includes(word)) {
        diags.push(diag('A003', 'error', mod.file, svc.loc, 'services', `provider or host ${word} mentioned in the model`, 'move the binding into environment'));
      }
    }

    // A002 — capability is not bound
    for (const use of svc.uses) {
      if (!env) {
        diags.push(diag('A002', 'error', mod.file, use.loc, `services.${svc.name}.uses.${use.alias}`, `capability ${use.capability} is not bound: no environment`, 'add an environment with bind ' + use.alias));
      } else if (!bound.has(use.alias)) {
        diags.push(diag('A002', 'error', mod.file, use.loc, `services.${svc.name}.uses.${use.alias}`, `capability ${use.capability} is not bound in environment ${env.name}`, `add bind ${use.alias} -> <provider>`));
      }
    }

    // A023 — unknown provider; A024 — provider does not implement the capability;
    // A025 — one alias bound more than once
    const boundAliases = new Set<string>();
    for (const bind of env?.binds ?? []) {
      if (bind.provider !== 'local' && boundAliases.has(bind.alias)) {
        diags.push(
          diag('A025', 'error', mod.file, bind.loc, `environments.${env!.name}.binds.${bind.alias}`,
            `alias ${bind.alias} is bound twice`, 'keep a single provider'),
        );
      }
      boundAliases.add(bind.alias);

      if (bind.provider === 'local') continue;
      const use = svc.uses.find((item) => item.alias === bind.alias);
      if (!use) continue;
      const spec = providerFor(bind.provider);
      if (!spec) {
        diags.push(
          diag('A023', 'error', mod.file, bind.loc, `environments.${env!.name}.binds.${bind.alias}`,
            `unknown provider ${bind.provider}`,
            'available: ' + providerNames().join(', ')),
        );
        continue;
      }
      for (const required of spec.requires ?? []) {
        if (!(required in bind.args)) {
          diags.push(
            diag('A026', 'error', mod.file, bind.loc, `environments.${env!.name}.binds.${bind.alias}`,
              `provider ${bind.provider} requires argument ${required}`,
              `add ${required}: "..." to bind`),
          );
        }
      }

      const capability = use.capability.includes('.') ? use.capability.split('.').pop()! : use.capability;
      if (spec.capability !== capability) {
        const alternatives = providersForCapability(capability);
        diags.push(
          diag('A024', 'error', mod.file, bind.loc, `environments.${env!.name}.binds.${bind.alias}`,
            `${bind.provider} does not implement ${use.capability}`,
            alternatives.length > 0 ? `available for ${capability}: ` + alternatives.join(', ') : `${capability} has no providers`),
        );
      }
    }

    // A009 — duplicate alias
    const seen = new Set<string>();
    // An external service is a callable alias without a local capability.
    for (const item of mod.services) if (item.external) seen.add(item.name);
    for (const use of svc.uses) {
      if (seen.has(use.alias)) {
        diags.push(diag('A009', 'error', mod.file, use.loc, `services.${svc.name}.uses`, `alias ${use.alias} is declared twice`));
      }
      seen.add(use.alias);
    }

    // Collect capability calls from every expression in the service
    const uses = collectCapabilityUses(svc, aliases);

    // A022 — once(...) points at an error the operation does not declare
    for (const rule of svc.rules) {
      if (rule.kind !== 'invariant') continue;
      const once = asOnce(rule.expr);
      if (!once || !once.elseName) continue;
      const op = svc.contract.find((item) => item.kind === 'op' && item.name === once.target);
      if (op && !errorNames(op).includes(once.elseName)) {
        diags.push(diag('A022', 'error', mod.file, rule.loc, `services.${svc.name}.rules.${rule.name}`, `once(..., else: ${once.elseName}) refers to an error that is not in the ${once.target} contract`, 'add the error to errors or fix else'));
      }
    }

    // A004 — effect used but not allowed; A021 — explicitly denied
    const checkEffect = (alias: string, op: string, loc: Loc) => {
      if (!svc.effects || !isAllowed(svc.effects.allow, alias, op)) {
        diags.push(diag('A004', 'error', mod.file, loc, `services.${svc.name}.effects`, `effect ${alias}.${op} is not allowed`, `add ${alias}.${op} to allow`));
      }
      if (svc.effects && isDenied(svc.effects.deny, alias, op)) {
        diags.push(diag('A021', 'error', mod.file, loc, `services.${svc.name}.effects`, `effect ${alias}.${op} is denied`, `remove ${alias}.${op} from deny or from the code`));
      }
    };

    for (const use of uses) checkEffect(use.alias, use.op, use.loc);

    // A027 — an operation names an effect whose alias it never declared.
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      for (const clause of op.clauses) {
        if (clause.kind !== 'effects') continue;
        for (const entry of clause.names) {
          const [alias, name] = entry.split('.');
          if (!seen.has(alias)) {
            diags.push(diag('A027', 'error', mod.file, clause.loc, `services.${svc.name}.ops.${op.name}.effects`,
              'alias ' + alias + ' is not declared in uses', 'add uses ' + alias + ': …'));
            continue;
          }
          checkEffect(alias, name, clause.loc);
        }
      }
    }

    // Effects implied by generated operation semantics (v0.1 convention)
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      for (const effect of requiredEffects(svc, op)) {
        checkEffect(effect.alias, effect.op, op.loc);
      }
    }

    // A020 — an effect is both allowed and denied
    if (svc.effects) {
      for (const item of svc.effects.allow) {
        if (svc.effects.deny.includes(item)) {
          diags.push(diag('A020', 'error', mod.file, svc.effects.loc, `services.${svc.name}.effects`, `effect ${item} is both in allow and deny`, 'deny wins, remove it from allow'));
        }
      }
    }

    // W016 — deny entries the compiler cannot enforce in v0.1
    if (svc.effects) {
      const unenforceable = svc.effects.deny.filter((item) => !item.includes('.'));
      if (unenforceable.length > 0) {
        diags.push(diag('W016', 'warning', mod.file, svc.effects.loc, `services.${svc.name}.effects.deny`, 'deny is not enforced in v0.1: ' + unenforceable.join(', '), 'restrict access at the environment level'));
      }
    }

    // A005 — write call inside an invariant
    for (const rule of svc.rules) {
      if (rule.kind !== 'invariant') continue;
      walkExpr(rule.expr, (expr) => {
        if (expr.kind !== 'call') return;
        const call = asCapabilityCall(expr, aliases);
        if (call && WRITE_OPS.has(call.op)) {
          diags.push(diag('A005', 'error', mod.file, expr.loc, `services.${svc.name}.rules.${rule.name}`, `write call ${call.alias}.${call.op} in an invariant`, 'invariants describe observations, not changes'));
        }
      });
    }

    // W011 — declared capability never used. An effect allow-list entry is
    // also a declaration of use: it names the effects the model expects.
    const usedAliases = new Set(uses.map((u) => u.alias));
    const allowedAliases = new Set(
      (svc.effects?.allow ?? []).map((entry) => entry.split('.')[0]).filter(Boolean),
    );
    for (const use of svc.uses) {
      if (!usedAliases.has(use.alias) && !allowedAliases.has(use.alias) && !mentionsBareAlias(svc, use.alias)) {
        diags.push(diag('W011', 'warning', mod.file, use.loc, `services.${svc.name}.uses.${use.alias}`, `capability ${use.capability} is declared but not used`));
      }
    }

    // A007 — declared error is neither handled nor asserted
    const asserted = collectAssertedErrors(svc);
    const handled = collectHandledErrors(svc);
    for (const op of svc.contract) {
      if (op.kind === 'job') continue;
      for (const errorName of errorNames(op)) {
        if (!asserted.has(errorName) && !handled.has(errorName)) {
          diags.push(diag('A007', 'error', mod.file, op.loc, `services.${svc.name}.contract.${op.name}.errors`, `error ${errorName} is declared but not handled`, `add on error ${errorName} or an example with ${errorName}`));
        }
      }
    }

    // W018 — the spec has no body, so one has to come from outside
    const templated = svc.contract
      .filter((op) => op.kind === 'op' && templateFor(op.name))
      .map((op) => op.name);
    if (templated.length > 0) {
      diags.push(diag('W018', 'warning', mod.file, svc.loc, `services.${svc.name}`, 'operation bodies are not specified: ' + templated.join(', '), 'arcod impl generates them, build --reference substitutes a demo body, scaffold leaves a TODO'));
    }

    // A041 — a public operation is the external contract; without a route it
    // has no place in HTTP or OpenAPI, which usually means `public` is a typo.
    if (!svc.external) {
      for (const op of svc.contract) {
        if (op.kind !== 'op' || !op.isPublic) continue;
        if (!routeOf(op)) {
          diags.push(diag('A041', 'error', mod.file, op.loc, `services.${svc.name}.contract.${op.name}`, `public operation ${op.name} has no route`, 'add route: "VERB /path" or drop public'));
        }
      }
    }

    // W017 — jobs are parsed but not executable in v0.1
    for (const op of svc.contract) {
      if (op.kind !== 'job') continue;
      diags.push(diag('W017', 'warning', mod.file, op.loc, `services.${svc.name}.contract.${op.name}`, `job ${op.name} is not executed in v0.1`, 'no state model or selection condition; TTL is a provider guarantee'));
    }

    // W012 — operation without examples
    const mentioned = collectMentionedOps(svc);
    for (const op of svc.contract) {
      if (op.kind === 'job') continue;
      if (!mentioned.has(op.name)) {
        diags.push(diag('W012', 'warning', mod.file, op.loc, `services.${svc.name}.contract.${op.name}`, `operation ${op.name} has no examples`));
      }
    }

    // W013 — no budget (strict mode only). Omitting budget is legitimate:
    // the language has `unknown` precisely for undecided numbers.
    if (!svc.budget && options.strict) {
      diags.push(diag('W013', 'warning', mod.file, svc.loc, `services.${svc.name}`, 'budget is not set (optional)', 'add budget with latency or cost once requirements are known'));
    }

    // A008 — budget metric without a comparison
    for (const item of svc.budget?.items ?? []) {
      const needsMetric = item.key === 'latency' || item.key === 'cost';
      const hasComparison = item.op !== null || (item.expr.kind === 'binary' && ['<=', '<', '>=', '>', '=='].includes(item.expr.op));
      if (needsMetric && !hasComparison) {
        diags.push(diag('A008', 'error', mod.file, item.loc, `services.${svc.name}.budget.${item.key}`, 'budget without a metric or unit'));
      }
    }

    // A010 — ordering cycle
    for (const rule of svc.rules) {
      if (rule.kind !== 'ordering') continue;
      const cycle = findCycle(rule.pairs);
      if (cycle) {
        diags.push(diag('A010', 'error', mod.file, rule.loc, `services.${svc.name}.rules.ordering`, 'cycle in ordering: ' + cycle.join(' -> ')));
      }
    }
  }

  // A018 — ui references an operation that does not exist
  for (const ui of mod.uis) {
    if (ui.impl !== 'spa') {
      diags.push(diag('A019', 'error', mod.file, ui.loc, 'ui.' + ui.name, 'ui kind ' + ui.impl + ' is not supported in v0.1', 'use kind: spa'));
    }
    // A036 — a chat layout must say which operation is the transcript and
    // which one sends a message; the page is not allowed to guess by name.
    if (ui.layout === 'chat') {
      for (const key of ['history', 'send'] as const) {
        const ref = ui[key];
        if (!ref) {
          diags.push(diag('A036', 'error', mod.file, ui.loc, 'ui.' + ui.name,
            'layout: chat requires ' + key + ': Service.op',
            'specify the operation that ' + (key === 'history' ? 'reads history' : 'sends a message')));
          continue;
        }
        const [svcName, opName] = ref.split('.');
        const target = mod.services.find((item) => item.name === svcName);
        const op = target?.contract.find((item) => item.name === opName && item.kind === 'op' && item.isPublic);
        if (!target || !op) {
          diags.push(diag('A036', 'error', mod.file, ui.loc, 'ui.' + ui.name,
            ref + ' is not a public operation of the module', 'history/send must reference a public op'));
        }
      }
      if (ui.start) {
        const [svcName, opName] = ui.start.split('.');
        const target = mod.services.find((item) => item.name === svcName);
        const op = target?.contract.find((item) => item.name === opName && item.kind === 'op' && item.isPublic);
        if (!target || !op) {
          diags.push(diag('A036', 'error', mod.file, ui.loc, 'ui.' + ui.name,
            ui.start + ' is not a public operation of the module', 'start creates a dialogue and returns its id'));
        }
      }
    }

    // A040 — a presentation has two audiences (host and guests) and live
    // widgets; each capability must name its operation instead of guessing.
    if (ui.layout === 'presentation') checkPresentation(mod, ui, diags);

    for (const ref of ui.uses) {
      const parts = ref.split('.');
      const svc = mod.services.find((item) => item.name === parts[0]);
      const op = svc?.contract.find((item) => item.name === parts[1] && item.kind === 'op');
      if (!svc || !op) {
        diags.push(diag('A018', 'error', mod.file, ui.loc, 'ui.' + ui.name + '.uses', 'ui references a nonexistent operation ' + ref));
      } else if (!routeOf(op)) {
        diags.push(diag('A018', 'error', mod.file, ui.loc, 'ui.' + ui.name + '.uses', 'operation ' + ref + ' without a route cannot be called from ui'));
      }
    }
  }

  // A007 also applies to errors declared at module level but never used anywhere.
  const allText = mod.source;
  for (const err of mod.errors) {
    const mentions = allText.split(err.name).length - 1;
    if (mentions <= 1) {
      diags.push(diag('W015', 'warning', mod.file, err.loc, `errors.${err.name}`, `error ${err.name} is declared but never used`));
    }
  }

  checkExternalServices(mod, diags);
  checkWorkflows(mod, diags);

  return sortDiagnostics(diags);
}

// Workflows are graphs, so the interesting checks are structural: names,
// edges, cycles and whether every input port has exactly one producer.
function checkWorkflows(mod: ModuleNode, diags: Diagnostic[]): void {
  const knownOps = new Set<string>();
  for (const svc of mod.services) {
    for (const op of svc.contract) knownOps.add(svc.name + '.' + op.name);
  }

  for (const wf of mod.workflows) {
    const path = 'workflows.' + wf.name;

    // W022 — declarative only in v0.1, like job (W017).
    diags.push(diag('W022', 'warning', mod.file, wf.loc, path,
      'workflow is described but not executed in v0.1',
      'the graph lands in the deploy.<env>.json manifest; execution arrives with the runner'));

    // A033 — a graph without a start is dead weight.
    if (!wf.trigger) {
      diags.push(diag('A033', 'error', mod.file, wf.loc, path, 'workflow without a trigger',
        'add trigger cron("...") | event(...) | manual | after Job'));
    } else if (!['cron', 'event', 'manual', 'after'].includes(wf.trigger.kind)) {
      diags.push(diag('A033', 'error', mod.file, wf.trigger.loc, path + '.trigger',
        'unknown trigger ' + wf.trigger.kind, 'cron, event, manual, after'));
    } else if (wf.trigger.kind === 'cron' && wf.trigger.args.length === 0) {
      diags.push(diag('A033', 'error', mod.file, wf.trigger.loc, path + '.trigger',
        'cron without an expression', 'cron("0 3 * * *", tz: "Europe/Moscow")'));
    }

    const byName = new Map<string, (typeof wf.steps)[number]>();
    for (const step of wf.steps) {
      // A032 — two steps with the same name make edges ambiguous.
      if (byName.has(step.name)) {
        diags.push(diag('A032', 'error', mod.file, step.loc, path + '.steps.' + step.name,
          'step ' + step.name + ' is declared twice'));
      }
      byName.set(step.name, step);

      // W023 — call points at an operation the module does not declare.
      if (step.call && !knownOps.has(step.call) && mod.uses.every((use) => use.what !== 'module')) {
        diags.push(diag('W023', 'warning', mod.file, step.loc, path + '.steps.' + step.name,
          'call ' + step.call + ' is not declared in the module',
          'the step body must be an operation of this module or of an imported module'));
      }
      if (!step.call) {
        diags.push(diag('W024', 'warning', mod.file, step.loc, path + '.steps.' + step.name,
          'step without call: the body has to be generated from the contract',
          'specify call: Service.op to reuse an existing body'));
      }

      for (const need of step.needs) {
        if (need === step.name) {
          diags.push(diag('A030', 'error', mod.file, step.loc, path + '.steps.' + step.name,
            'step ' + step.name + ' depends on itself'));
          continue;
        }
        // A029 — edge to a step that does not exist.
        if (!byName.has(need) && !wf.steps.some((item) => item.name === need)) {
          diags.push(diag('A029', 'error', mod.file, step.loc, path + '.steps.' + step.name,
            'needs references an unknown step ' + need));
        }
      }
    }

    // A030 — a cycle means no step can ever start.
    const cycle = findStepCycle(wf.steps.map((step) => [step.name, step.needs] as const));
    if (cycle) {
      diags.push(diag('A030', 'error', mod.file, wf.loc, path,
        'cycle in the graph: ' + cycle.join(' → '), 'dependencies must form a DAG'));
    }

    for (const step of wf.steps) {
      for (const param of step.params) {
        const type = namedType(param.type);
        if (!type) continue;
        const producers = wf.steps.filter((item) =>
          step.needs.includes(item.name) && item.returns !== null && namedType(item.returns) === type);
        // A031 — every input port needs exactly one producer among the steps it waits for.
        if (producers.length === 0) {
          diags.push(diag('A031', 'error', mod.file, param.loc, path + '.steps.' + step.name + '.' + param.name,
            'port ' + param.name + ': ' + type + ' is not produced by any of the needs',
            step.needs.length ? 'add a step to needs that returns ' + type : 'add needs with a step that returns ' + type));
        } else if (producers.length > 1) {
          diags.push(diag('A031', 'error', mod.file, param.loc, path + '.steps.' + step.name + '.' + param.name,
            'port ' + param.name + ': ' + type + ' is produced by several steps (' + producers.map((item) => item.name).join(', ') + ')',
            'keep a single producer in needs'));
        }
      }
    }

    // W020 — skipping a step silently starves the steps that read its port.
    for (const step of wf.steps) {
      if (step.onFail !== 'skip') continue;
      const consumers = wf.steps.filter((item) => item.needs.includes(step.name));
      if (consumers.length > 0) {
        diags.push(diag('W020', 'warning', mod.file, step.loc, path + '.steps.' + step.name,
          'onFail: skip, but these steps depend on it: ' + consumers.map((item) => item.name).join(', '),
          'dependent steps will be skipped; use onFail: stop if that is not intended'));
      }
    }
  }
}

// External services are described, not generated: only routes matter, and a
// missing address turns a call into a runtime failure, so it is reported here.
function checkExternalServices(mod: ModuleNode, diags: Diagnostic[]): void {
  const env = mod.environments[0];
  const bound = new Map<string, string>();
  for (const bind of env?.binds ?? []) bound.set(bind.alias, bind.provider);

  for (const svc of mod.services) {
    if (!svc.external) continue;
    const path = 'services.' + svc.name;

    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      // A037 — an operation without a route cannot be called remotely.
      if (!routeOf(op)) {
        diags.push(diag('A037', 'error', mod.file, op.loc, path + '.contract.' + op.name,
          'an external service operation has no route', 'route: "POST /v1/..." describes the call'));
      }
    }

    // A038 — nothing is generated for an external service, so local-only
    // declarations would be silently ignored.
    for (const use of svc.uses) {
      diags.push(diag('A038', 'error', mod.file, use.loc, path + '.uses',
        'external service does not use capabilities', 'uses describes what we build, not what we call'));
    }
    if (svc.effects) {
      diags.push(diag('A038', 'error', mod.file, svc.effects.loc, path + '.effects',
        'external service does not declare effects', 'effects belong to the service that calls it'));
    }

    // A039 — the address binding must be an endpoint, not a provisioned provider.
    for (const [alias, provider] of bound) {
      if (alias === svc.name && provider !== 'endpoint') {
        diags.push(diag('A039', 'error', mod.file, svc.loc, path,
          svc.name + ' is bound to ' + provider + ', not to endpoint',
          'an external service is described by its address: bind ' + svc.name + ' -> endpoint(url: "...")'));
      }
    }

    // W026 — used by a local service but not bound: the call will fail at runtime.
    const used = mod.services.some((item) => !item.external && (
      (item.effects?.allow ?? []).some((entry) => entry.startsWith(svc.name + '.')) ||
      item.contract.some((op) => op.clauses.some((clause) =>
        clause.kind === 'effects' && clause.names.some((entry) => entry.startsWith(svc.name + '.'))))
    ));
    if (used && !bound.has(svc.name)) {
      diags.push(diag('W026', 'warning', mod.file, svc.loc, path,
        'external service ' + svc.name + ' is not bound in the environment',
        'add bind ' + svc.name + ' -> endpoint(url: "...")'));
    }
  }
}

function namedType(type: { kind: string; name?: string }): string | null {
  return type.kind === 'named' && typeof type.name === 'string' ? type.name : null;
}

function findStepCycle(edges: ReadonlyArray<readonly [string, string[]]>): string[] | null {
  const graph = new Map<string, string[]>();
  for (const [name, needs] of edges) graph.set(name, [...needs]);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (state.get(next) === 1) {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (!state.has(next)) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };

  for (const node of graph.keys()) {
    if (!state.has(node)) {
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}

function diag(code: string, severity: 'error' | 'warning', file: string, loc: Loc, path: string, message: string, hint?: string): Diagnostic {
  return {
    code, severity, message, file, path, hint,
    range: { line: loc.line, col: loc.col, endLine: loc.endLine, endCol: loc.endCol },
  };
}

function sortDiagnostics(diags: Diagnostic[]): Diagnostic[] {
  return diags.sort((a, b) =>
    a.file.localeCompare(b.file) || a.range.line - b.range.line || a.range.col - b.range.col || a.code.localeCompare(b.code));
}

export function asOnce(expr: Expr): { target: string; elseName: string | null } | null {
  if (expr.kind !== 'call' || expr.callee.kind !== 'ident' || expr.callee.name !== 'once') return null;
  const target = expr.args[0]?.value;
  if (!target || target.kind !== 'ident') return null;
  const elseArg = expr.args.find((arg) => arg.name === 'else');
  const elseName = elseArg && elseArg.value.kind === 'ident' ? elseArg.value.name : null;
  return { target: target.name, elseName };
}

function checkPresentation(
  mod: ModuleNode,
  ui: UiNode,
  diags: Diagnostic[],
): void {
  const where = 'ui.' + ui.name;
  const has = (ref: string | null): boolean => {
    if (!ref) return false;
    const [svcName, opName] = ref.split('.');
    const svc = mod.services.find((item) => item.name === svcName);
    const op = svc?.contract.find((item) => item.name === opName && item.kind === 'op' && item.isPublic);
    if (!op || !routeOf(op)) {
      diags.push(diag('A018', 'error', mod.file, ui.loc, where, 'ui references a nonexistent operation ' + ref));
      return false;
    }
    return true;
  };

  const requirement: Record<string, string> = {
    start: 'creates the session and returns its code',
    join: 'joins a participant by code',
    state: 'returns the current slide, counters and comments',
    advance: 'switches the slide (host only)',
  };
  for (const key of ['start', 'join', 'state', 'advance'] as const) {
    if (!ui[key]) {
      diags.push(diag('A040', 'error', mod.file, ui.loc, where,
        'layout: presentation requires ' + key + ': Service.op',
        'specify the operation that ' + requirement[key]));
    } else {
      has(ui[key]);
    }
  }

  for (const key of ['vote', 'rate', 'comment'] as const) {
    if (ui[key]) has(ui[key]);
  }

  if (ui.slides.length === 0) {
    diags.push(diag('A041', 'error', mod.file, ui.loc, where, 'the presentation has no slides',
      'add slide "Title" { ... }'));
  }

  // A045 — a widget without its operation would render controls that cannot do
  // anything, so the pairing is explicit and checked.
  const binding: Record<string, 'vote' | 'rate' | 'comment'> = {
    poll: 'vote', rating: 'rate', comments: 'comment',
  };
  let hasQr = false;
  for (const slide of ui.slides) {
    if (!slide.widget) {
      diags.push(diag('A042', 'error', mod.file, slide.loc, where + '.slide',
        'slide "' + slide.title + '" has no widget', 'add poll(...), rating, comments or qr'));
      continue;
    }
    const widget = slide.widget;
    if (widget.kind === 'qr') hasQr = true;
    const key = binding[widget.kind];
    if (key && !ui[key]) {
      diags.push(diag('A045', 'error', mod.file, widget.loc, where + '.slide',
        'widget ' + widget.kind + ' requires ' + key + ': Service.op',
        'without this binding the widget cannot send an answer'));
    }
    if (widget.kind === 'poll' && widget.options.length < 2) {
      diags.push(diag('A043', 'error', mod.file, widget.loc, where + '.slide',
        'poll requires at least two options', 'poll("Yes", "No")'));
    }
    if (widget.kind === 'rating' && (!widget.max || widget.max < 2 || widget.max > 10)) {
      diags.push(diag('A044', 'error', mod.file, widget.loc, where + '.slide',
        'rating(max: n) requires 2 <= n <= 10', 'rating(max: 5)'));
    }
  }

  // W028 — a presentation without stream still works, but the page has to
  // poll, and the presenter sees every answer one interval late.
  const hostRef = ui.start;
  const hostSvc = hostRef ? mod.services.find((item) => item.name === hostRef.split('.')[0]) : undefined;
  const streams = Boolean(hostSvc && hostSvc.uses.some((use) => use.capability === 'stream' || use.capability.endsWith('.stream')));
  if (!streams && hostSvc) {
    diags.push(diag('W028', 'warning', mod.file, ui.loc, where,
      'presentation without stream: the page polls state every 1.5 s',
      'add uses stream: stream in ' + hostSvc.name + ' and bind stream -> websocket() in environment'));
  }

  if (!hasQr && ui.slides.length > 0) {
    diags.push(diag('W027', 'warning', mod.file, ui.loc, where,
      'no slide has qr: participants will not see the session link',
      'add slide "Join" { qr }'));
  }
}

function routeOf(op: OpNode): string | null {
  const clause = op.clauses.find((item) => item.kind === 'route');
  return clause && clause.kind === 'route' ? clause.value : null;
}

function errorNames(op: OpNode): string[] {
  const clause = op.clauses.find((c) => c.kind === 'errors');
  return clause && clause.kind === 'errors' ? clause.names : [];
}

function isAllowed(allow: string[], alias: string, op: string): boolean {
  return allow.includes(alias + '.' + op) || allow.includes(alias + '.*');
}

function isDenied(deny: string[], alias: string, op: string): boolean {
  return deny.includes(alias + '.' + op) || deny.includes(alias + '.*') || deny.includes(alias);
}

function requiredEffects(svc: ServiceNode, op: OpNode): Array<{ alias: string; op: string }> {
  const kv = storageUse(svc)?.alias;
  const ids = svc.uses.find((use) => use.capability === 'ids' || use.capability.endsWith('.ids'))?.alias;
  const out: Array<{ alias: string; op: string }> = [];

  if (op.name === 'create') {
    if (kv) out.push({ alias: kv, op: 'set' });
    if (ids) out.push({ alias: ids, op: 'new' });
  }

  if (op.name === 'read' && kv && !svc.rules.some((rule) => rule.kind === 'atomic' && rule.name === op.name)) {
    out.push({ alias: kv, op: 'get' }, { alias: kv, op: 'del' });
  }

  return out;
}

export function walkExpr(expr: Expr, fn: (expr: Expr) => void): void {
  fn(expr);
  switch (expr.kind) {
    case 'member': walkExpr(expr.object, fn); break;
    case 'call':
      walkExpr(expr.callee, fn);
      for (const arg of expr.args) walkExpr(arg.value, fn);
      break;
    case 'unary': walkExpr(expr.operand, fn); break;
    case 'binary': walkExpr(expr.left, fn); walkExpr(expr.right, fn); break;
    case 'is': walkExpr(expr.expr, fn); break;
    default: break;
  }
}

interface CapCall { alias: string; op: string; loc: Loc }

function asCapabilityCall(expr: Expr, aliases: Set<string>): CapCall | null {
  if (expr.kind !== 'call' || expr.callee.kind !== 'member' || expr.callee.object.kind !== 'ident') return null;
  const alias = expr.callee.object.name;
  if (!aliases.has(alias)) return null;
  return { alias, op: expr.callee.property, loc: expr.loc };
}

function collectCapabilityUses(svc: ServiceNode, aliases: Set<string>): CapCall[] {
  const out: CapCall[] = [];
  const visit = (expr: Expr) => {
    walkExpr(expr, (e) => {
      const call = asCapabilityCall(e, aliases);
      if (call) out.push(call);
    });
  };
  for (const op of svc.contract) {
    for (const clause of op.clauses) {
      if (clause.kind === 'pre' || clause.kind === 'post' || clause.kind === 'onerror') visit(clause.expr);
    }
  }
  for (const rule of svc.rules) {
    if (rule.kind === 'invariant') visit(rule.expr);
    if (rule.kind === 'atomic') {
      const kvAliases = [...aliases].filter((alias) =>
        svc.uses.some((use) => use.alias === alias && (use.capability === 'kv' || use.capability.endsWith('.kv'))));
      for (const step of rule.steps) {
        const parts = step.split('.');
        if (parts.length === 2 && aliases.has(parts[0])) {
          out.push({ alias: parts[0], op: parts[1], loc: rule.loc });
        } else if (kvAliases.length === 1) {
          out.push({ alias: kvAliases[0], op: step, loc: rule.loc });
        }
      }
    }
  }
  for (const example of svc.examples) {
    for (const section of [example.given, example.when, example.then]) {
      for (const stmt of section) visit(stmt.kind === 'let' ? stmt.expr : stmt.expr);
    }
  }
  return out;
}

function mentionsBareAlias(svc: ServiceNode, alias: string): boolean {
  let found = false;
  const visit = (expr: Expr) => walkExpr(expr, (e) => {
    if (e.kind === 'call' && e.callee.kind === 'ident' && e.callee.name === alias) found = true;
  });
  for (const op of svc.contract) {
    for (const clause of op.clauses) {
      if (clause.kind === 'pre' || clause.kind === 'post' || clause.kind === 'onerror') visit(clause.expr);
    }
  }
  for (const example of svc.examples) {
    for (const section of [example.given, example.when, example.then]) {
      for (const stmt of section) visit(stmt.expr);
    }
  }
  return found;
}

function collectAssertedErrors(svc: ServiceNode): Set<string> {
  const out = new Set<string>();
  for (const example of svc.examples) {
    for (const section of [example.given, example.when, example.then]) {
      for (const stmt of section) {
        walkExpr(stmt.expr, (e) => {
          if (e.kind === 'is') out.add(e.error);
        });
      }
    }
  }
  return out;
}

function collectHandledErrors(svc: ServiceNode): Set<string> {
  const out = new Set<string>();
  for (const op of svc.contract) {
    for (const clause of op.clauses) {
      if (clause.kind === 'onerror') out.add(clause.error);
    }
  }
  return out;
}

function collectMentionedOps(svc: ServiceNode): Set<string> {
  const out = new Set<string>();
  const visit = (expr: Expr) => walkExpr(expr, (e) => {
    if (e.kind === 'call' && e.callee.kind === 'ident') out.add(e.callee.name);
  });
  for (const example of svc.examples) {
    for (const section of [example.given, example.when, example.then]) {
      for (const stmt of section) visit(stmt.expr);
    }
  }
  return out;
}

function findCycle(pairs: Array<[string, string]>): string[] | null {
  const graph = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    if (!graph.has(a)) graph.set(a, []);
    graph.get(a)!.push(b);
  }
  const state = new Map<string, number>();
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) return stack.slice(stack.indexOf(next)).concat(next);
      if (!state.has(next)) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    state.set(node, 2);
    stack.pop();
    return null;
  };

  for (const node of graph.keys()) {
    if (!state.has(node)) {
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}
