import { kebab } from '../plan.ts';
import type { BindNode, ModuleNode } from '../ast.ts';
import { providerFor, type ProviderSpec } from '../providers.ts';

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

export function nginxConf(): string {
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
    '  location /api/ {',
    '    proxy_pass http://service:3000;',
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '  }',
    '',
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

interface RenderedProvider {
  alias: string;
  host: string;
  spec: ProviderSpec;
  port: number;
  expose: boolean;
  appEnv: Record<string, string>;
  volume: string | null;
}

function renderProvider(bind: BindNode): RenderedProvider | null {
  const spec = providerFor(bind.provider);
  if (!spec) return null;
  const host = stringArg(bind, 'host') ?? spec.name;
  const port = numberArg(bind, 'port') ?? spec.port ?? 0;
  const volume = spec.volumes && spec.volumes.length > 0 ? spec.volumes[0].split(':')[0] : null;
  return {
    alias: bind.alias,
    host,
    spec,
    port,
    expose: boolArg(bind, 'expose'),
    appEnv: spec.appEnv ? spec.appEnv(host, port) : {},
    volume,
  };
}

function providerLines(item: RenderedProvider): string[] {
  const { spec, host, port } = item;
  const lines = ['  ' + host + ':', '    image: ' + spec.image];

  if (spec.command) lines.push('    command: ' + JSON.stringify(spec.command));

  if (spec.env && Object.keys(spec.env).length > 0) {
    lines.push('    environment:');
    for (const key of Object.keys(spec.env).sort()) lines.push('      ' + key + ': ' + quote(spec.env[key]));
  }

  if (item.expose && port > 0) {
    lines.push('    ports:');
    lines.push('      - ' + quote(port + ':' + port));
    for (const extra of spec.extraPorts ?? []) lines.push('      - ' + quote(extra + ':' + extra));
  }

  if (spec.volumes) {
    lines.push('    volumes:');
    for (const volume of spec.volumes) lines.push('      - ' + volume);
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

export function composeYaml(mod: ModuleNode, port: number, hasUi = true): string {
  const name = 'arcod-' + kebab(mod.name);
  const environment = mod.environments[0];
  const bound = (environment?.binds ?? [])
    .filter((bind) => providerFor(bind.provider) !== null)
    .map(renderProvider)
    .filter((item): item is RenderedProvider => item !== null);

  // A service with no explicit infra binding keeps a private kv so the demo
  // still runs; everything else comes from the environment.
  if (bound.length === 0) {
    bound.push({
      alias: 'store',
      host: 'kv',
      spec: { ...providerFor('redis')!, name: 'redis' },
      port: 6379,
      expose: false,
      appEnv: providerFor('redis')!.appEnv!('kv', 6379),
      volume: null,
    });
  }

  const lines = ['name: ' + name, 'services:'];
  for (const item of bound) lines.push(...providerLines(item));

  const appEnv: Record<string, string> = {};
  for (const item of bound) {
    for (const [key, value] of Object.entries(item.appEnv)) {
      // Two binds of the same capability would otherwise clash on DATABASE_URL.
      const name = key in appEnv ? key + '_' + item.alias.toUpperCase() : key;
      appEnv[name] = value;
    }
  }

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

  const volumes = Array.from(new Set(bound.map((item) => item.volume).filter((item): item is string => Boolean(item)))).sort();
  if (volumes.length > 0) {
    lines.push('', 'volumes:');
    for (const volume of volumes) lines.push('  ' + volume + ':');
  }

  lines.push('');
  return lines.join('\n');
}
