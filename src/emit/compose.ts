import { kebab } from '../plan.ts';
import type { BindNode, EnvironmentNode, ModuleNode } from '../ast.ts';
import { providerFor, providerImplements, type ProviderSpec } from '../providers.ts';
import { storageKind } from '../capabilities.ts';
import { loadRegistry, type ProviderRegistry } from '../registry.ts';

export function serviceDockerfile(): string {
  return [
    'FROM node:24-alpine',
    'WORKDIR /app',
    'COPY index.mjs .',
    'ENV NODE_ENV=production',
    'EXPOSE 3000',
    'CMD ["node", "index.mjs"]',
    '',
  ].join('\n');
}

export function webDockerfile(): string {
  return [
    'FROM nginx:1.27-alpine',
    'COPY nginx.conf /etc/nginx/conf.d/default.conf',
    'COPY index.html /usr/share/nginx/html/index.html',
    'RUN chmod -R a+rX /usr/share/nginx/html',
    'EXPOSE 80',
    '',
  ].join('\n');
}

// Static prefix of a route: everything before the first :param segment.
// "GET /v1/api/messages/:id" becomes "/v1/api/messages".
export function routeRoot(route: string): string {
  const path = route.includes(' ') ? route.slice(route.indexOf(' ') + 1) : route;
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(':')) break;
    staticSegments.push(segment);
  }
  return '/' + staticSegments.join('/');
}

export function nginxConf(mod: ModuleNode): string {
  const roots = [...new Set(mod.services.flatMap((svc) => svc.contract
    .filter((op) => op.kind === 'op')
    .flatMap((op) => op.clauses.filter((clause) => clause.kind === 'route'))
    .map((clause) => routeRoot(clause.value))))]
    .filter((root) => root !== '/')
    .sort();

  // A socket cannot ride the http proxy: it needs its own upgrade headers and
  // no read timeout, or the connection dies as soon as a slide pauses.
  const streams = mod.services.some((svc) => svc.uses.some((use) => use.capability === 'stream' || use.capability.endsWith('.stream')));

  // The browser must reach the identity provider on the same origin as the
  // page, otherwise the login redirect and CORS get in the way.
  const idp = (mod.environments[0]?.binds ?? []).find((bind) => bind.provider === 'keycloak');
  const idpHost = idp ? String(idp.args.host?.kind === 'literal' ? idp.args.host.value : 'keycloak') : null;
  const idpPort = idp ? Number(idp.args.port?.kind === 'literal' ? idp.args.port.value : 8080) : 8080;

  return [
    'server {',
    '  listen 80;',
    '  server_name _;',
    '  root /usr/share/nginx/html;',
    '  index index.html;',
    '',
    '  location = /healthz {',
    '    proxy_pass http://service:3000/healthz;',
    '  }',
    '',
    ...(idpHost ? [
      '  location /realms/ {',
      '    proxy_pass http://' + idpHost + ':' + idpPort + ';',
      '    proxy_set_header Host $host;',
      '  }',
      '  location /resources/ {',
      '    proxy_pass http://' + idpHost + ':' + idpPort + ';',
      '    proxy_set_header Host $host;',
      '  }',
      '  location /admin/ {',
      '    proxy_pass http://' + idpHost + ':' + idpPort + ';',
      '    proxy_set_header Host $host;',
      '  }',
      '',
    ] : []),
    ...roots.flatMap((root) => [
      '  location ' + root + ' {',
      '    proxy_pass http://service:3000;',
      '    proxy_http_version 1.1;',
      '    proxy_set_header Host $host;',
      '    proxy_set_header X-Real-IP $remote_addr;',
      '  }',
      '',
    ]),
    ...(streams ? [
      '  location /ws {',
      '    proxy_pass http://service:3000;',
      '    proxy_http_version 1.1;',
      '    proxy_set_header Upgrade $http_upgrade;',
      '    proxy_set_header Connection "upgrade";',
      '    proxy_set_header Host $host;',
      '    proxy_read_timeout 3600s;',
      '    proxy_send_timeout 3600s;',
      '  }',
      '',
    ] : []),
    '  location / {',
    '    try_files $uri /index.html;',
    '  }',
    '}',
    '',
  ].join('\n');
}

