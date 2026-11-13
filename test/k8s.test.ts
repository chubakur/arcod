import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import type { ModuleNode } from '../src/ast.ts';
import { buildExample } from '../src/build.ts';
import { helmChart, k8sManifests, type EmittedFile } from '../src/emit/k8s.ts';

const examplePath = new URL('../examples/onetimemessage/main.arc', import.meta.url);

async function onetime(): Promise<ModuleNode> {
  return parse(await readFile(examplePath, 'utf8'), 'main.arc');
}

function need(files: EmittedFile[], path: string): string {
  const file = files.find((item) => item.path === path);
  assert.ok(file, 'missing emitted file: ' + path);
  return file.content;
}

const stateless = `module kvonly @0.1.0 {
}
use capability arcod.std.sql @1
service Store : http {
  uses db: sql
  contract {
    public op list() -> string {
      route: "GET /api/items"
    }
  }
}
environment dev {
  bind db -> postgres()
  deploy docker
}
`;

test('k8s: emits the namespace, configmap, providers and the app', async () => {
  const files = k8sManifests(await onetime(), { image: 'ghcr.io/acme/otm:1.2.3', host: 'otm.example.com' });
  const names = files.map((file) => file.path).sort();
  assert.deepEqual(names, [
    '00-namespace.yaml',
    'configmap.yaml',
    'ingress.yaml',
    'kv.yaml',
    'service.yaml',
    'web.yaml',
  ]);
  assert.match(need(files, '00-namespace.yaml'), /kind: Namespace/);
  assert.match(need(files, '00-namespace.yaml'), /name: arcod-onetimemessage/);
});

test('k8s: providers become a Deployment plus a ClusterIP Service', async () => {
  const files = k8sManifests(await onetime(), { image: 'acme/app:1' });
  const kv = need(files, 'kv.yaml');
  assert.match(kv, /^apiVersion: apps\/v1\nkind: Deployment/m);
  assert.match(kv, /image: redis:7-alpine/);
  assert.match(kv, /command: \["redis-server","--save","","--appendonly","no"\]/);
  assert.match(kv, /readinessProbe:/);
  assert.match(kv, /command: \["redis-cli","ping"\]/);
  assert.match(kv, /- containerPort: 6379/);
  assert.match(kv, /kind: Service/);
  assert.match(kv, /port-6379/);
  assert.match(kv, /type: ClusterIP/);
});

test('k8s: the app reads its environment from a ConfigMap and probes /healthz', async () => {
  const files = k8sManifests(await onetime(), { image: 'acme/app:1', servicePort: 3000 });
  const configmap = need(files, 'configmap.yaml');
  assert.match(configmap, /KV_HOST: "kv"/);
  assert.match(configmap, /KV_PORT: "6379"/);
  assert.match(configmap, /STREAM_REDIS_URL: "redis:\/\/kv:6379"/);
  assert.match(configmap, /QUEUE_REDIS_URL: "redis:\/\/kv:6379"/);

  const service = need(files, 'service.yaml');
  assert.match(service, /name: arcod-onetimemessage-env/);
  assert.match(service, /envFrom:/);
  assert.match(service, /- containerPort: 3000/);
  assert.match(service, /path: \/healthz/);
  assert.match(service, /livenessProbe:/);
});

test('k8s: the ingress points at the web tier and only exists with a host', async () => {
  const withHost = k8sManifests(await onetime(), { image: 'acme/app:1', host: 'otm.example.com' });
  const ingress = need(withHost, 'ingress.yaml');
  assert.match(ingress, /host: otm.example.com/);
  assert.match(ingress, /ingressClassName: nginx/);
  assert.match(ingress, /name: web/);
  assert.match(ingress, /number: 80/);

  const withoutHost = k8sManifests(await onetime(), { image: 'acme/app:1' });
  assert.equal(withoutHost.find((file) => file.path === 'ingress.yaml'), undefined);
});

test('k8s: a stateful provider gets a PVC and a mount', async () => {
  const ast = parse(stateless, 'main.arc');
  const files = k8sManifests(ast, { image: 'acme/kvonly:1' });
  const pvc = need(files, 'postgres-data.yaml');
  assert.match(pvc, /kind: PersistentVolumeClaim/);
  assert.match(pvc, /accessModes:\n    - ReadWriteOnce/);

  const postgres = need(files, 'postgres.yaml');
  assert.match(postgres, /volumeMounts:/);
  assert.match(postgres, /mountPath: \/var\/lib\/postgresql\/data/);
  assert.match(postgres, /claimName: postgres-data/);
  assert.match(postgres, /- containerPort: 5432/);
});

test('k8s: a module without a ui has no web tier and routes the ingress to the service', async () => {
  const files = k8sManifests(parse(stateless, 'main.arc'), { image: 'acme/kvonly:1', host: 'kv.example.com' });
  assert.equal(files.find((file) => file.path === 'web.yaml'), undefined);
  const ingress = need(files, 'ingress.yaml');
  assert.match(ingress, /name: service/);
  assert.match(ingress, /number: 3000/);
});

test('k8s: output is deterministic for the same model', async () => {
  const ast = await onetime();
  const first = k8sManifests(ast, { image: 'acme/app:1', host: 'x.example.com' });
  const second = k8sManifests(ast, { image: 'acme/app:1', host: 'x.example.com' });
  assert.deepEqual(first, second);
});

