import { kebab } from '../plan.ts';
import type { BindNode, ModuleNode } from '../ast.ts';
import { providerFor, providerImplements, type ProviderSpec } from '../providers.ts';

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

function renderProvider(bind: BindNode): RenderedProvider | null {
  const spec = providerFor(bind.provider);
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
export function composeModel(mod: ModuleNode, port: number, hasUi = true): ComposeModel {
  const name = 'arcod-' + kebab(mod.name);
  // Compose is the local view: prefer the environment that runs on docker.
  const environment = mod.environments.find((env) => !env.deploy || env.deploy.provider === 'docker')
    ?? mod.environments[0];
  const bound = (environment?.binds ?? [])
    .filter((bind) => providerFor(bind.provider) !== null)
    .map(renderProvider)
    .filter((item): item is RenderedProvider => item !== null);

  // A service with no explicit infra binding keeps a private kv so the demo
  // still runs; everything else comes from the environment.
  if ((environment?.binds ?? []).length === 0) {
    bound.push({
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

  const appEnv: Record<string, string> = {};
  for (const item of bound) {
    for (const [key, value] of Object.entries(item.appEnv)) {
      // Two binds of the same capability would otherwise clash on DATABASE_URL.
      const name = key in appEnv ? key + '_' + item.alias.toUpperCase() : key;
      appEnv[name] = value;
    }
    // A redis bound as a broker tells the service which transport to use:
    // without these the runtime falls back to in-process memory drivers.
    if (item.spec.name === 'redis' && item.port > 0) {
      const url = 'redis://' + item.host + ':' + item.port;
      if (providerImplements(item.spec, 'stream') && !appEnv.STREAM_REDIS_URL) appEnv.STREAM_REDIS_URL = url;
      if (providerImplements(item.spec, 'queue') && !appEnv.QUEUE_REDIS_URL) appEnv.QUEUE_REDIS_URL = url;
    }
  }

  return { name, providers: bound, appEnv, hasUi };
}

export function composeYaml(mod: ModuleNode, port: number, hasUi = true): string {
  const { name, providers: bound, appEnv } = composeModel(mod, port, hasUi);
  const lines = ['name: ' + name, 'services:'];
  for (const item of bound) lines.push(...providerLines(item));

  lines.push('  service:', '    build:', '      context: ./service');

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
    lines.push(
      '  web:',
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

  // Docker Desktop already resolves host.docker.internal to the host. On Linux
  // it has to be declared, so the bind asks for it explicitly: gateway: true.
  const endpoints = bound.filter((item) => item.spec.capability === 'endpoint');
  const gateway = endpoints.some((item) => item.args.gateway === true)
    && endpoints.some((item) => {
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