function stringArg(bind: BindNode, key: string): string | null {
  const expr = bind.args[key];
  return expr && expr.kind === 'literal' && typeof expr.value === 'string' ? expr.value : null;
}

function numberArg(bind: BindNode, key: string): number | null {
  const expr = bind.args[key];
  return expr && expr.kind === 'literal' && typeof expr.value === 'number' ? expr.value : null;
}

function boolArg(bind: BindNode, key: string): boolean {
  const expr = bind.args[key];
  return Boolean(expr && expr.kind === 'literal' && expr.value === true);
}

function quote(value: string): string {
  return '"' + value.replace(/"/g, '\\"') + '"';
}

export interface RenderedProvider {
  alias: string;
  host: string;
  spec: ProviderSpec;
  port: number;
  expose: boolean;
  appEnv: Record<string, string>;
  volume: string | null;
  importFile: string | null;
  args: Record<string, string | number | boolean>;
}

function renderProvider(bind: BindNode, registry: ProviderRegistry): RenderedProvider | null {
  const spec = registry.get(bind.provider);
  if (!spec) return null;
  const host = stringArg(bind, 'host') ?? spec.name;
  const port = numberArg(bind, 'port') ?? spec.port ?? 0;
  const volume = spec.volumes && spec.volumes.length > 0 ? spec.volumes[0].split(':')[0] : null;
  const args: Record<string, string | number | boolean> = {};
  for (const [key, expr] of Object.entries(bind.args)) {
    if (expr.kind === 'literal' && expr.value != null) args[key] = expr.value;
  }
  return {
    alias: bind.alias,
    host,
    spec,
    port,
    importFile: typeof args.import === 'string' ? args.import : null,
    args,
    expose: boolArg(bind, 'expose'),
    appEnv: spec.appEnv ? spec.appEnv({ host, port, alias: bind.alias, args }) : {},
    volume,
  };
}

function providerLines(item: RenderedProvider): string[] {
  const { spec, host, port } = item;
  const image = providerImage(item);
  if (!image) return [];
  const lines = ['  ' + host + ':', '    image: ' + image];

  if (spec.command) {
    const command = item.importFile && spec.name === 'keycloak'
      ? [...spec.command, '--import-realm']
      : spec.command;
    lines.push('    command: ' + JSON.stringify(command));
  }

  if (spec.env && Object.keys(spec.env).length > 0) {
    lines.push('    environment:');
    for (const key of Object.keys(spec.env).sort()) lines.push('      ' + key + ': ' + quote(spec.env[key]));
  }

  if (item.expose && port > 0) {
    lines.push('    ports:');
    lines.push('      - ' + quote(port + ':' + port));
    for (const extra of spec.extraPorts ?? []) lines.push('      - ' + quote(extra + ':' + extra));
  }

  const mounts = [...(spec.volumes ?? [])];
  if (item.importFile && spec.name === 'keycloak') {
    const name = item.importFile.split('/').pop()!;
    mounts.push('./' + name + ':/opt/keycloak/data/import/' + name + ':ro');
  }
  if (mounts.length > 0) {
    lines.push('    volumes:');
    for (const mount of mounts) lines.push('      - ' + mount);
  }

  if (spec.healthcheck) {
    lines.push('    healthcheck:');
    lines.push('      test: ' + spec.healthcheck.test);
    lines.push('      interval: ' + spec.healthcheck.interval);
    lines.push('      timeout: ' + spec.healthcheck.timeout);
    lines.push('      retries: ' + spec.healthcheck.retries);
    if (spec.healthcheck.startPeriod) lines.push('      start_period: ' + spec.healthcheck.startPeriod);
  }

  lines.push('');
  return lines;
}

export function providerImage(item: RenderedProvider): string | null {
  if (item.spec.external || !item.spec.image) return null;
  return typeof item.args.image === 'string' ? item.args.image : item.spec.image;
}

export interface ComposeModel {
  name: string;
  providers: RenderedProvider[];
  appEnv: Record<string, string>;
  hasUi: boolean;
}

// One shared description of the topology: compose renders it as yaml and the
// kubernetes emitter renders the same services as manifests, so the local and
// the cluster view of a module cannot drift apart.
// Compose is the local view: prefer the environment that runs on docker.
// The kubernetes emitter needs the same choice, so it is shared here.
export function localEnvironment(mod: ModuleNode): EnvironmentNode | undefined {
  return mod.environments.find((env) => !env.deploy || env.deploy.provider === 'docker') ?? mod.environments[0];
}

// `environmentName` picks the topology instead of the local view: the k8s
// emitter renders the environment it was asked for, so a cloud environment's
// binds decide the providers and the app env. Omitted, compose stays the local
// view (that is what `docker-compose.yml` means).
export function composeModel(mod: ModuleNode, port: number, hasUi = true, registry: ProviderRegistry = loadRegistry(), dialect: 'mysql' | 'postgres' = 'mysql', environmentName?: string): ComposeModel {
  const name = 'arcod-' + kebab(mod.name);
  const named = environmentName ? mod.environments.find((env) => env.name === environmentName) : undefined;
  const environment = named ?? localEnvironment(mod);
  const all = (environment?.binds ?? [])
    .filter((bind) => registry.get(bind.provider) !== null)
    .map((bind) => renderProvider(bind, registry))
    .filter((item): item is RenderedProvider => item !== null);

  // A service with no explicit infra binding keeps a private kv so the demo
  // still runs; everything else comes from the environment.
  if ((environment?.binds ?? []).length === 0) {
    const svc = mod.services.find((item) => !item.external) ?? null;
    if (svc && storageKind(svc) === 'sql') {
      // A sql service without an explicit bind still needs a database to run
      // locally; provision the one the build speaks, not a kv it cannot use.
      const provider = providerFor(dialect === 'postgres' ? 'postgres' : 'mysql')!;
      const host = provider.name;
      const port = provider.port ?? 3306;
      all.push({
        alias: 'store',
        host,
        spec: { ...provider, name: provider.name },
        port,
        importFile: null,
        args: {},
        expose: false,
        appEnv: provider.appEnv!({ host, port, alias: 'store', args: {} }),
        volume: null,
      });
    } else {
      all.push({
        alias: 'store',
        host: 'kv',
        spec: { ...providerFor('redis')!, name: 'redis' },
        port: 6379,
        importFile: null,
        args: {},
        expose: false,
        appEnv: providerFor('redis')!.appEnv!({ host: 'kv', port: 6379, alias: 'store', args: {} }),
        volume: null,
      });
    }
  }

  // A redis bound as a broker tells the service which transport to use:
  // without these the runtime falls back to in-process memory drivers. The
  // alias that carries the capability decides, not the order of the binds: a
  // cache redis bound as `store` must not become the pub/sub broker just
  // because it is listed first.
  const capabilityAliases = (capability: string): Set<string> =>
    new Set(
      mod.services.flatMap((svc) =>
        svc.uses
          .filter((use) => use.capability === capability || use.capability.endsWith('.' + capability))
          .map((use) => use.alias),
      ),
    );
  const streamAliases = capabilityAliases('stream');
  const queueAliases = capabilityAliases('queue');

  const appEnv: Record<string, string> = {};
  for (const item of all) {
    for (const [key, value] of Object.entries(item.appEnv)) {
      // Two binds of the same capability would otherwise clash on DATABASE_URL.
      const name = key in appEnv ? key + '_' + item.alias.toUpperCase() : key;
      appEnv[name] = value;
    }
    if (item.spec.name === 'redis' && item.port > 0) {
      const url = 'redis://' + item.host + ':' + item.port;
      if (streamAliases.has(item.alias) && providerImplements(item.spec, 'stream') && !appEnv.STREAM_REDIS_URL) {
        appEnv.STREAM_REDIS_URL = url;
      }
      if (queueAliases.has(item.alias) && providerImplements(item.spec, 'queue') && !appEnv.QUEUE_REDIS_URL) {
        appEnv.QUEUE_REDIS_URL = url;
      }
    }
  }

  // Two binds may name the same container — a saga that keeps its store and
  // its broker in one redis sends `redis(host: "kv")` twice. Compose has one
  // key per service, so collapse the duplicates by host and port; every bind
  // keeps its own appEnv above, which is where the tangle is resolved. The
  // image is not part of the key: two images on one host is A085, and an
  // emitter reached without check must still write one block per key, not two
  // where the later silently wins.
  const seen = new Set<string>();
  const providers: RenderedProvider[] = [];
  for (const item of all) {
    const key = [item.host, String(item.port)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    providers.push(item);
  }

  return { name, providers, appEnv, hasUi };
}

export function localImage(mod: ModuleNode, kind: 'service' | 'web', revision: string): string {
  return 'arcod/' + kebab(mod.name) + '-' + kind + ':' + revision;
}

// `revision` is a content hash of the build contexts. With it the image tag
// changes whenever a body or a page changes, so `docker compose up` without
// --build builds the missing image instead of reusing a stale container, while
// an unchanged build keeps its tag and nothing is rebuilt.
export function composeYaml(mod: ModuleNode, port: number, hasUi = true, registry: ProviderRegistry = loadRegistry(), dialect: 'mysql' | 'postgres' = 'mysql', revision?: string): string {
  const { name, providers: bound, appEnv } = composeModel(mod, port, hasUi, registry, dialect);
  const lines = ['name: ' + name, 'services:'];
  for (const item of bound) lines.push(...providerLines(item));

  lines.push('  service:');
  if (revision) lines.push('    image: ' + localImage(mod, 'service', revision));
  lines.push('    build:', '      context: ./service');

  if (Object.keys(appEnv).length > 0) {
    lines.push('    environment:');
    for (const key of Object.keys(appEnv).sort()) lines.push('      ' + key + ': ' + quote(appEnv[key]));
  }

  const depends = bound.filter((item) => item.spec.healthcheck && !item.spec.oneShot);
  if (depends.length > 0) {
    lines.push('    depends_on:');
    for (const item of depends) {
      lines.push('      ' + item.host + ':');
      lines.push('        condition: service_healthy');
    }
  }

  if (hasUi) {
    lines.push('  web:');
    if (revision) lines.push('    image: ' + localImage(mod, 'web', revision));
    lines.push(
      '    build:',
      '      context: ./web',
      '    ports:',
      '      - "' + port + ':80"',
      '    depends_on:',
      '      - service',
    );
  } else {
    lines.push('    ports:', '      - "' + port + ':3000"');
  }

  // Docker Desktop resolves host.docker.internal on its own; a Linux engine
  // does not, and the URL the provider rewrote cannot be reached without the
  // declaration. A host-local URL therefore implies extra_hosts: the line is
  // harmless where the name already resolves and required where it does not.
  // gateway: true stays an accepted argument so older specs keep checking
  // clean, but it no longer decides anything (issue #42).
  const endpoints = bound.filter((item) => item.spec.capability === 'endpoint');
  const gateway = endpoints.some((item) => {
    const url = String(item.args.url ?? '');
    return url.includes('host.docker.internal') || url.includes('localhost') || url.includes('127.0.0.1');
  });
  if (gateway) {
    lines.push('    extra_hosts:');
    lines.push('      - "host.docker.internal:host-gateway"');
  }

  // An external docker network is how a separately deployed service is joined.
  const networks = Array.from(new Set(
    endpoints.map((item) => item.args.network).filter((value): value is string => typeof value === 'string' && value.length > 0),
  )).sort();
  if (networks.length > 0) {
    lines.push('    networks:');
    for (const network of networks) lines.push('      - ' + quote(network));
  }

  const volumes = Array.from(new Set(bound.map((item) => item.volume).filter((item): item is string => Boolean(item)))).sort();
  if (volumes.length > 0) {
    lines.push('', 'volumes:');
    for (const volume of volumes) lines.push('  ' + volume + ':');
  }
  if (networks.length > 0) {
    lines.push('', 'networks:');
    for (const network of networks) {
      lines.push('  ' + quote(network) + ':', '    external: true');
    }
  }

  lines.push('');
  return lines.join('\n');
}
