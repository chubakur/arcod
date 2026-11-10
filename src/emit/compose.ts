import { kebab } from '../plan.ts';
import type { ModuleNode } from '../ast.ts';

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
    '  location /api/ {',
    '    proxy_pass http://service:3000;',
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '  }',
    '',
    '  location /healthz {',
    '    proxy_pass http://service:3000;',
    '  }',
    '',
    '  location / {',
    '    try_files $uri /index.html;',
    '  }',
    '}',
    '',
  ].join('\n');
}

export function composeYaml(mod: ModuleNode, port: number): string {
  const name = 'arcod-' + kebab(mod.name);
  return [
    'name: ' + name,
    'services:',
    '  kv:',
    '    image: redis:7-alpine',
    '    command: ["redis-server", "--save", "", "--appendonly", "no"]',
    '    healthcheck:',
    '      test: ["CMD", "redis-cli", "ping"]',
    '      interval: 2s',
    '      timeout: 2s',
    '      retries: 30',
    '  service:',
    '    build:',
    '      context: ./service',
    '    environment:',
    '      KV_HOST: kv',
    '      KV_PORT: "6379"',
    '    depends_on:',
    '      kv:',
    '        condition: service_healthy',
    '  web:',
    '    build:',
    '      context: ./web',
    '    ports:',
    '      - "' + port + ':80"',
    '    depends_on:',
    '      - service',
    '',
  ].join('\n');
}