test('helm: chart wraps the same objects and exposes the knobs as values', async () => {
  const files = helmChart(await onetime(), { image: 'ghcr.io/acme/otm:1.2.3', host: 'otm.example.com' });
  const names = files.map((file) => file.path).sort();
  assert.ok(names.includes('Chart.yaml'));
  assert.ok(names.includes('values.yaml'));
  assert.ok(names.includes('templates/service.yaml'));
  assert.ok(names.includes('templates/kv.yaml'));
  assert.equal(names.includes('templates/00-namespace.yaml'), false);

  const chart = need(files, 'Chart.yaml');
  assert.match(chart, /name: arcod-onetimemessage/);
  assert.match(chart, /apiVersion: v2/);

  const values = need(files, 'values.yaml');
  assert.match(values, /repository: ghcr.io\/acme\/otm/);
  assert.match(values, /tag: 1.2.3/);
  assert.match(values, /enabled: true/);
  assert.match(values, /host: otm.example.com/);

  const service = need(files, 'templates/service.yaml');
  assert.match(service, /image: \{\{ .Values.image.repository \}\}:\{\{ .Values.image.tag \}\}/);
  assert.match(service, /replicas: \{\{ .Values.replicaCount \}\}/);

  const ingress = need(files, 'templates/ingress.yaml');
  assert.match(ingress, /^\{\{- if .Values.ingress.enabled \}\}/);
  assert.match(ingress, /host: \{\{ .Values.ingress.host \}\}/);
});

test('helm: no host means the ingress is disabled by default', async () => {
  const values = helmChart(await onetime(), { image: 'acme/app:1' }).find((file) => file.path === 'values.yaml');
  assert.ok(values);
  assert.match(values.content, /enabled: false/);
});

test('build: a kubernetes environment writes the manifests next to the compose file', async () => {
  const source = (await readFile(examplePath, 'utf8')).replace(
    'deploy docker',
    'deploy kubernetes(image: "ghcr.io/acme/otm:1.2.3", host: "otm.example.com")',
  );
  const dir = await mkdtemp(join(tmpdir(), 'arcod-k8s-'));
  try {
    const result = await buildExample(parse(source, 'main.arc'), dir);
    const written = result.files.filter((file) => file.includes('/k8s/')).sort();
    assert.equal(written.length, 6);
    assert.ok(written.some((file) => file.endsWith('/k8s/ingress.yaml')));
    const deployment = await readFile(join(dir, '.arcod', 'build', 'k8s', 'service.yaml'), 'utf8');
    assert.match(deployment, /image: ghcr.io\/acme\/otm:1.2.3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const vaultSpec = `module shopsvc @0.1.0 {
}
use capability arcod.std.sql @1
use capability arcod.std.secrets @1
service Shop : http {
  uses db: sql
  uses keys: secrets
  contract {
    public op list() -> string {
      route: "GET /api/items"
    }
  }
}
environment prod {
  bind db -> postgres()
  bind keys -> vault(path: "secret/data/shop", store: "vault-prod")
  deploy kubernetes(image: "acme/shop:1")
}
`;

test('secrets: credentials go to a Secret, never to the ConfigMap', () => {
  const files = k8sManifests(parse(stateless, 'main.arc'), { image: 'acme/kvonly:1' });
  // The whole app env here is secret: no ConfigMap is emitted at all.
  assert.equal(files.find((file) => file.path === 'configmap.yaml'), undefined);

  const secret = need(files, 'secret.yaml');
  assert.ok(secret.includes('kind: Secret'));
  assert.ok(secret.includes('DATABASE_URL: "postgres://arcod:arcod@postgres:5432/arcod"'));

  const service = need(files, 'service.yaml');
  assert.equal(service.includes('configMapRef:'), false);
  assert.ok(service.includes('secretRef:'));
  assert.ok(service.includes('name: arcod-kvonly-env'));
});

test('secrets: a provider bootstrap password gets its own Secret', () => {
  const files = k8sManifests(parse(stateless, 'main.arc'), { image: 'acme/kvonly:1' });
  const secret = need(files, 'postgres-secret.yaml');
  assert.ok(secret.includes('POSTGRES_PASSWORD: "arcod"'));

  const postgres = need(files, 'postgres.yaml');
  assert.equal(postgres.includes('POSTGRES_PASSWORD'), false);
  assert.ok(postgres.includes('envFrom:'));
  assert.ok(postgres.includes('name: postgres-env'));
});

test('secrets: a secrets capability turns the Secret into an ExternalSecret', () => {
  const files = k8sManifests(parse(vaultSpec, 'main.arc'), { image: 'acme/shop:1' });
  assert.equal(files.find((file) => file.path === 'secret.yaml'), undefined);

  const external = need(files, 'externalsecret.yaml');
  assert.ok(external.includes('kind: ExternalSecret'));
  assert.ok(external.includes('name: vault-prod'));
  assert.ok(external.includes('key: secret/data/shop'));
  assert.ok(external.includes('secretKey: DATABASE_URL'));
  assert.ok(external.includes('creationPolicy: Owner'));

  // No development credential may survive anywhere in the output.
  const everything = files.map((file) => file.content).join('\n');
  assert.equal(everything.includes('postgres://arcod:arcod'), false);
});
