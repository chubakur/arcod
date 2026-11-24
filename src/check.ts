import type { Diagnostic } from './diagnostics.ts';
import type { Expr, Loc, ModuleNode, OpNode, Param, ServiceNode, TypeExpr, UiNode } from './ast.ts';
import { templateFor } from './templates.ts';
import { BIND_ARGS, providerImplements } from './providers.ts';
import { builtinRegistry, type ProviderRegistry } from './registry.ts';
import { capabilityFor, storageKind, storageUse } from './capabilities.ts';
import { deployNames, deployProvider } from './deploy.ts';
import { MANAGED_ENDPOINTS, MANAGED_PROVIDERS, managedResource } from './emit/terraform.ts';
import { baseType, defaultValue } from './migrate.ts';
import { boundsOf, constraintOf, describeViolation, lengthBoundsOf, unknownFormatOf } from './constraints.ts';
import { isIsoInstant } from './instant.ts';
import { implCollisions, implSignatureProblems } from './impl.ts';

const WRITE_OPS = new Set(['set', 'del', 'put', 'push', 'incr', 'decr', 'update', 'write', 'delete']);
// The HTTP methods a route may name. Anything else (or no method at all)
// would silently become GET with path "/" in the emitters.
const ROUTE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// Delay units a trigger may use; a runner has to convert them to a timer.
const TRIGGER_UNITS = ['ms', 's', 'm', 'h', 'd'];
// Type arguments that change what a builtin means. Anything else written in
// the parentheses has no reader in any emitter, so check names it instead of
// letting the author believe a bound was applied (A087).
const BUILTIN_ARG_RULES: Record<string, { named: string[]; positional: number; hint: string }> = {
  string: { named: ['min', 'max', 'format'], positional: 0, hint: 'known arguments: min, max, format' },
  bytes: { named: ['min', 'max'], positional: 0, hint: 'known arguments: min, max' },
  int: { named: ['min', 'max'], positional: 0, hint: 'known arguments: min, max' },
  number: { named: ['min', 'max'], positional: 0, hint: 'known arguments: min, max' },
  float: { named: ['min', 'max'], positional: 0, hint: 'known arguments: min, max' },
  decimal: { named: ['min', 'max'], positional: 0, hint: 'known arguments: min, max' },
  list: { named: [], positional: 1, hint: 'list takes one type argument, e.g. list<Item>' },
  map: { named: [], positional: 2, hint: 'map takes two type arguments, e.g. map<string, int>' },
};
export const BUILTIN_TYPE_NAMES = new Set([
  'string', 'bytes', 'int', 'float', 'number', 'bool', 'boolean', 'uuid',
  'json', 'datetime', 'decimal', 'list', 'map', 'void', 'null',
  'email', 'url', 'uri',
]);

const FORBIDDEN_IN_MODEL = ['redis', 'postgres', 'postgresql', 'dynamodb', 'mysql', 'mongodb', 'localhost', '127.0.0.1', 'ollama', 'openai', 'anthropic'];

// A provider word counts only when it stands alone: an identifier such as
// messages_mysql or a path such as docs/redis.md is not a binding, while
// `// redis`, `redis://` and `127.0.0.1:6379` all are.
function mentionsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?<![A-Za-z0-9_])' + escaped + '(?![A-Za-z0-9_])', 'i').test(text);
}


export interface CheckOptions {
  environment?: string;
  // Budgets are a design decision, not a prerequisite: a draft may not know
  // its latency or cost yet. Strict mode asks for them explicitly.
  strict?: boolean;
  // Built-ins by default; the CLI passes a registry that also knows plugin
  // manifests, so bindings resolve the same way check and emitters see them.
  registry?: ProviderRegistry;
  // Operation bodies, when the caller has them. They are the only place a body
  // names an entity, so a typo there is checkable only with this evidence.
  impl?: Record<string, string>;
  // Files in impl/ that the build will not bundle (anything but *.mjs).
  implIgnored?: string[];
}

// An ssr page is rendered from a parameterless GET: that is the only shape a
// server can answer before the browser has said anything.
function ssrDataOp(mod: ModuleNode, ui: UiNode): string | null {
  const svcName = ui.uses[0]?.split('.')[0];
  const svc = mod.services.find((item) => item.name === svcName) ?? mod.services[0];
  if (!svc) return null;
  const wanted = new Set(ui.uses.map((entry) => entry.split('.').pop() ?? entry));
  for (const op of svc.contract) {
    if (op.kind !== 'op' || (!op.isPublic && !op.auth)) continue;
    if (wanted.size > 0 && !wanted.has(op.name)) continue;
    const clause = op.clauses.find((item) => item.kind === 'route');
    const value = clause && clause.kind === 'route' ? clause.value : op.name;
    if (!/^GET\s+\/[^\s:]*$/i.test(value)) continue;
    return op.name;
  }
  return null;
}

export function check(mod: ModuleNode, options: CheckOptions = {}): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const registry = options.registry ?? builtinRegistry();
  const env = options.environment
    ? mod.environments.find((e) => e.name === options.environment)
    : mod.environments[0];
  // A045 — `--env staging` used to fall through to "no environment", and every
  // capability then looked unbound: the report pointed at bindings while the
  // real mistake was the environment name.
  if (options.environment && !env) {
    return [diag('A045', 'error', mod.file, mod.loc, 'environments',
      'unknown environment ' + options.environment,
      mod.environments.length > 0
        ? 'declared: ' + mod.environments.map((item) => item.name).join(', ')
        : 'declare an environment, or drop --env')];
  }

  // A066 — two declarations of one name are ambiguous: every emitter keys by
  // name, so the second silently replaced the first in the generated service.
  const declaredNames = new Map<string, Loc>();
  const declareOnce = (kind: string, name: string, loc: Loc): void => {
    if (declaredNames.has(kind + ' ' + name)) {
      diags.push(diag('A066', 'error', mod.file, loc, kind + 's.' + name,
        kind + ' ' + name + ' is declared twice', 'rename one of them'));
      return;
    }
    declaredNames.set(kind + ' ' + name, loc);
  };
  for (const decl of mod.types) declareOnce('type', decl.name, decl.loc);
  for (const decl of mod.enums) declareOnce('enum', decl.name, decl.loc);
  for (const decl of mod.errors) declareOnce('error', decl.name, decl.loc);
  for (const decl of mod.services) declareOnce('service', decl.name, decl.loc);
  for (const decl of mod.workflows) declareOnce('workflow', decl.name, decl.loc);
  for (const decl of mod.environments) declareOnce('environment', decl.name, decl.loc);

  for (const svc of mod.services) {
    const opNames = new Set<string>();
    for (const op of svc.contract) {
      if (opNames.has(op.name)) {
        diags.push(diag('A066', 'error', mod.file, op.loc, 'services.' + svc.name + '.ops.' + op.name,
          'operation ' + op.name + ' is declared twice', 'rename one of them'));
      }
      opNames.add(op.name);
      // Two parameters of one name are one key in the request object and two
      // entries in OpenAPI, where the name is what binds the value.
      const paramNames = new Set<string>();
      for (const param of op.params) {
        if (paramNames.has(param.name)) {
          diags.push(diag('A066', 'error', mod.file, param.loc, `services.${svc.name}.contract.${op.name}.params.${param.name}`,
            `parameter ${param.name} is declared twice in ${op.name}`, 'rename one of them'));
        }
        paramNames.add(param.name);
      }
    }
  }

  for (const decl of mod.types) {
    if (decl.type.kind !== 'record') continue;
    const fieldNames = new Set<string>();
    for (const field of decl.type.fields) {
      if (fieldNames.has(field.name)) {
        diags.push(diag('A066', 'error', mod.file, field.loc, 'types.' + decl.name + '.fields.' + field.name,
          'field ' + field.name + ' is declared twice in ' + decl.name, 'rename one of them'));
      }
      fieldNames.add(field.name);
    }
  }

  // The same rule inside an error body: a second field would overwrite the
  // first in the response, and the first would never be filled.
  for (const decl of mod.errors) {
    const fieldNames = new Set<string>();
    for (const field of decl.fields) {
      if (fieldNames.has(field.name)) {
        diags.push(diag('A066', 'error', mod.file, field.loc, 'errors.' + decl.name + '.fields.' + field.name,
          'field ' + field.name + ' is declared twice in ' + decl.name, 'rename one of them'));
      }
      fieldNames.add(field.name);
    }
  }

  // ...and inside an enum: `enum E { a, b, a }` generated a switch with two
  // arms for the same name, and fmt printed both.
  for (const decl of mod.enums) {
    const seenValues = new Set<string>();
    decl.values.forEach((value, index) => {
      if (seenValues.has(value)) {
        diags.push(diag('A066', 'error', mod.file, decl.valueLocs?.[index] ?? decl.loc, 'enums.' + decl.name,
          'value ' + value + ' is declared twice in ' + decl.name, 'rename one of them'));
      }
      seenValues.add(value);
    });
  }

  // A066 — two examples of one service with the same name: the run reports
  // them by name, so one result would shadow the other.
  for (const svc of mod.services) {
    const exampleNames = new Set<string>();
    for (const example of svc.examples) {
      if (exampleNames.has(example.name)) {
        diags.push(diag('A066', 'error', mod.file, example.loc, 'services.' + svc.name + '.examples.' + example.name,
          'example ' + example.name + ' is declared twice in ' + svc.name, 'rename one of them'));
      }
      exampleNames.add(example.name);
    }
  }

  // A067 — a workflow or step clause written twice: the parser keeps the
  // first value, so the copy would vanish without a word.
  for (const wf of mod.workflows) {
    for (const item of wf.duplicates ?? []) {
      diags.push(diag('A067', 'error', mod.file, item.loc, 'workflows.' + wf.name,
        'clause ' + item.key + ' is declared twice',
        'keep one: the first value is the one that is used'));
    }
    for (const st of wf.steps) {
      for (const item of st.duplicates ?? []) {
        diags.push(diag('A067', 'error', mod.file, item.loc, 'workflows.' + wf.name + '.steps.' + st.name,
          'clause ' + item.key + ' is declared twice',
          'keep one: the first value is the one that is used'));
      }
    }
  }

  // A067 — one operation declares the same clause twice. The AST keeps both,
  // every reader takes the first, and the second silently does nothing.
  for (const svc of mod.services) {
    for (const op of svc.contract) {
      const seenClauses = new Map<string, number>();
      for (const clause of op.clauses) {
        const key = clause.kind === 'onerror' ? 'on error ' + clause.error : clause.kind;
        const first = seenClauses.get(key);
        if (first !== undefined) {
          diags.push(diag('A067', 'error', mod.file, clause.loc, 'services.' + svc.name + '.ops.' + op.name,
            'clause ' + key + ' is declared twice',
            'keep one: the generated service reads the first, so the second never takes effect'));
          continue;
        }
        seenClauses.set(key, clause.loc.offset);
      }
    }
  }


  // W032 — a bind guarantee is a promise written for the reader. Nothing
  // checks it and no adapter enforces it, so a typo would look like a real
  // durability contract; say what it is instead of dropping it.
  for (const environment of mod.environments) {
    for (const bind of environment.binds) {
      if (bind.guarantees.length === 0) continue;
      diags.push(diag('W032', 'warning', mod.file, bind.loc,
        'environments.' + environment.name + '.binds.' + bind.alias,
        'bind guarantees are declarative: ' + bind.guarantees.join(', '),
        'nothing checks or enforces them; keep them for the reader or drop the clause'));
    }
  }

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
      // W034 — the same rule as for binds: a deploy argument reaches the
      // manifest as the string '<expr>' when it is not a literal, and the
      // terraform emitter would write that string into the plan.
      const expr = deploy.args[key];
      if (expr.kind === 'literal') continue;
      diags.push(diag('W034', 'warning', mod.file, expr.loc, 'environments.' + environment.name + '.deploy',
        'deploy argument ' + key + ' is not a literal and no emitter reads it',
        'write a string, number or true/false; deploy arguments are static'));
    }
  }

  // A023 — unknown provider; A025 — one alias bound more than once; A026 — a
  // provider requires an argument. Every environment is checked, not only the
  // selected one: a spec that was clean for `dev` used to fail at
  // `deploy --env prod`, long after the merge, on a binding nobody had read.
  for (const environment of mod.environments) {
    const aliases = new Set<string>();
    // One container per host:port, whichever alias reaches it. A085 below.
    const containers = new Map<string, { image: string; alias: string }>();
    // A managed cloud service has one endpoint, so two binds to the same
    // provider in one cloud environment cannot become two clusters: the plan
    // renders one block and the second binding shared it silently. W045 below.
    const managedSeen = new Map<string, string>();
    for (const bind of environment.binds) {
      const subject = `environments.${environment.name}.binds.${bind.alias}`;
      if (bind.provider !== 'local' && aliases.has(bind.alias)) {
        diags.push(diag('A025', 'error', mod.file, bind.loc, subject,
          `alias ${bind.alias} is bound twice`, 'keep a single provider'));
      }
      aliases.add(bind.alias);
      // W034 — a bind argument reaches an emitter as a literal or not at all:
      // `host`, `port`, `expose` and provider options are read from literal
      // expressions, so `redis(host: someName)` fell back to the default host
      // and the container silently talked to the wrong address.
      for (const [key, expr] of Object.entries(bind.args)) {
        if (expr.kind === 'literal') continue;
        diags.push(diag('W034', 'warning', mod.file, expr.loc, subject,
          `bind argument ${key} is not a literal and no emitter reads it`,
          'write a string, number or true/false; provider options are static'));
      }
      // Capabilities any service asks of this alias; two services may share
      // one alias with different capabilities, and a provider has to satisfy
      // every one of them.
      const capabilities = new Map<string, string>();
      for (const item of mod.services) {
        if (item.external) continue;
        for (const use of item.uses) {
          if (use.alias !== bind.alias) continue;
          const short = use.capability.includes('.') ? use.capability.split('.').pop()! : use.capability;
          capabilities.set(short, use.capability);
        }
      }

      // A068 — `local` is the compiler's own runtime: it serves ids and hash
      // and nothing else. Bound to kv/sql/queue it provisions no container,
      // check stayed clean, and the generated service failed on first use with
      // no address to talk to.
      if (bind.provider === 'local') {
        for (const capability of capabilities.keys()) {
          if (capability === 'ids' || capability === 'hash') continue;
          const alternatives = registry.forCapability(capability);
          diags.push(diag('A068', 'error', mod.file, bind.loc, subject,
            `provider local does not serve ${capability}`,
            alternatives.length > 0 ? 'bind one of: ' + alternatives.join(', ') : `no provider declares ${capability}`));
        }
        continue;
      }

      const spec = registry.get(bind.provider);
      if (!spec) {
        diags.push(diag('A023', 'error', mod.file, bind.loc, subject,
          `unknown provider ${bind.provider}`, 'available: ' + registry.names().join(', ')));
        continue;
      }
      for (const required of spec.requires ?? []) {
        if (!(required in bind.args)) {
          diags.push(diag('A026', 'error', mod.file, bind.loc, subject,
            `provider ${bind.provider} requires argument ${required}`,
            `add ${required}: "..." to bind`));
        }
      }

      // A085 — compose and k8s address a provider container by its host, so two
      // binds that pin different images to one host describe two containers
      // with one name: the emitter wrote the key twice, the later manifest won
      // and the other bind talked to an image that was never started.
      {
        const literal = (key: 'host' | 'port' | 'image'): unknown => {
          const expr = bind.args[key];
          return expr && expr.kind === 'literal' ? expr.value : undefined;
        };
        const host = typeof literal('host') === 'string' ? String(literal('host')) : spec.name;
        const port = typeof literal('port') === 'number' ? Number(literal('port')) : spec.port ?? 0;
        const image = typeof literal('image') === 'string' ? String(literal('image')) : spec.image ?? '';
        const key = host + '|' + port;
        const previous = containers.get(key);
        if (previous && previous.image !== image) {
          diags.push(diag('A085', 'error', mod.file, bind.loc, subject,
            'container ' + host + ' is bound to two images',
            'one host is one container: keep ' + previous.image + ' (from ' + previous.alias + ') or ' + image + ', or give the second bind another host'));
        } else if (!previous) {
          containers.set(key, { image, alias: bind.alias });
        }
      }

      // W035 — a provider reads a fixed set of options. An argument it does
      // not know was accepted and dropped: redis(bogus: 1) looked configured
      // and changed nothing. A plugin without an args map is exempt.
      if (spec.options) {
        const allowed = new Set<string>([...BIND_ARGS, ...spec.options]);
        for (const [key, expr] of Object.entries(bind.args)) {
          if (allowed.has(key)) continue;
          diags.push(diag('W035', 'warning', mod.file, expr.loc, subject,
            'provider ' + bind.provider + ' does not read bind argument ' + key,
            'known arguments: ' + [...allowed].sort().join(', ')));
        }
      }

      // W044 — a managed cloud service has no container to address. The
      // terraform plan provisions the cluster and exports its endpoint, so the
      // bind's host, port and expose are container instructions that cannot
      // be honored: a spec that looks configured deploys a service pointed at
      // the compose host name. The plan and this warning name the same gap.
      if (environment.deploy?.provider === 'yandex') {
        const kind = managedResource(bind.provider);
        if (kind) {
          const previous = managedSeen.get(kind);
          if (previous) {
            diags.push(diag('W045', 'warning', mod.file, bind.loc, subject,
              'binds ' + previous + ' and ' + bind.alias + ' both become one managed ' + kind + ' resource',
              'the cloud assigns a single endpoint, so the plan renders one; drop one bind or give the second its own environment'));
          } else {
            managedSeen.set(kind, bind.alias);
          }
        }
        // W046 — a stateful provider the plan cannot provision. mysql and
        // mariadb are in the managed set but have no yandex resource, so the
        // plan used to look complete while creating nothing for the bind: the
        // app would point at a host that does not exist.
        if (MANAGED_PROVIDERS.has(bind.provider) && managedResource(bind.provider) === null) {
          diags.push(diag('W046', 'warning', mod.file, bind.loc, subject,
            'deploy yandex provisions no ' + bind.provider + ' resource: ' + bind.alias + ' would be wired to nothing',
            'bind postgres for a managed database, or keep ' + bind.provider + ' for docker and give the cloud environment an external host'));
        }
        const endpoint = MANAGED_ENDPOINTS[bind.provider];
        if (endpoint) {
          const dropped = ['host', 'port', 'expose'].filter((key) => bind.args[key]?.kind === 'literal');
          if (dropped.length > 0) {
            diags.push(diag('W044', 'warning', mod.file, bind.loc, subject,
              `managed ${bind.provider} assigns its own endpoint: ${dropped.join(', ')} ignored by \`arcod terraform\``,
              `the plan exports ${endpoint.output}_host and ${endpoint.output}_port; a cloud environment's k8s manifest reads them from the endpoints Secret, so keep host/port for docker or drop them`));
          }
        }
      }

      // A084 — `image` pins the container to an exact reference: redis(image:
      // "redis:7.4"). The emitter writes the value straight into the image
      // line, and a spec string may carry \n, so the value has to be a plain
      // reference here — otherwise one binding rewrites the whole compose file.
      if ('image' in bind.args && spec.image) {
        const expr = bind.args.image;
        const value = expr.kind === 'literal' ? expr.value : undefined;
        if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(value)) {
          diags.push(diag('A084', 'error', mod.file, expr.loc, subject,
            'bind argument image must be an image reference',
            'write image: "redis:7.4" — a repository with an optional tag or digest, no spaces or line breaks'));
        }
      }

      // A077 — `dim` is the declared width of every embedding this binding
      // returns. Non-literal, zero or fractional values used to reach the
      // emitter and produce a service that compared vectors of different
      // widths on the first request; the contract is static, so it is checked
      // here.
      if ('dim' in bind.args && spec.options?.includes('dim')) {
        const expr = bind.args.dim;
        const value = expr.kind === 'literal' ? expr.value : undefined;
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          diags.push(diag('A077', 'error', mod.file, expr.loc, subject,
            'bind argument dim must be a positive integer',
            'write dim: 768 — the width every vector of this binding must have'));
        }
      }

      // A024 — the provider does not implement the capability the alias is
      // used for; W029 — a plugin adapter nothing can dispatch.
      if (capabilities.size === 0) continue;
      for (const [capability, declared] of capabilities) {
        if (spec.runtime && registry.signaturesFor(capability).length === 0) {
          diags.push(diag('W029', 'warning', mod.file, bind.loc, subject,
            `${bind.provider} ships a runtime adapter but ${capability} declares no signatures`,
            'add signatures to the capability manifest; without them the generated service cannot dispatch the adapter'));
        }
        // A083 — the provider declares the capability, but the generated
        // runtime has no driver for it: the container starts, jobs execute in
        // process and messages vanish on restart. Silence here read as support.
        if (providerImplements(spec, capability) && spec.noRuntime) {
          const usable = registry.forCapability(capability).filter((name) => !registry.get(name)?.noRuntime);
          diags.push(diag('A083', 'error', mod.file, bind.loc, subject,
            `provider ${bind.provider} cannot serve ${capability} at runtime`,
            spec.noRuntime + (usable.length > 0 ? '; bind one of: ' + usable.join(', ') : '')));
          continue;
        }
        // A094 -- the runtime has one store. A kv alias next to a sql store
        // lives in that store's arcod_kv table, so a redis binding for it
        // starts a container and exports REDIS_URL that no emitted line reads:
        // the cache stays empty while the table fills. Rejecting is honest
        // until the runtime can run a second store.
        const kvAlias = capability === 'kv';
        const sqlUser = kvAlias
          ? mod.services.find((item) => !item.external && storageKind(item) === 'sql'
            && item.uses.some((use) => use.alias === bind.alias && (use.capability === 'kv' || use.capability.endsWith('.kv'))))
          : undefined;
        if (kvAlias && bind.provider === 'redis' && sqlUser) {
          diags.push(diag('A094', 'error', mod.file, bind.loc, subject,
            `alias ${bind.alias} is kv in ${sqlUser.name}, but that service stores in sql: the alias would live in the sql store's arcod_kv table, not in ${bind.provider}`,
            `drop this bind (kv still works, through the sql store), or move ${sqlUser.name} to store: kv`));
          continue;
        }
        if (!providerImplements(spec, capability)) {
          const alternatives = registry.forCapability(capability);
          diags.push(diag('A024', 'error', mod.file, bind.loc, subject,
            `${bind.provider} does not implement ${declared}`,
            alternatives.length > 0 ? `available for ${capability}: ` + alternatives.join(', ') : `${capability} has no providers`));
        }
      }
    }
  }

  const bound = new Map<string, string>();
  for (const bind of env?.binds ?? []) bound.set(bind.alias, bind.provider);

  // A059 — a schema default is one value shared by the DDL, the runtime insert
  // and the OpenAPI schema. It must be a static literal of the field's type;
  // anything computed belongs in the operation body, not in the model.
  for (const decl of mod.types) {
    if (decl.type.kind !== 'record') continue;
    for (const field of decl.type.fields) {
      if (!field.default) continue;
      const resolved = defaultValue(mod, field.type, field.default);
      if (!resolved.ok) {
        diags.push(diag('A059', 'error', mod.file, field.loc, `types.${decl.name}.${field.name}`,
          `default of ${field.name} is invalid: ${resolved.reason}`,
          'use a literal that matches the field type'));
        continue;
      }
      // A060 — the default is the right kind of literal but not a legal value
      // of the constrained type: an email default that is not an address, an
      // enum default outside the enum. The runtime would reject the very row
      // the schema itself inserts, so it is a model error, not a warning.
      const constraint = constraintOf(mod, field.type);
      const violation = describeViolation(constraint, resolved.value);
      if (violation) {
        diags.push(diag('A060', 'error', mod.file, field.loc, `types.${decl.name}.${field.name}`,
          `default of ${field.name} violates its type: ${violation}`,
          'pick a value the constrained type accepts'));
      }
      // A string bound is a length: a default shorter than min or longer than
      // max would insert the row the schema promises clients never see.
      const lengths = lengthBoundsOf(mod, field.type);
      if (typeof resolved.value === 'string') {
        const length = [...resolved.value].length;
        const outside = lengths.min !== null && length < lengths.min
          ? 'must be at least ' + lengths.min + ' characters'
          : lengths.max !== null && length > lengths.max
            ? 'must be at most ' + lengths.max + ' characters'
            : null;
        if (outside) {
          diags.push(diag('A060', 'error', mod.file, field.loc, `types.${decl.name}.${field.name}`,
            `default of ${field.name} violates its type: ${outside}`,
            'pick a value inside the declared bounds'));
        }
      }
      // Integer bounds are part of the type too: a default below min or above
      // max would insert the very row the schema promises clients never see.
      const bounds = boundsOf(mod, field.type);
      if (typeof resolved.value === 'number') {
        const outside = bounds.min !== null && resolved.value < bounds.min
          ? 'must be >= ' + bounds.min
          : bounds.max !== null && resolved.value > bounds.max
            ? 'must be <= ' + bounds.max
            : null;
        if (outside) {
          diags.push(diag('A060', 'error', mod.file, field.loc, `types.${decl.name}.${field.name}`,
            `default of ${field.name} violates its type: ${outside}`,
            'pick a value inside the declared bounds'));
        }
      }
    }
  }

  // A061 — an unknown format name would silently degrade to a plain string,
  // so the schema would promise nothing and the runtime would check nothing.
  for (const param of declaredParams(mod)) {
    const unknown = unknownFormatOf(param.type);
    if (unknown !== null) {
      diags.push(diag('A061', 'error', mod.file, param.loc, 'types',
        unknown === ''
          ? 'string(format: ...) needs a format name'
          : `unknown string format ${unknown}`,
        'known formats: email, url'));
    }
  }

  // A086 — arguments refine a builtin name: `string(max: 80)`,
  // `list<Item>`, `string(format: email)`. Written on a declared type they
  // cannot reach anything: every consumer resolves the alias to its
  // declaration and reads the arguments there, so `name: Title(min: 3)`
  // checked clean while the schema kept `$ref Title` and `min: 3` vanished
  // from both the contract and the runtime.
  const declaredTypeNames = new Set([
    ...mod.types.map((decl) => decl.name),
    ...mod.enums.map((decl) => decl.name),
  ]);
  const typeRoots: TypeExpr[] = [];
  for (const decl of mod.types) {
    if (decl.type.kind !== 'record') typeRoots.push(decl.type);
  }
  for (const param of declaredParams(mod)) typeRoots.push(param.type);
  for (const svc of mod.services) {
    for (const op of svc.contract) {
      if (op.returns) typeRoots.push(op.returns);
    }
  }
  for (const wf of mod.workflows) {
    for (const step of wf.steps) {
      for (const param of step.params) typeRoots.push(param.type);
      if (step.returns) typeRoots.push(step.returns);
    }
  }
  const seenRefinements = new Set<string>();
  for (const root of typeRoots) {
    walkTypeExpr(root, (type) => {
      if (type.kind !== 'named' || type.args.length === 0) return;
      if (!declaredTypeNames.has(type.name)) return;
      const key = type.loc.offset + ':' + type.name;
      if (seenRefinements.has(key)) return;
      seenRefinements.add(key);
      diags.push(diag('A086', 'error', mod.file, type.loc, 'types.' + type.name,
        'arguments on ' + type.name + ' are ignored: ' + type.name + ' is a declared type, not a builtin',
        'write them where ' + type.name + ' is declared, e.g. type ' + type.name + ' = string(min: …)'));
    });
  }

  // A087 — a builtin reads a fixed set of arguments. `string(mx: 80)` or
  // `int(max: 5)` was accepted and dropped: the OpenAPI schema and the runtime
  // both carried no bound, so the model promised a limit it never enforced.
  for (const root of typeRoots) {
    walkTypeExpr(root, (type) => {
      if (type.kind !== 'named' || type.args.length === 0) return;
      if (declaredTypeNames.has(type.name)) return;
      if (!BUILTIN_TYPE_NAMES.has(type.name)) return;
      const rule = BUILTIN_ARG_RULES[type.name];
      if (!rule) {
        diags.push(diag('A087', 'error', mod.file, type.loc, 'types.' + type.name,
          type.name + ' takes no arguments', 'drop them: no emitter reads a refinement here'));
        return;
      }
      let positional = 0;
      for (const arg of type.args) {
        if (arg.isType) {
          positional += 1;
          continue;
        }
        if (arg.name === undefined || !rule.named.includes(arg.name)) {
          diags.push(diag('A087', 'error', mod.file, arg.loc, 'types.' + type.name,
            'unknown argument ' + (arg.name === undefined ? '(positional)' : '\"' + arg.name + '\"') + ' for ' + type.name,
            rule.hint));
        }
        if (typeof arg.name === 'string' && rule.named.includes(arg.name) && (arg.name === 'min' || arg.name === 'max')) {
          const numeric = (arg.value.kind === 'literal' && typeof arg.value.value === 'number') || arg.value.kind === 'duration';
          if (!numeric) {
            diags.push(diag('A087', 'error', mod.file, arg.loc, 'types.' + type.name,
              type.name + '(' + arg.name + ':) needs a number' + (type.name === 'bytes' ? ' or a duration' : ''),
              type.name === 'int' ? 'write a whole number, e.g. int(max: 100)' : 'write a literal bound, e.g. ' + type.name + '(max: 80)'));
          } else if (type.name === 'int' && !(arg.value.kind === 'literal' && Number.isInteger(arg.value.value))) {
            diags.push(diag('A087', 'error', mod.file, arg.loc, 'types.' + type.name,
              'int(' + arg.name + ':) needs a whole number',
              'the bound of an integer is an integer, e.g. int(max: 100)'));
          }
        }
      }
      if (positional !== rule.positional) {
        diags.push(diag('A087', 'error', mod.file, type.loc, 'types.' + type.name,
          type.name + ' takes ' + (rule.positional === 0 ? 'no type arguments' : rule.positional + ' type argument' + (rule.positional === 1 ? '' : 's'))
            + ', got ' + positional,
          rule.hint));
      }
    });
  }

  // A088 — a name that is neither a builtin nor declared in this module. The
  // emitters treated it as `{}` (an OpenAPI schema of anything), so a typo
  // widened the contract to accept whatever the client sent and the field had
  // no type in GraphQL or in the migration.
  const seenUnknownTypes = new Set<string>();
  for (const root of typeRoots) {
    walkTypeExpr(root, (type) => {
      if (type.kind !== 'named') return;
      if (BUILTIN_TYPE_NAMES.has(type.name)) return;
      if (declaredTypeNames.has(type.name)) return;
      const key = type.loc.offset + ':' + type.name;
      if (seenUnknownTypes.has(key)) return;
      seenUnknownTypes.add(key);
      diags.push(diag('A088', 'error', mod.file, type.loc, 'types.' + type.name,
        'unknown type ' + type.name,
        'declare type ' + type.name + ' = … or use a builtin (' + [...BUILTIN_TYPE_NAMES].join(', ') + ')'));
    });
  }

  // A089 — a declaration named after a builtin shadows it. OpenAPI lists the
  // declaration under components while every use site resolves the builtin
  // first: `type int = string` emitted `{"type": "string"}` for `int` and an
  // `integer` for the field of that type, so the contract contradicted itself
  // and the runtime, the migration and GraphQL each picked a different side.
  // One rule — a builtin name is not a declaration site — keeps them in step.
  for (const decl of [...mod.types, ...mod.enums]) {
    if (!BUILTIN_TYPE_NAMES.has(decl.name)) continue;
    diags.push(diag('A089', 'error', mod.file, decl.loc, 'types.' + decl.name,
      'type ' + decl.name + ' shadows a builtin name',
      'rename the declaration, e.g. ' + decl.name.charAt(0).toUpperCase() + decl.name.slice(1) + ', and keep the builtin ' + decl.name + ' for its own meaning'));
  }
  // A090 — a lower bound above its upper bound admits nothing. Every caller
  // gets a 400, A060 rejects every default, and the schema still advertises
  // the type as usable: a typo in one of the two numbers is the whole cause.
  for (const root of typeRoots) {
    walkTypeExpr(root, (type) => {
      if (type.kind !== 'named') return;
      if (type.name !== 'int' && type.name !== 'number' && type.name !== 'float' && type.name !== 'string' && type.name !== 'bytes') return;
      let min: number | null = null;
      let max: number | null = null;
      for (const arg of type.args) {
        if (arg.value.kind !== 'literal' || typeof arg.value.value !== 'number') continue;
        if (arg.name === 'min') min = arg.value.value;
        if (arg.name === 'max') max = arg.value.value;
      }
      if (min === null || max === null || min <= max) return;
      diags.push(diag('A090', 'error', mod.file, type.loc, 'types.' + type.name,
        type.name + '(min: ' + min + ', max: ' + max + ') admits no value',
        'write min no greater than max'));
    });
  }


  for (const svc of mod.services) {
    if (svc.external) continue;
    const sourceSlice = mod.source.slice(svc.loc.offset, svc.loc.end);
    const aliases = new Set(svc.uses.map((u) => u.alias));

    // A003 — provider, host or secret mentioned in the model. Match whole
    // words only: `messages_mysql` is a service name, not a binding, and a
    // substring hit would make the name of your own module an error.
    for (const word of FORBIDDEN_IN_MODEL) {
      if (mentionsWord(sourceSlice, word)) {
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


    // A076 — a capability a provider declares can still have no effects and
    // no adapter (`uses analytics: olap` with clickhouse bound): the alias was
    // accepted, the container started, and the generated service knew nothing
    // about it. A plugin that ships signatures is the only other owner.
    for (const use of svc.uses) {
      const short = use.capability.includes('.') ? use.capability.split('.').pop()! : use.capability;
      if (capabilityFor(use.capability) !== null) continue;
      if (registry.signaturesFor(short).length > 0) continue;
      diags.push(diag('A076', 'error', mod.file, use.loc, `services.${svc.name}.uses.${use.alias}`,
        `capability ${short} has no effects and no adapter`,
        'a provider may declare it, but the generated service has nothing to call; remove the use, follow the provider through io.remote(endpoint), or install a plugin that declares its effects'));
    }

    // W033 — a `uses` parameter is a note for the reader unless an adapter
    // reads it. Today only `ttl` on a storage capability is executed (it sets
    // the record expiry); anything else — say `consistency: strong` — is
    // silently ignored, and silence reads as a guarantee.
    for (const use of svc.uses) {
      const capability = use.capability.includes('.') ? use.capability.split('.').pop()! : use.capability;
      const storage = capability === 'kv' || capability === 'sql';
      for (const name of Object.keys(use.params)) {
        if (storage && name === 'ttl') continue;
        diags.push(diag('W033', 'warning', mod.file, use.loc, `services.${svc.name}.uses.${use.alias}`,
          `parameter ${name} on uses ${use.alias} is declarative: nothing reads it`,
          storage
            ? 'storage reads only ttl; move provider options to bind(...)'
            : 'no adapter reads uses parameters; move provider options to bind(...)'));
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

    // A054 — unique names a field of a record type; A055 — a violation has a
    // declared error to return; A056 — uniqueness needs a store to hold the
    // claim, otherwise the rule would be decoration.
    for (const rule of svc.rules) {
      if (rule.kind !== 'unique') continue;
      const entity = rule.path.split('.')[0];
      const decl = mod.types.find((type) => type.name === entity);
      const record = decl && decl.type.kind === 'record' ? decl.type : null;
      const missing = record
        ? rule.fields.find((name) => !record.fields.some((item) => item.name === name))
        : rule.path;
      if (!record || missing || rule.fields.length === 0) {
        diags.push(diag('A054', 'error', mod.file, rule.loc, `services.${svc.name}.rules.unique`,
          `unique ${rule.path} does not name a field of a record type`,
          'declare type Task = { … } and write unique Task.title'));
        continue;
      }
      // A091 — a unique claim is a key. MySQL cannot index a JSON column at
      // all or a BLOB without a prefix, and Postgres has no equality operator
      // for json, so the migration failed only at apply time. A container or
      // bytes field cannot carry a unique rule; a scalar can.
      const unindexable = rule.fields
        .map((name) => record.fields.find((field) => field.name === name))
        .find((field) => field && ['bytes', 'json', 'list', 'map'].includes(baseType(mod, field.type)));
      if (unindexable) {
        const base = baseType(mod, unindexable.type);
        diags.push(diag('A091', 'error', mod.file, rule.loc, `services.${svc.name}.rules.unique`,
          `unique ${rule.path} names ${unindexable.name}, a ${base} field a key cannot index`,
          'use a scalar field (string, uuid, datetime, int, …): bytes and list/map/json have no unique key'));
      }
      if (!mod.errors.some((item) => item.name === 'Conflict')) {
        diags.push(diag('A055', 'error', mod.file, rule.loc, `services.${svc.name}.rules.unique`,
          `unique ${rule.path} has no declared error for a violation`,
          'add error Conflict; a second record with the same value returns 409'));
      }
      const storage = svc.uses.find((use) => ['kv', 'sql'].some((name) => use.capability === name || use.capability.endsWith('.' + name)));
      if (!storage) {
        diags.push(diag('A056', 'error', mod.file, rule.loc, `services.${svc.name}.rules.unique`,
          `unique ${rule.path} needs a store to keep the claim`,
          'add uses store: kv(…) or uses store: sql(…)'));
      }
    }


    // A064 — an on error expression names a member field the error does not
    // declare; A065 — every declared error field has to be filled by an on
    // error clause, otherwise the response would always omit it.
    for (const decl of mod.errors) {
      if (decl.fields.length === 0) continue;
      const declaredFields = new Set(decl.fields.map((field) => field.name));
      for (const op of svc.contract) {
        if (op.kind !== 'op') continue;
        const handled = op.clauses
          .filter((clause) => clause.kind === 'errors')
          .flatMap((clause) => (clause.kind === 'errors' ? clause.names : []));
        if (!handled.includes(decl.name)) continue;
        const filled = new Set<string>();
        for (const clause of op.clauses) {
          if (clause.kind !== 'onerror' || clause.error !== decl.name) continue;
          walkExpr(clause.expr, (expr) => {
            if (expr.kind === 'ident' && declaredFields.has(expr.name)) filled.add(expr.name);
            if (expr.kind !== 'member') return;
            if (declaredFields.has(expr.property)) {
              filled.add(expr.property);
              return;
            }
            if (expr.object.kind !== 'ident') return;
            diags.push(diag('A064', 'error', mod.file, expr.loc, `services.${svc.name}.contract.${op.name}.onerror`,
              `on error ${decl.name} names ${expr.object.name}.${expr.property}, which ${decl.name} does not declare`,
              'declare the field on the error or fill a declared one'));
          });
        }
        for (const field of decl.fields) {
          if (filled.has(field.name)) continue;
          diags.push(diag('A065', 'error', mod.file, decl.loc, `services.${svc.name}.contract.${op.name}.onerror`,
            `on error ${decl.name} does not fill field ${field.name}`,
            `write on error ${decl.name}: ${field.name} != null`));
        }
      }
    }

    // A062 — an index names a field of a record type, exactly like unique.
    // An index on a missing field would be a migration that fails at deploy
    // time, so it is caught where the model is read.
    for (const rule of svc.rules) {
      if (rule.kind !== 'index') continue;
      const parts = rule.path.split('.');
      const decl = parts.length === 2 ? mod.types.find((type) => type.name === parts[0]) : undefined;
      const field = decl && decl.type.kind === 'record'
        ? decl.type.fields.find((item) => item.name === parts[1])
        : undefined;
      if (!decl || decl.type.kind !== 'record' || !field) {
        diags.push(diag('A062', 'error', mod.file, rule.loc, `services.${svc.name}.rules.index`,
          `index ${rule.path} does not name a field of a record type`,
          'declare type Task = { … } and write index Task.dueAt'));
      }
    }

    // Collect capability calls from every expression in the service
    const uses = collectCapabilityUses(svc, aliases);

    // A022 — once(...) points at an error the operation does not declare
    for (const rule of svc.rules) {
      if (rule.kind !== 'invariant') continue;
      const once = asOnce(rule.expr);
      if (!once) {
        // W040 — the rule parses and the model is clean, but `arcod test` has
        // nothing to run: a typo (`oncee(read, ...)`) or a predicate v0.1 does
        // not execute turned the invariant into a comment. Say it out loud.
        diags.push(diag('W040', 'warning', mod.file, rule.expr.loc, `services.${svc.name}.rules.${rule.name}`,
          `invariant predicate ${exprLabel(rule.expr)} is not executed by arcod test`,
          'write the observation as once(op, by: field, else: Error); other predicates stay declarative'));
        continue;
      }
      if (!once.elseName) continue;
      const op = svc.contract.find((item) => item.kind === 'op' && item.name === once.target);
      if (op && !errorNames(op).includes(once.elseName)) {
        diags.push(diag('A022', 'error', mod.file, rule.loc, `services.${svc.name}.rules.${rule.name}`, `once(..., else: ${once.elseName}) refers to an error that is not in the ${once.target} contract`, 'add the error to errors or fix else'));
      }
    }

    // A081 — a rule names the operation it checks. `arcod test` resolves that
    // name at run time and answers "operation X not found" in the report, far
    // from the rule that has the typo. Declared op names are right here.
    const opNames = new Set(svc.contract.filter((item) => item.kind === 'op').map((item) => item.name));
    for (const rule of svc.rules) {
      if (rule.kind === 'invariant') {
        const once = asOnce(rule.expr);
        if (once && !opNames.has(once.target)) {
          diags.push(diag('A081', 'error', mod.file, rule.loc, `services.${svc.name}.rules.${rule.name}`,
            `once(${once.target}) names no operation of ${svc.name}`,
            'declare the operation in contract or fix the name'));
        }
      } else if (rule.kind === 'atomic' && !opNames.has(rule.name)) {
        diags.push(diag('A081', 'error', mod.file, rule.loc, `services.${svc.name}.rules`,
          `atomic ${rule.name} names no operation of ${svc.name}`,
          'declare the operation in contract or fix the name'));
      }
    }

    // W042 — a rule that needs a record identifier points at an operation with
    // no uuid parameter. The body plan keys takeIf/seen by that parameter, so
    // the rule degrades to nothing: the spec reads as a guarantee, the service
    // never takes or sees anything.
    for (const rule of svc.rules) {
      let target: string | null = null;
      if (rule.kind === 'invariant') target = asOnce(rule.expr)?.target ?? null;
      else if (rule.kind === 'atomic') target = rule.name;
      else continue;
      if (!target) continue;
      const op = svc.contract.find((item) => item.kind === 'op' && item.name === target);
      if (!op || op.params.some((param) => resolvesTo(mod, param.type, 'uuid'))) continue;
      diags.push(diag('W042', 'warning', mod.file, rule.loc, `services.${svc.name}.rules.${rule.name}`,
        `${rule.name} names ${target}, which has no uuid parameter; the rule has nothing to consume`,
        'give the operation an identifier parameter (uuid) or write the guarantee in the body'));
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

    // W048 — an operation names an effect that fails on someone else's side
    // and declares no error covering the refusal. The contract is the only
    // place errors are announced: an undeclared failure leaves the route to
    // the generic catch, where the caller reads 500 {error: Internal} with no
    // status and no message from the far side. The effect list is the body in
    // this language, so the warning anchors on that clause (B63). A warning,
    // not an error: a body may catch the failure and answer a result instead.
    // Jobs are out: a job has no error contract, and its failure lands in the
    // retry/dead-letter path rather than in a response body.
    // A hint may not name an error the module never declared: following it
    // would answer A078. Suggest one the module has, or say both steps.
    const moduleErrors = new Set(mod.errors.map((error) => error.name));
    const covering = FALLIBLE_ERRORS.filter((name) => moduleErrors.has(name));
    const coverHint = covering.length > 0
      ? 'add ' + covering[0] + ' to errors: '
      : 'declare error Unavailable, then add it to errors: ';
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const declared = new Set(errorNames(op));
      if (FALLIBLE_ERRORS.some((name) => declared.has(name))) continue;
      const reported = new Set<string>();
      for (const clause of op.clauses) {
        if (clause.kind !== 'effects') continue;
        for (const entry of clause.names) {
          const [alias, name] = entry.split('.');
          if (!name || reported.has(entry)) continue;
          const label = fallibleEffect(mod, svc, alias, name);
          if (!label) continue;
          reported.add(entry);
          diags.push(diag('W048', 'warning', mod.file, clause.loc, 'services.' + svc.name + '.contract.' + op.name + '.effects',
            op.name + ' calls ' + label + ', which can fail, and declares no error for it',
            coverHint + op.name + ' with an on error handler, or catch the failure in the body'));
        }
      }
    }

    // A044 — an allow/deny entry names an effect the capability does not
    // have. A typo (store.gett) used to be accepted and let nothing through,
    // so the guard looked configured while the operation still failed A004.
    if (svc.effects) {
      const aliasFor = new Map(svc.uses.map((use) => [use.alias, use.capability.includes('.') ? use.capability.split('.').pop()! : use.capability]));
      for (const [listName, entries] of [['allow', svc.effects.allow], ['deny', svc.effects.deny]] as const) {
        for (const entry of entries) {
          const [alias, name] = entry.split('.');
          if (!name || name === '*') continue; // native deny (net/fs/exec) has no dot
          // Another service's operation (an external call or a saga step) is
          // an effect too, and it is named Service.op, not alias.effect.
          const target = mod.services.find((item) => item.name === alias);
          if (target && target.contract.some((item) => item.name === name)) continue;
          const capability = aliasFor.get(alias);
          if (!capability) {
            diags.push(diag('A044', 'error', mod.file, svc.effects.loc, 'services.' + svc.name + '.effects.' + listName,
              'effect ' + entry + ' names alias ' + alias + ', which is not declared in uses',
              'declare the capability or fix the alias'));
            continue;
          }
          const spec = capabilityFor(capability);
          if (!spec) continue; // a plugin capability declares its own methods
          if (!(name in spec.effects)) {
            diags.push(diag('A044', 'error', mod.file, svc.effects.loc, 'services.' + svc.name + '.effects.' + listName,
              'effect ' + entry + ' does not exist in ' + capability,
              'known: ' + Object.keys(spec.effects).join(', ')));
          }
        }
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

    // W016 — deny entries the compiler cannot enforce in v0.1. Native denies
    // (net, fs, exec) are enforced: bodies are validated to have no imports,
    // no require, no raw network — the io capabilities are the only door.
    if (svc.effects) {
      const native = new Set(['net', 'fs', 'exec']);
      const unenforceable = svc.effects.deny.filter((item) => !item.includes('.') && !native.has(item));
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

    // A078 — an error name nothing declares. It would reach the emitter as a
    // handler target and an OpenAPI error, so a typo in `errors:` or
    // `on error` would silently invent an error; A007 would then call it
    // "declared but not handled", which is the wrong complaint.
    const declaredErrorNames = new Set(mod.errors.map((error) => error.name));
    for (const op of svc.contract) {
      for (const clause of op.clauses) {
        const names = clause.kind === 'errors' ? clause.names : clause.kind === 'onerror' ? [clause.error] : [];
        for (const name of names) {
          if (declaredErrorNames.has(name)) continue;
          const where = `services.${svc.name}.contract.${op.name}`;
          diags.push(diag('A078', 'error', mod.file, clause.loc, where,
            `unknown error ${name}: no error ${name} is declared`,
            declaredErrorNames.size > 0
              ? 'declared: ' + [...declaredErrorNames].join(', ')
              : 'declare it with `error ' + name + '`'));
        }
      }
    }

    // W039 — a handler for an error the contract does not list. Only `errors:`
    // reaches OpenAPI and the generated status map, so the fields filled by
    // `on error` would never be seen by a client.
    for (const op of svc.contract) {
      const listed = new Set(errorNames(op));
      for (const clause of op.clauses) {
        if (clause.kind !== 'onerror') continue;
        if (listed.has(clause.error)) continue;
        diags.push(diag('W039', 'warning', mod.file, clause.loc, `services.${svc.name}.contract.${op.name}.errors`,
          `on error ${clause.error} is not listed in errors: ${op.name}`,
          `add ${clause.error} to errors: or remove the handler`));
      }
    }

    // A007 — declared error is neither handled nor asserted
    const asserted = collectAssertedErrors(svc);
    const handled = collectHandledErrors(svc);
    for (const op of svc.contract) {
      if (op.kind === 'job') continue;
      for (const errorName of errorNames(op)) {
        if (!declaredErrorNames.has(errorName)) continue;
        if (!asserted.has(errorName) && !handled.has(errorName)) {
          diags.push(diag('A007', 'error', mod.file, op.loc, `services.${svc.name}.contract.${op.name}.errors`, `error ${errorName} is declared but not handled`, `add on error ${errorName} or an example with ${errorName}`));
        }
      }
    }

    // W018 — the spec has no body, so one has to come from outside
    const templated = svc.contract
      .filter((op) => op.kind === 'op' && templateFor(op.name))
      .filter((op) => !(options.impl && Object.prototype.hasOwnProperty.call(options.impl, op.name)))
      .map((op) => op.name);
    if (templated.length > 0) {
      diags.push(diag('W018', 'warning', mod.file, svc.loc, `services.${svc.name}`, 'operation bodies are not specified: ' + templated.join(', '), 'arcod impl generates them, build --reference substitutes a demo body, scaffold leaves a TODO'));
    }

    // A050 — a public operation is the external contract; without a route it
    // has no place in HTTP or OpenAPI, which usually means `public` is a typo.
    if (!svc.external) {
      for (const op of svc.contract) {
        if (op.kind !== 'op' || !op.isPublic) continue;
        if (!routeOf(op)) {
          diags.push(diag('A050', 'error', mod.file, op.loc, `services.${svc.name}.contract.${op.name}`, `public operation ${op.name} has no route`, 'add route: "VERB /path" or drop public'));
        }
      }
    }

    // A082 — an operation declares a singleton clause twice. The router,
    // OpenAPI, the auth guard and the generated client all read the first
    // clause, so the second is dead text that reads like a working endpoint
    // (`route`), a second role set (`roles`) or a second owner.
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      for (const kind of ['route', 'roles', 'owner'] as const) {
        const clauses = op.clauses.filter((clause) => clause.kind === kind);
        for (const extra of clauses.slice(1)) {
          diags.push(diag('A082', 'error', mod.file, extra.loc, `services.${svc.name}.contract.${op.name}.${kind}`,
            `${op.name} declares a second ${kind} clause; only the first one is emitted`,
            'keep one ' + kind + ' clause per operation'));
        }
      }
    }

    // W047 — a service declares a role no operation names. The vocabulary is
    // real (A047 rejects an undeclared role), so a role nobody uses reads like
    // an access rule that is enforced, and it is not.
    if (svc.roles.length > 0) {
      const named = new Set<string>();
      for (const op of svc.contract) {
        for (const clause of op.clauses) {
          if (clause.kind === 'roles') for (const role of clause.names) named.add(role);
        }
      }
      for (const role of svc.roles) {
        if (named.has(role)) continue;
        diags.push(diag('W047', 'warning', mod.file, svc.rolesLoc ?? svc.loc, `services.${svc.name}.roles`,
          `role ${role} is declared by the service but no operation names it`,
          'drop it, or add roles: ' + role + ' to an operation'));
      }
    }

    // A070 — a route is "METHOD /path". A bare path used to fall through to
    // GET with path "/" in OpenAPI and in the router, so the operation
    // answered a URL nobody wrote.
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const route = routeOf(op);
      if (!route) continue;
      const parts = route.trim().split(/\s+/);
      const wellFormed = parts.length === 2 && ROUTE_METHODS.has((parts[0] ?? '').toUpperCase()) && parts[1].startsWith('/');
      if (wellFormed) continue;
      diags.push(diag('A070', 'error', mod.file, op.loc, 'services.' + svc.name + '.contract.' + op.name,
        'route ' + JSON.stringify(route) + ' must be "METHOD /path" with a known method',
        'for example "GET /v1/tasks" or "POST /v1/tasks"'));
    }

    // A092 — /healthz and /metrics are answered by the runtime itself: the
    // probe and the scrape run before the router, so a declared route at that
    // path is never reached (the HEAD /healthz in the suite was answered by
    // the built-in probe, not by the operation). Name it instead of shadowing.
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const route = routeOf(op);
      if (!route) continue;
      const parts = route.trim().split(/\s+/);
      if (parts.length !== 2) continue;
      const path = parts[1];
      if (path !== '/healthz' && path !== '/metrics') continue;
      diags.push(diag('A092', 'error', mod.file, op.loc, 'services.' + svc.name + '.contract.' + op.name,
        'route ' + JSON.stringify(route) + ' is answered by the runtime ' + (path === '/healthz' ? 'health probe' : 'metrics endpoint') + ' before the router',
        'declare another path; the ' + (path === '/healthz' ? 'probe' : 'scrape') + ' stays at ' + path));
    }

    // A095 — a query parameter is one string on the wire: the service reads
    // searchParams.get(name), so a repeated name loses every value but the
    // first, and the harness sends String(value). A list or a map in a route
    // without a body therefore cannot round-trip, and the body receives a
    // string where the contract promised a list.
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const route = routeOf(op);
      if (!route) continue;
      const parts = route.trim().split(/\s+/);
      if (parts.length !== 2) continue;
      const method = parts[0].toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') continue;
      const captures = new Set(Array.from(parts[1].matchAll(/:([A-Za-z0-9_]+)/g)).map((match) => match[1]));
      for (const param of op.params) {
        if (captures.has(param.name)) continue;
        const shape = containerShape(mod, param.type);
        if (!shape) continue;
        diags.push(diag('A095', 'error', mod.file, param.loc, 'services.' + svc.name + '.contract.' + op.name + '.' + param.name,
          'query parameter ' + param.name + ' is a ' + shape + ', and ' + method + ' has no body',
          'send it in a POST body, or narrow the parameter to one scalar'));
      }
    }

    // A071 — every :name in the route has to be an operation parameter. A
    // typo (:tid instead of id) captures a value nobody reads and leaves the
    // argument unbound, and the runtime has nothing to report.
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const route = routeOf(op);
      if (!route) continue;
      const path = route.trim().split(/\s+/)[1] ?? "";
      const names = path.split("/").filter((segment) => segment.startsWith(":")).map((segment) => segment.slice(1));
      if (names.length === 0) continue;
      for (const name of names) {
        if (op.params.some((param) => param.name === name)) continue;
        diags.push(diag('A071', 'error', mod.file, op.loc, 'services.' + svc.name + '.contract.' + op.name,
          'route parameter :' + name + ' is not an argument of ' + op.name,
          'rename the path segment or declare ' + name + ' as a parameter'));
      }
    }

    // A074 — a query string or fragment in a route path. The router matches
    // url.pathname, which never carries either, so "GET /v1/x?limit=10" is a
    // URL nobody can request; the client's ?limit=10 belongs in a parameter.
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const route = routeOf(op);
      if (!route) continue;
      const path = route.trim().split(/\s+/)[1] ?? '';
      const mark = path.includes('?') ? '?' : path.includes('#') ? '#' : null;
      if (mark === null) continue;
      diags.push(diag('A074', 'error', mod.file, op.loc, 'services.' + svc.name + '.contract.' + op.name,
        'route ' + JSON.stringify(route) + ' carries a query string or fragment: the router matches the path only',
        'declare the value as a parameter instead of ' + mark));
    }

    // A075 — an OpenAPI-style {name} capture in a route. Arcod spells a
    // capture :name, so a hand-copied path is a literal segment with braces:
    // the declared parameter is never bound and the operation answers a URL
    // nobody meant to expose.
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const route = routeOf(op);
      if (!route) continue;
      const path = route.trim().split(/\s+/)[1] ?? '';
      const braces = path.split('/').filter((segment) => /^\{[^{}]+\}$/.test(segment));
      if (braces.length === 0) continue;
      const name = braces[0].slice(1, -1);
      diags.push(diag('A075', 'error', mod.file, op.loc, 'services.' + svc.name + '.contract.' + op.name,
        'route ' + JSON.stringify(route) + ' uses OpenAPI capture syntax {' + name + '}: arcod spells it :' + name,
        'write :' + name + ' — `arcod adopt` converts an OpenAPI document for you'));
    }

    // A072 — the same :name twice in one route. matchRoute assigns captures
    // in segment order, so the last segment wins and the earlier value is read
    // by nobody: "/v1/locks/:name/:name" matches "/v1/locks/a/b" and the body
    // sees name = "b". A two-segment key needs two names, and a repeated one
    // is almost always a copy-paste slip in the route.
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const route = routeOf(op);
      if (!route) continue;
      const path = route.trim().split(/\s+/)[1] ?? "";
      const seen = new Set<string>();
      const reported = new Set<string>();
      for (const segment of path.split("/")) {
        if (!segment.startsWith(":")) continue;
        const name = segment.slice(1);
        if (!seen.has(name)) { seen.add(name); continue; }
        if (reported.has(name)) continue;
        reported.add(name);
        diags.push(diag('A072', 'error', mod.file, op.loc, 'services.' + svc.name + '.contract.' + op.name,
          'route parameter :' + name + ' appears twice in ' + JSON.stringify(route),
          'keep one segment: the router binds the last capture, so the earlier one is dropped'));
      }
    }

    // A069 — two operations of one service answer the same method and path.
    // The generated router keeps the first and the second is unreachable, and
    // nothing else would report it. The method is compared case-insensitively,
    // and the path is compared the way matchRoute reads it: empty segments are
    // dropped ("/v1/x/" and "/v1/x" are one route) and a capture is a position,
    // not a name ("/v1/t/:id" and "/v1/t/:tid" are one route). Static segments
    // stay case-sensitive: /v1/x and /v1/X are two different routes.
    if (!svc.external) {
      const routes = new Map<string, string>();
      for (const op of svc.contract) {
        if (op.kind !== 'op') continue;
        const route = routeOf(op);
        if (!route) continue;
        const parts = route.trim().split(/\s+/);
        const pathKey = '/' + parts.slice(1).join(' ').split('/')
          .filter((segment) => segment.length > 0)
          .map((segment) => (segment.startsWith(':') ? ':' : segment))
          .join('/');
        const key = (parts[0] ?? '').toUpperCase() + ' ' + pathKey;
        const first = routes.get(key);
        if (first !== undefined) {
          diags.push(diag('A069', 'error', mod.file, op.loc, 'services.' + svc.name + '.contract.' + op.name,
            svc.name + '.' + op.name + ' answers the same route as ' + svc.name + '.' + first + ': ' + route,
            'give one of them a distinct method or path, or use one parameter name for the same segment'));
          continue;
        }
        routes.set(key, op.name);
      }
    }

    // A073 — a literal route declared after a matching capture route never
    // runs: matchRoute walks ROUTES in declaration order and a capture segment
    // accepts anything, so "GET /v1/t/:id" answers "/v1/t/new" before the
    // literal operation is even compared. A069 cannot see it because the two
    // patterns are different; the operation just answers nothing, ever.
    if (!svc.external) {
      const ordered: Array<{ op: string; method: string; segments: string[] }> = [];
      for (const op of svc.contract) {
        if (op.kind !== 'op') continue;
        const route = routeOf(op);
        if (!route) continue;
        const parts = route.trim().split(/\s+/);
        const method = (parts[0] ?? '').toUpperCase();
        const segments = parts.slice(1).join(' ').split('/').filter((segment) => segment.length > 0);
        const shadow = ordered.find((prev) =>
          prev.method === method &&
          prev.segments.length === segments.length &&
          prev.segments.every((segment, i) => segment.startsWith(':') || segment === segments[i]) &&
          segments.some((segment, i) => !segment.startsWith(':') && prev.segments[i].startsWith(':')));
        if (shadow) {
          diags.push(diag('A073', 'error', mod.file, op.loc, 'services.' + svc.name + '.contract.' + op.name,
            svc.name + '.' + op.name + ' can never run: ' + svc.name + '.' + shadow.op + ' answers the same requests first: ' + route,
            'declare the literal route before the capture route, or give it a segment the capture cannot match'));
        }
        ordered.push({ op: op.name, method, segments });
      }
    }

    // Access control: `auth`, `roles:` and `owner:` are enforced by the
    // generated runtime before the body runs, so the model has to be sound.
    const identityAliases = svc.uses
      .filter((use) => use.capability === 'identity' || use.capability.endsWith('.identity'))
      .map((use) => use.alias);
    const rolesClause = (op: OpNode) => op.clauses.find((c) => c.kind === 'roles');
    const ownerClause = (op: OpNode) => op.clauses.find((c) => c.kind === 'owner');
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const roles = rolesClause(op);
      const owner = ownerClause(op);
      const guarded = op.auth || roles || owner;

      // A046 — a guarded operation needs an actor source
      if (guarded && identityAliases.length === 0) {
        diags.push(diag('A046', 'error', mod.file, op.loc, `services.${svc.name}.contract.${op.name}`,
          `operation ${op.name} is guarded but the service has no identity capability`, 'add uses auth: identity — tokens are verified by the provider, roles come from the token'));
      }

      // A047 — a role must exist in the service role vocabulary
      if (roles && roles.kind === 'roles') {
        for (const role of roles.names) {
          if (!svc.roles.includes(role)) {
            diags.push(diag('A047', 'error', mod.file, roles.loc, `services.${svc.name}.contract.${op.name}.roles`,
              `role ${role} is not declared by the service`, 'add roles: ' + role + ' to ' + svc.name + ' or fix the typo'));
          }
        }
      }

      // A048 — a public operation must not require an actor
      if (op.isPublic) {
        if (roles || owner) {
          diags.push(diag('A048', 'error', mod.file, op.loc, `services.${svc.name}.contract.${op.name}`,
            `public operation ${op.name} requires an actor`, 'declare it `auth op` or drop the roles/owner clause'));
        } else {
          const clause = op.clauses.find((c) => c.kind === 'effects');
          const names = clause && clause.kind === 'effects' ? clause.names : [];
          const usesActor = names.some((entry) => identityAliases.includes(entry.split('.')[0]));
          if (usesActor) {
            diags.push(diag('A048', 'error', mod.file, op.loc, `services.${svc.name}.contract.${op.name}`,
              `public operation ${op.name} uses the actor and stays public by accident`, 'declare it `auth op`; resource-level visibility checks stay in the body'));
          }
        }
      }

      // A049 — owner must name a real parameter
      if (owner && owner.kind === 'owner' && !op.params.some((param) => param.name === owner.param)) {
        diags.push(diag('A049', 'error', mod.file, owner.loc, `services.${svc.name}.contract.${op.name}.owner`,
          `owner references unknown parameter ${owner.param}`, 'use one of: ' + op.params.map((param) => param.name).join(', ')));
      }
    }

    // W017 — jobs are parsed but not executable in v0.1, unless a queue
    // consumer is declared: `job ... { on: alias.topic }` runs for real.
    for (const op of svc.contract) {
      if (op.kind !== 'job') continue;
      if (op.clauses.some((clause) => clause.kind === 'consume')) continue;
      diags.push(diag('W017', 'warning', mod.file, op.loc, `services.${svc.name}.contract.${op.name}`, `job ${op.name} is not executed in v0.1`, 'no state model or selection condition; TTL is a provider guarantee'));
    }

    // Queue consumers: `on: alias.topic` turns a job into a consumer the
    // runtime starts and stops with the service. The wiring lives here, in
    // the model, so the body stays a plain function of the message.
    for (const op of svc.contract) {
      const consume = op.clauses.find((clause) => clause.kind === 'consume');
      const retry = op.clauses.find((clause) => clause.kind === 'retry');
      if (op.kind !== 'job' && consume) {
        diags.push(diag('A051', 'error', mod.file, consume.loc, `services.${svc.name}.contract.${op.name}`,
          `only a job can consume a queue, not ${op.kind} ${op.name}`, 'make it a job or drop the on: clause'));
        continue;
      }
      if (!consume) {
        if (retry) {
          diags.push(diag('A053', 'error', mod.file, retry.loc, `services.${svc.name}.contract.${op.name}`,
            `retry on ${op.name} has no effect without on: alias.topic`, 'add a queue consumer or drop retry'));
        }
        continue;
      }
      const source = consume.kind === 'consume' ? consume.source : '';
      const [alias] = source.split('.');
      const use = svc.uses.find((item) => item.alias === alias);
      const cap = use && (use.capability.includes('.') ? use.capability.split('.').pop()! : use.capability);
      if (!use || cap !== 'queue') {
        diags.push(diag('A052', 'error', mod.file, consume.loc, `services.${svc.name}.contract.${op.name}`,
          `consumer source ${source} is not a declared queue`, 'add uses ' + alias + ': queue to ' + svc.name));
      }
    }

    // A063 — an example argument that cannot match the parameter
    checkExampleArguments(mod, svc, diags);

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

  // A040 — one module builds one page: a second ui is silently unreachable,
  // so it is an error while the emitters still read uis[0].
  if (mod.uis.length > 1) {
    for (const extra of mod.uis.slice(1)) {
      diags.push(diag('A040', 'error', mod.file, extra.loc, 'ui.' + extra.name,
        'only one ui is emitted per module; ' + mod.uis[0].name + ' is the page',
        'merge this ui into ' + mod.uis[0].name + ' or split the module'));
    }
  }

  // A018 — ui references an operation that does not exist
  for (const ui of mod.uis) {
    // A042 — slides are a presentation feature. Any other layout drops them,
    // so the author's text never reaches the browser; say so at the slides.
    if (ui.slides.length > 0 && ui.layout !== 'presentation') {
      diags.push(diag('A042', 'error', mod.file, ui.slides[0].loc, 'ui.' + ui.name + '.slides',
        'slides are only rendered by layout: presentation',
        'add layout: presentation or move the text into the page'));
    }
    // W030 — ssr without a first screen to render is a page that only looks
    // server-rendered: nothing can be fetched without input at request time.
    if (ui.render === 'ssr' && (ui.layout === null || ui.layout === 'forms') && !ssrDataOp(mod, ui)) {
      diags.push(diag('W030', 'warning', mod.file, ui.loc, 'ui.' + ui.name,
        'render: ssr has no first-screen data: no public GET operation takes no path parameter',
        'add a parameterless GET operation or use render: static'));
    }
    if (ui.impl !== 'spa') {
      diags.push(diag('A019', 'error', mod.file, ui.loc, 'ui.' + ui.name, 'ui kind ' + ui.impl + ' is not supported in v0.1', 'use kind: spa'));
    }
    // A043 — every layout reads its own clauses. A clause written for another
    // layout used to parse and be ignored, so the page lost the author's link
    // between the markup and an operation without a word.
    const layoutClauses: Array<[keyof UiNode & ('history' | 'send' | 'start' | 'join' | 'state' | 'advance'), string[]]> = [
      ['history', ['chat']], ['send', ['chat']],
      ['start', ['chat', 'presentation']],
      ['join', ['presentation']], ['state', ['presentation']], ['advance', ['presentation']],
    ];
    for (const [key, layouts] of layoutClauses) {
      const ref = ui[key];
      if (!ref || layouts.includes(ui.layout ?? 'forms')) continue;
      const loc = ui.clauseLocs?.[key] ?? ui.loc;
      diags.push(diag('A043', 'error', mod.file, loc, 'ui.' + ui.name + '.' + key,
        key + ' is only read by layout: ' + layouts.join(' or '),
        'add layout: ' + layouts[0] + ' or remove the clause'));
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

    // A040 — a presentation has two audiences (host and guests); each
    // capability must name its operation instead of guessing.
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
  checkSagas(mod, diags);
  checkEntityLiterals(mod, diags, options.impl);
  checkWhereOperators(mod, diags, options.impl);
  checkImplCollisions(mod, diags, options.impl);
  checkImplSignatures(mod, diags, options.impl);
  checkOrphanImplBodies(mod, diags, options.impl);
  checkIgnoredImplBodies(mod, diags, options.implIgnored);
  checkMissingImplBodies(mod, diags, options.impl);

  return sortDiagnostics(diags);
}

// Two impl/*.mjs bodies are concatenated into one module, so a helper declared
// in both files is a SyntaxError that only the container sees. The build already
// refused it; the check has the same bodies in hand, so it names both files
// before anyone starts a build.
export function checkImplCollisions(mod: ModuleNode, diags: Diagnostic[], impl: Record<string, string> | undefined): void {
  if (!impl) return;
  for (const collision of implCollisions(impl)) {
    diags.push(
      diag('A093', 'error', collision.file, { ...mod.loc, line: collision.line, endLine: collision.line }, 'impl.' + collision.op,
        'duplicate top-level name "' + collision.name + '" in ' + collision.firstFile + ' and ' + collision.file,
        'rename one of them, or keep the shared helper in one body and pass it in'),
    );
  }
}

// A body file is keyed by the operation it implements: impl/totals.mjs is the
// body of totals. The emitter only bundles a body whose name is in the service
// contract, so impl/total.mjs (a typo) was loaded, sandbox-checked and then
// dropped, while totals answered 501 NotImplemented at request time and the
// author believed the body was in use. A file that names nothing is dead
// weight, so it is a warning that lists the names the contract declares.
export function checkOrphanImplBodies(mod: ModuleNode, diags: Diagnostic[], impl: Record<string, string> | undefined): void {
  if (!impl) return;
  const declared = new Set<string>();
  for (const svc of mod.services) for (const op of svc.contract) declared.add(op.name);
  for (const name of Object.keys(impl).sort()) {
    if (declared.has(name)) continue;
    diags.push(
      diag('W049', 'warning', 'impl/' + name + '.mjs', { ...mod.loc, line: 1, col: 1, endLine: 1, endCol: 1 }, 'impl.' + name,
        'impl/' + name + '.mjs matches no operation',
        declared.size > 0
          ? 'name the file after the operation it implements: ' + [...declared].sort().join(', ')
          : 'this module declares no operations, so no body file is bundled'),
    );
  }
}

// The other half of W049: the typo file is refused as an orphan, and the
// operation it was meant for used to say nothing at all. An operation with no
// bundled body answers 501 NotImplemented at request time, which reads like a
// server bug from the client's side. An external service describes someone
// else's API and a saga job is orchestrated by its steps, so neither owns a
// body here.
export function checkMissingImplBodies(mod: ModuleNode, diags: Diagnostic[], impl: Record<string, string> | undefined): void {
  if (!impl) return;
  for (const svc of mod.services) {
    if (svc.external) continue;
    for (const op of svc.contract) {
      if (impl[op.name]) continue;
      if (op.clauses.some((clause) => clause.kind === 'saga')) continue;
      diags.push(
        diag('W050', 'warning', mod.file, op.loc, 'services.' + svc.name + '.ops.' + op.name,
          'operation ' + op.name + ' has no body in impl/',
          'add impl/' + op.name + '.mjs, or the route answers 501 NotImplemented'),
      );
    }
  }
}

// readImpl lists impl/ but bundles only *.mjs, so a body saved as impl/totals.js
// was dropped without a word: check saw no body for totals, and the only hint was
// a 501 at request time. The file is not the body the build reads, so this is a
// warning that names it and the extension the build accepts.
export function checkIgnoredImplBodies(mod: ModuleNode, diags: Diagnostic[], ignored: string[] | undefined): void {
  if (!ignored) return;
  for (const file of ignored) {
    diags.push(
      diag('W051', 'warning', 'impl/' + file, { ...mod.loc, line: 1, col: 1, endLine: 1, endCol: 1 }, 'impl.' + file,
        'impl/' + file + ' is not a .mjs body and is not bundled',
        'rename it to impl/<operation>.mjs: the build reads only .mjs bodies'),
    );
  }
}

// The emitter bundles a body as `async function impl<Op>(input, io)` and calls
// it with (input, io). A body written as `function totals(io)` is valid JS and
// passes build, then answers 500 `io.aggregate is not a function` at request
// time because the single parameter is the input (issue #34). The build reads
// the same bodies, so the check names the file before a container starts.
export function checkImplSignatures(mod: ModuleNode, diags: Diagnostic[], impl: Record<string, string> | undefined): void {
  if (!impl) return;
  for (const problem of implSignatureProblems(impl)) {
    diags.push(
      diag('A096', 'error', problem.file, { ...mod.loc, line: problem.line, col: 1, endLine: problem.line, endCol: 1 },
        'impl.' + problem.op, problem.message, problem.hint),
    );
  }
}

// A body names an entity by a string literal, and the runtime answers an
// unknown one with a 500 only when the request arrives. The declared record
// types are the vocabulary, so a typo is a warning here with the literal, its
// body file and every name the store actually knows.
const ENTITY_CALL = /\bio\.(?:insert|fetch|update|remove|find)\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g;

export function checkEntityLiterals(mod: ModuleNode, diags: Diagnostic[], impl: Record<string, string> | undefined): void {
  if (!impl) return;
  const records = new Map(mod.types.filter((decl) => decl.type.kind === 'record').map((decl) => [decl.name, decl]));
  const entities = [...records.keys()];
  if (entities.length === 0) return;
  for (const op of Object.keys(impl).sort()) {
    for (const match of impl[op].matchAll(ENTITY_CALL)) {
      const name = match[2];
      const line = impl[op].slice(0, match.index).split('\n').length;
      if (!records.has(name)) {
        diags.push(diag('W036', 'warning', 'impl/' + op + '.mjs', { ...mod.loc, line, endLine: line }, 'impl.' + op,
          'unknown entity "' + name + '"; declared: ' + entities.join(', '),
          'rename the literal to a declared record type'));
        continue;
      }
      // W037 — insert needs a key. A record type without `id` looks legal in
      // the spec but every insert of it is a 400 at runtime, so the check
      // names the type and the field before the request is ever sent.
      if (!match[0].startsWith('io.insert')) continue;
      const decl = records.get(name)!;
      if (decl.type.kind === 'record' && !decl.type.fields.some((field) => field.name === 'id')) {
        diags.push(diag('W037', 'warning', 'impl/' + op + '.mjs', { ...mod.loc, line, endLine: line }, 'impl.' + op,
          'insert ' + name + ': the type has no id field',
          'add id: string (or a uuid) to the record, or give io.insert a natural key'));
      }
    }
  }
}

// W038 — `where` is a mini-language of names, and an unknown operator used to
// be dropped silently: `{ nextAt: { before: now } }` returned every row and
// looked like a working filter. The body is JS, so the check reads the literal
// the same way it reads entity names: find `where: {`, match its braces, then
// read the nested field conditions.
const WHERE_OPERATORS = new Set(['eq', 'ne', 'in', 'contains', 'gt', 'gte', 'lt', 'lte']);

function whereObjectEnd(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

export function checkWhereOperators(mod: ModuleNode, diags: Diagnostic[], impl: Record<string, string> | undefined): void {
  if (!impl) return;
  const newline = String.fromCharCode(10);
  for (const op of Object.keys(impl).sort()) {
    const text = impl[op];
    for (const found of text.matchAll(/\bwhere\s*:\s*\{/g)) {
      const open = (found.index ?? 0) + found[0].length - 1;
      const body = text.slice(open + 1, whereObjectEnd(text, open));
      for (const field of body.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\{([^{}]*)\}/g)) {
        const cond = field[2];
        for (const operator of cond.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)) {
          const name = operator[1];
          if (WHERE_OPERATORS.has(name)) continue;
          const offset = open + 1 + (field.index ?? 0) + (operator.index ?? 0);
          const line = text.slice(0, offset).split(newline).length;
          diags.push(diag('W038', 'warning', 'impl/' + op + '.mjs', { ...mod.loc, line, endLine: line }, 'impl.' + op,
            'unknown where operator "' + name + '"',
            'where operators are eq, ne, in, contains, gt, gte, lt, lte'));
        }
      }
    }
  }
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
        'add trigger cron("...") | event(...) | manual | after 30s | at("2026-11-18T12:00:05Z")'));
    } else if (!['cron', 'event', 'manual', 'after', 'at'].includes(wf.trigger.kind)) {
      diags.push(diag('A033', 'error', mod.file, wf.trigger.loc, path + '.trigger',
        'unknown trigger ' + wf.trigger.kind, 'cron, event, manual, after, at'));
    } else if (wf.trigger.kind === 'cron' && wf.trigger.args.length === 0) {
      diags.push(diag('A033', 'error', mod.file, wf.trigger.loc, path + '.trigger',
        'cron without an expression', 'cron("0 3 * * *", tz: "Europe/Moscow")'));
    } else if (wf.trigger.kind === 'at') {
      // A034 — a one-shot start is only useful with a real instant. The
      // manifest carries it verbatim, so a typo would reach a runner and
      // schedule nothing; reject it at the door while the spec is in hand.
      const only = wf.trigger.args.length === 1 ? wf.trigger.args[0] : null;
      if (!only || only.name) {
        diags.push(diag('A034', 'error', mod.file, wf.trigger.loc, path + '.trigger',
          'at needs exactly one positional instant',
          'trigger at("2026-11-18T12:00:05Z") or trigger at(2026-11-18T12:00:05Z)'));
      } else if (only.value.kind !== 'literal' || typeof only.value.value !== 'string') {
        diags.push(diag('A034', 'error', mod.file, wf.trigger.loc, path + '.trigger',
          'at expects an ISO-8601 instant, got ' + valueLabel(only.value),
          'trigger at("2026-11-18T12:00:05Z")'));
      } else if (!isIsoInstant(only.value.value)) {
        diags.push(diag('A034', 'error', mod.file, wf.trigger.loc, path + '.trigger',
          'at(' + JSON.stringify(only.value.value) + ') is not an ISO-8601 instant with a time zone',
          'use YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DDTHH:MM:SS+HH:MM'));
      }
    } else if (wf.trigger.kind === 'after') {
      // A034 — a delay needs a positive duration; `after Job` (wait for a
      // job) stays valid and is checked by W023-style name lookup elsewhere.
      const only = wf.trigger.args.length === 1 ? wf.trigger.args[0] : null;
      if (!only) {
        diags.push(diag('A034', 'error', mod.file, wf.trigger.loc, path + '.trigger',
          'after needs exactly one job name or duration',
          'trigger after 30s | trigger after Cleanup'));
      } else if (only.value.kind === 'duration') {
        if (!TRIGGER_UNITS.includes(only.value.unit)) {
          diags.push(diag('A034', 'error', mod.file, wf.trigger.loc, path + '.trigger',
            'unknown duration unit ' + JSON.stringify(only.value.unit),
            'use ' + TRIGGER_UNITS.join(', ')));
        } else if (!(only.value.value > 0)) {
          diags.push(diag('A034', 'error', mod.file, wf.trigger.loc, path + '.trigger',
            'after ' + only.value.value + only.value.unit + ' is not a positive delay',
            'the delay must be greater than zero'));
        }
      } else if (only.value.kind !== 'ident' && only.value.kind !== 'member') {
        diags.push(diag('A034', 'error', mod.file, wf.trigger.loc, path + '.trigger',
          'after expects a duration or a job name, got ' + valueLabel(only.value),
          'trigger after 30s | trigger after Cleanup'));
      }
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

// Sagas are executed by the runtime, so the checks are about resolvability:
// every step's call and compensate must point at a real operation — an own op
// (unqualified name) or an external service op (qualified). A job's 'saga:'
// clause must name a declared saga.
function checkSagas(mod: ModuleNode, diags: Diagnostic[]): void {
  const knownOps = new Set<string>();
  for (const svc of mod.services) {
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      knownOps.add(svc.name + '.' + op.name);
    }
  }

  for (const svc of mod.services) {
    if (svc.external) continue;
    const sagaNames = new Set(svc.sagas.map((s) => s.name));
    for (const saga of svc.sagas) {
      const path = 'services.' + svc.name + '.sagas.' + saga.name;
      // Unqualified = own op, qualified = external service op.
      const qualify = (name: string): string => name.includes('.') ? name : svc.name + '.' + name;
      for (const step of saga.steps) {
        if (!step.call) {
          diags.push(diag('A057', 'error', mod.file, step.loc, path + '.steps.' + step.name,
            'a saga step needs a call', 'add call: <op> or call: <Service>.<op>'));
        } else if (!knownOps.has(qualify(step.call))) {
          diags.push(diag('A057', 'error', mod.file, step.loc, path + '.steps.' + step.name,
            'saga step calls unknown operation ' + step.call,
            'an unqualified name must be an own op; a qualified one an external service op'));
        }
        if (step.compensate && !knownOps.has(qualify(step.compensate))) {
          diags.push(diag('A057', 'error', mod.file, step.loc, path + '.steps.' + step.name,
            'saga step compensates with unknown operation ' + step.compensate,
            'the compensation must reference an existing operation'));
        }
      }
    }
    for (const op of svc.contract) {
      if (op.kind !== 'job') continue;
      const sagaClause = op.clauses.find((c) => c.kind === 'saga');
      if (sagaClause && sagaClause.kind === 'saga' && !sagaNames.has(sagaClause.name)) {
        diags.push(diag('A058', 'error', mod.file, sagaClause.loc, 'services.' + svc.name + '.contract.' + op.name,
          'job runs undeclared saga ' + sagaClause.name, 'declare saga ' + sagaClause.name + ' in this service'));
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

// Every place a type expression can appear as a field of the model. Used by
// checks that care about the type itself rather than the layer it sits in.
function declaredParams(mod: ModuleNode): Param[] {
  const params: Param[] = [];
  for (const decl of mod.types) {
    if (decl.type.kind === 'record') params.push(...decl.type.fields);
  }
  for (const err of mod.errors) params.push(...err.fields);
  for (const svc of mod.services) {
    for (const op of svc.contract) {
      if (op.kind === 'op') params.push(...op.params);
    }
  }
  return params;
}

function namedType(type: { kind: string; name?: string }): string | null {
  return type.kind === 'named' && typeof type.name === 'string' ? type.name : null;
}

// The container a type expression resolves to, following an alias: `list<T>` and
// `map<K, V>` are one string in a query dict, and `type Tags = list<string>`
// is the same shape under another name.
const CONTAINER_TYPES = new Set(['list', 'map']);

function containerShape(mod: ModuleNode, type: TypeExpr, depth = 0): string | null {
  if (depth > 8) return null;
  if (type.kind === 'optional') return containerShape(mod, type.inner, depth + 1);
  if (type.kind !== 'named') return null;
  if (CONTAINER_TYPES.has(type.name)) return type.name;
  const decl = mod.types.find((entry) => entry.name === type.name);
  return decl ? containerShape(mod, decl.type, depth + 1) : null;
}

function walkTypeExpr(type: TypeExpr, fn: (type: TypeExpr) => void): void {
  fn(type);
  if (type.kind === 'optional') walkTypeExpr(type.inner, fn);
  else if (type.kind === 'union') for (const variant of type.variants) walkTypeExpr(variant, fn);
  else if (type.kind === 'record') for (const field of type.fields) walkTypeExpr(field.type, fn);
  else if (type.kind === 'named') for (const arg of type.args) if (arg.isType) walkTypeExpr(arg.value as TypeExpr, fn);
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

// A predicate as a reader would write it back: `oncee(...)`, `read`, or a
// neutral phrase for shapes with no short name. Used in diagnostics only.
// Mirrors plan-body's resolveType: follow user type aliases to the builtin a
// parameter finally names. Optional wrapping is transparent.
function resolvesTo(mod: ModuleNode, type: TypeExpr, builtin: string): boolean {
  let current: TypeExpr = type;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.kind === 'optional') { current = current.inner; continue; }
    if (current.kind !== 'named') return false;
    const name: string = current.name;
    if (name === builtin) return true;
    const decl = mod.types.find((item) => item.name === name);
    if (!decl) return false;
    current = decl.type;
  }
  return false;
}

function exprLabel(expr: Expr): string {
  if (expr.kind === 'call' && expr.callee.kind === 'ident') return expr.callee.name + '(...)';
  if (expr.kind === 'ident') return expr.name;
  return 'this expression';
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
    if (!op) {
      diags.push(diag('A018', 'error', mod.file, ui.loc, where, 'ui references a nonexistent operation ' + ref));
      return false;
    }
    // The operation exists but has no route: the page cannot call it, and
    // calling it "nonexistent" would send the reader looking for a typo.
    if (!routeOf(op)) {
      diags.push(diag('A018', 'error', mod.file, ui.loc, where, 'operation ' + ref + ' without a route cannot be called from ui'));
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

  if (ui.slides.length === 0) {
    diags.push(diag('A041', 'error', mod.file, ui.loc, where, 'the presentation has no slides',
      'add slide "Title" { ... }'));
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
}

function routeOf(op: OpNode): string | null {
  const clause = op.clauses.find((item) => item.kind === 'route');
  return clause && clause.kind === 'route' ? clause.value : null;
}

// The emitter merges every `errors:` clause on an operation (flatMap below in
// emit/service.ts), so check has to see the same list. Reading only the first
// clause made check report W039/A007/A078 for an error declared in the second
// one — diagnostics the generated service would never agree with.
function errorNames(op: OpNode): string[] {
  return op.clauses.flatMap((clause) => (clause.kind === 'errors' ? clause.names : []));
}

function isAllowed(allow: string[], alias: string, op: string): boolean {
  return allow.includes(alias + '.' + op) || allow.includes(alias + '.*');
}

function isDenied(deny: string[], alias: string, op: string): boolean {
  return deny.includes(alias + '.' + op) || deny.includes(alias + '.*') || deny.includes(alias);
}

// Errors that cover a failure on the far side of an effect: the service is
// unavailable, the provider throttles, or the caller is not allowed there.
const FALLIBLE_ERRORS = ['Unavailable', 'RateLimited', 'Forbidden'];

// An effect that fails on someone else's side. llm.chat and llm.embed call a
// model endpoint, and an external service is a call over the network; both can
// refuse with a status the generated runtime would otherwise turn into 500.
// Storage is deliberately out: any bind may be remote (a host argument says
// nothing about reachability), so warning on store.set would fire on nearly
// every write and drown the cases a reader cannot predict.
function fallibleEffect(mod: ModuleNode, svc: ServiceNode, alias: string, op: string): string | null {
  if (mod.services.some((item) => item.external && item.name === alias)) return alias + '.' + op;
  const use = svc.uses.find((item) => item.alias === alias);
  if (!use) return null;
  const capability = use.capability.includes('.') ? use.capability.split('.').pop()! : use.capability;
  if (capability === 'llm' && (op === 'chat' || op === 'embed')) return alias + '.' + op;
  return null;
}

function requiredEffects(svc: ServiceNode, op: OpNode): Array<{ alias: string; op: string }> {
  const kv = storageUse(svc)?.alias;
  const ids = svc.uses.find((use) => use.capability === 'ids' || use.capability.endsWith('.ids'))?.alias;
  const out: Array<{ alias: string; op: string }> = [];
  // An explicit effects list is the author's answer; guessing on top of it only
  // produced phantom requirements (create demanded store.set even when the body
  // used store.insert).
  if (op.clauses.some((clause) => clause.kind === 'effects')) return out;

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
    case 'list': for (const item of expr.items) walkExpr(item, fn); break;
    case 'record': for (const field of expr.fields) walkExpr(field.value, fn); break;
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
  // Parser represents a[0] as a call of member "[]" (see parser, index).
  // A list element is not a capability effect, but a local variable that
  // happens to share an alias name used to demand files.[] from allow.
  if (expr.callee.property === '[]') return null;
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

// A063 — an example passes a literal the parameter can never accept. Examples
// are executed by arcod test, but a wrong-shaped literal should be a
// diagnostic where it is written, not a confusing runtime failure.
function checkExampleArguments(mod: ModuleNode, svc: ServiceNode, diags: Diagnostic[]): void {
  const ops = new Map(svc.contract.map((op) => [op.name, op]));
  for (const example of svc.examples) {
    for (const stmt of [...example.given, ...example.when, ...example.then]) {
      const call = stmt.expr;
      if (call.kind !== 'call' || call.callee.kind !== 'ident') continue;
      const op = ops.get(call.callee.name);
      if (!op) {
        // A081 — `uuid(...)` is the one builtin an example may call; any other
        // name that is not an operation is a typo only `arcod test` would
        // report, as "unknown function" after the service has already started.
        if (call.callee.name !== 'uuid') {
          diags.push(diag('A081', 'error', mod.file, call.loc, 'services.' + svc.name + '.examples.' + example.name,
            `example ${example.name}: ${call.callee.name} is not an operation of ${svc.name}`,
            'call a declared operation, or uuid(...) for a literal id'));
        }
        continue;
      }
      const where = 'services.' + svc.name + '.contract.' + op.name;
      // A080 — the call and the operation disagree on how many arguments there
      // are. `arcod test` invokes by position, so an extra argument is simply
      // dropped and a missing one arrives as undefined: both are silent unless
      // the count is checked here. A trailing parameter with a default or an
      // optional type may be omitted.
      if (call.args.length > op.params.length) {
        diags.push(diag('A080', 'error', mod.file, call.loc, where,
          `example ${example.name}: ${op.name} takes ${op.params.length} argument(s), the call passes ${call.args.length}`,
          'an example call names every parameter by position; extra arguments are dropped'));
      } else {
        // W041 — a missing required argument. It may be deliberate (an example
        // that tests a missing body), so it is a warning, not an error; but the
        // call sends undefined and the reader should know before `arcod test`
        // turns it into a confusing 400.
        const missing = op.params.slice(call.args.length).find((param) => !param.default && param.type.kind !== 'optional');
        if (missing) {
          diags.push(diag('W041', 'warning', mod.file, call.loc, where,
            `example ${example.name}: ${op.name} is missing argument ${missing.name}, which arcod test sends as undefined`,
            'pass a value, or keep the omission if the example tests a missing field'));
        }
      }
      call.args.forEach((arg, index) => {
        const param = op.params[index];
        if (!param) return;
        const problem = exampleMismatch(param.type, arg.value, mod);
        if (!problem) return;
        diags.push(diag('A063', 'error', mod.file, arg.loc, where,
          'example ' + example.name + ': argument ' + (index + 1) + ' of ' + op.name + ': ' + problem));
      });
    }
  }
}

function typeLabel(type: TypeExpr): string {
  if (type.kind === 'named') {
    const args = type.args.filter((arg) => arg.isType).map((arg) => typeLabel(arg.value as TypeExpr));
    return type.name + (args.length > 0 ? '<' + args.join(', ') + '>' : '');
  }
  if (type.kind === 'optional') return typeLabel(type.inner) + '?';
  if (type.kind === 'union') return type.variants.map((variant) => typeLabel(variant)).join(' | ');
  return 'record';
}

function valueLabel(expr: Expr): string {
  if (expr.kind === 'literal') return expr.value === null ? 'null' : JSON.stringify(expr.value);
  if (expr.kind === 'list') return 'a list';
  if (expr.kind === 'record') return 'a record';
  if (expr.kind === 'duration') return 'a duration';
  return 'a computed value';
}

// Returns a complaint ("Member.age expects int, got "old"") or null. The label
// walks into the value, so the message points at the leaf that is wrong.
function exampleMismatch(type: TypeExpr, expr: Expr, mod: ModuleNode, label = ''): string | null {
  const at = label ? label + ' ' : '';
  if (type.kind === 'optional') {
    if (expr.kind === 'literal' && expr.value === null) return null;
    return exampleMismatch(type.inner, expr, mod, label);
  }
  if (type.kind === 'union') {
    for (const variant of type.variants) if (exampleMismatch(variant, expr, mod, label) === null) return null;
    return at + 'expects ' + typeLabel(type) + ', got ' + valueLabel(expr);
  }
  if (expr.kind === 'list') {
    if (type.kind !== 'named' || type.name !== 'list') return at + 'expects ' + typeLabel(type) + ', got a list';
    const element = type.args[0];
    if (!element || !element.isType) return null;
    for (let index = 0; index < expr.items.length; index++) {
      const inner = exampleMismatch(element.value as TypeExpr, expr.items[index], mod, typeLabel(type) + '[' + index + ']');
      if (inner) return inner;
    }
    return null;
  }
  if (expr.kind === 'record') {
    // Only a declared record type can judge a record literal; an unknown name is
    // somebody else's diagnostic, not this one.
    if (type.kind !== 'named') return null;
    const decl = mod.types.find((item) => item.name === type.name);
    if (!decl || decl.type.kind !== 'record') return null;
    for (const field of expr.fields) {
      const param = decl.type.fields.find((item) => item.name === field.name);
      if (!param) return type.name + ' has no field ' + field.name;
      const inner = exampleMismatch(param.type, field.value, mod, type.name + '.' + field.name);
      if (inner) return inner;
    }
    return null;
  }
  if (expr.kind !== 'literal') return null;
  if (expr.value === null) return at + 'expects ' + typeLabel(type) + ', got null';
  if (type.kind !== 'named') return null;
  if (type.name === 'list') return at + 'expects ' + typeLabel(type) + ', got ' + valueLabel(expr);
  const kind = typeof expr.value;
  const name = type.name.toLowerCase();
  const wants = name === 'string' || name === 'uuid' || name === 'url' || name === 'email' || name === 'datetime' ? 'string'
    : name === 'int' || name === 'number' || name === 'float' || name === 'decimal' ? 'number'
    : name === 'bool' ? 'boolean'
    : null;
  if (wants === null || kind === wants) return null;
  return at + 'expects ' + type.name + ', got ' + valueLabel(expr);
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
