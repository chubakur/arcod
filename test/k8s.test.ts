import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import type { ModuleNode } from '../src/ast.ts';
import { buildExample } from '../src/build.ts';
import { helmChart, k8sManifests, type EmittedFile } from '../src/emit/k8s.ts';
import { MANAGED_ENDPOINTS } from '../src/emit/terraform.ts';
import { providerFor } from '../src/providers.ts';

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
  assert.match(configmap, /REDIS_URL: "redis:\/\/kv:6379"/);
  // The app uses only kv, so no broker URL is invented for it.
  assert.equal(/STREAM_REDIS_URL/.test(configmap), false);
  assert.equal(/QUEUE_REDIS_URL/.test(configmap), false);

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

test('k8s: a pinned provider image replaces the built-in tag in the Deployment', () => {
  // image is a bind argument, not a compose nicety: the k8s emitter renders
  // provider Deployments through the same providerImage(), so the pin has to
  // land here too.
  const pinned = stateless.replace('bind db -> postgres()', 'bind db -> postgres(host: "db", image: "postgres:15-alpine")');
  const files = k8sManifests(parse(pinned, 'main.arc'), { image: 'acme/app:1' });
  const db = need(files, 'db.yaml');
  assert.match(db, /image: postgres:15-alpine/);
  assert.doesNotMatch(db, /postgres:16-alpine/, 'the built-in tag is gone');
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
  // A CMD-SHELL healthcheck reaches the cluster as a shell probe, not as a
  // binary literally named "/bin/sh -c ...".
  assert.match(postgres, /command: \["\/bin\/sh","-c","pg_isready -U arcod"\]/);
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

test('helm: an untagged image means latest and a registry port is not a tag', async () => {
  const ast = await onetime();
  const read = (image: string) =>
    helmChart(ast, { image }).find((file) => file.path === 'values.yaml')!.content;

  const plain = read('acme/app');
  assert.match(plain, /repository: acme\/app\n/);
  assert.match(plain, /tag: latest/);

  // `registry.local:5000/acme/app` — the colon belongs to the registry, not
  // to a tag; splitting on it would invent repository `registry.local`.
  const ported = read('registry.local:5000/acme/app');
  assert.match(ported, /repository: registry.local:5000\/acme\/app\n/);
  assert.match(ported, /tag: latest/);
});

// The cloud endpoint is assigned at apply time, so a manifest that carries the
// docker host name (`postgres://app:secret@pg:5432/app`) starts a pod that
// cannot resolve its database. The app env entry moves into a Secret fed from
// the terraform outputs; the same file says which output fills which key.
const cloudModule = [
  'module shop @0.1.0 {',
  '}',
  'use capability arcod.std.sql @1',
  'service Store : http {',
  '  uses db: sql',
  '  contract {',
  '    public op list() -> string {',
  '      route: "GET /api/items"',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind db -> postgres()',
  '  deploy docker',
  '}',
  'environment prod {',
  '  bind db -> postgres(host: "pg", port: 5432)',
  '  deploy yandex(region: "ru-central1", folder: "f", service: "shop")',
  '}',
].join('\n');

test('k8s: a cloud endpoint is read from a Secret, not from the docker host', async () => {
  const mod = await parse(cloudModule, 'shop.arc');
  const files = k8sManifests(mod, { environment: 'prod' });
  const app = need(files, 'service.yaml');
  assert.match(app, /- name: DATABASE_URL\n              valueFrom:\n                secretKeyRef:\n                  name: arcod-shop-endpoints\n                  key: database_url/);
  assert.deepEqual(app.includes('pg:5432'), false, 'the docker address never reaches the manifest');
  assert.match(app, /key database_url  <-  postgres:\/\/<user>:<password>@<db_host>:<db_port>\/arcod/, 'the comment shows the shape the key must carry');
  const configMap = files.find((item) => item.path === 'configmap.yaml');
  assert.equal(configMap, undefined, 'nothing is left for the ConfigMap to carry');
});

test('k8s: a docker environment keeps the literal URL it can resolve', async () => {
  const mod = await parse(cloudModule, 'shop.arc');
  const files = k8sManifests(mod, { environment: 'dev' });
  const app = need(files, 'service.yaml');
  assert.deepEqual(app.includes('secretKeyRef'), false, 'a container address needs no cloud secret');
  assert.match(need(files, 'secret.yaml'), /DATABASE_URL: "postgres:\/\/.*@postgres:5432/);
});

test('k8s: a cloud-managed database is not also deployed into the cluster', async () => {
  const mod = await parse(cloudModule, 'shop.arc');
  const files = k8sManifests(mod, { environment: 'prod' });
  assert.deepEqual(files.map((item) => item.path).filter((path) => path.startsWith('pg')), [], 'the plan owns postgres, so no pod, Service or PVC for it');
  assert.match(need(files, 'service.yaml'), /# Not deployed here, the plan owns them: pg\./);
});

test('k8s: a cloud database and a cloud kv both stay out of the cluster', async () => {
  const source = [
    'module shop @0.1.0 {',
    '}',
    'use capability arcod.std.sql @1',
    'use capability arcod.std.kv @1',
    'service Store : http {',
    '  uses db: sql',
    '  uses cache: kv',
    '  contract {',
    '    public op list() -> string {',
    '      route: "GET /api/items"',
    '    }',
    '  }',
    '}',
    'environment prod {',
    '  bind db -> postgres(host: "pg", port: 5432)',
    '  bind cache -> redis()',
    '  deploy yandex(region: "ru-central1", folder: "f", service: "shop")',
    '}',
  ].join('\n');
  const mod = await parse(source, 'shop.arc');
  const files = k8sManifests(mod, { environment: 'prod' });
  const workloads = files.map((item) => item.path).filter((path) => path.startsWith('pg') || path.startsWith('redis'));
  assert.deepEqual(workloads, [], 'neither managed service gets a pod, Service or PVC');
  const app = need(files, 'service.yaml');
  assert.match(app, /- name: REDIS_URL\n              valueFrom:\n                secretKeyRef:\n                  name: arcod-shop-endpoints\n                  key: redis_url/, 'the kv URL moves into the same endpoint Secret');
  assert.match(app, /#   key redis_url  <-  redis:\/\/<kv_host>:<kv_port>/);
  assert.match(app, /#   key kv_host  <-  terraform output kv_host/);
  assert.match(app, /- name: KV_PORT\n              valueFrom:\n                secretKeyRef:\n                  name: arcod-shop-endpoints\n                  key: kv_port/, 'the bare kv port moves too: the driver reads it on its own');
  const configMap = files.find((item) => item.path === 'configmap.yaml');
  assert.equal(configMap, undefined, 'no entry is left naming the compose host');
  assert.match(app, /# Not deployed here, the plan owns them: pg, redis\./);
});

// examples/chat binds mysql locally and postgres in prod. Rendering prod used
// to reuse the docker view, so the cloud manifest advertised
// `mysql://…@db:3306` for a database the plan creates as PostgreSQL.
test('k8s: the rendered environment decides the topology, not the docker view', async () => {
  const source = await readFile(new URL('../examples/chat/main.arc', import.meta.url), 'utf8');
  const mod = await parse(source, 'chat.arc');
  const prod = k8sManifests(mod, { environment: 'prod' });
  assert.match(need(prod, 'service.yaml'), /key: database_url/, 'prod reads the managed endpoint from the Secret');
  assert.deepEqual(prod.some((file) => file.content.includes('mysql://')), false, 'prod binds postgres, so no mysql URL and no mysql workload');
  const dev = k8sManifests(mod, { environment: 'dev' });
  assert.match(need(dev, 'secret.yaml'), /mysql:\/\//, 'the local view keeps the mysql it binds');
});

// The cloud contract has to hold for every shipped example, not just the one
// fixture above: every environment that deploys to yandex renders manifests,
// and no managed provider's docker address reaches the app.
test('k8s: every cloud environment in examples renders without a docker address', async () => {
  const root = new URL('../examples/', import.meta.url);
  const { readdir } = await import('node:fs/promises');
  let checked = 0;
  for (const dir of (await readdir(root)).sort()) {
    let source: string;
    try {
      source = await readFile(new URL(dir + '/main.arc', root), 'utf8');
    } catch {
      continue;
    }
    const mod = await parse(source, dir + '/main.arc');
    for (const env of mod.environments) {
      if (!env.deploy || env.deploy.provider === 'docker') continue;
      const files = k8sManifests(mod, { environment: env.name });
      const app = need(files, 'service.yaml');
      for (const bind of env.binds) {
        const endpoint = MANAGED_ENDPOINTS[bind.provider];
        if (!endpoint) continue;
        // The default host is the provider name and the default port is the
        // container port, so a bind without arguments still addresses a
        // compose service that the plan never starts.
        const host = bind.args.host?.kind === 'literal' ? String(bind.args.host.value) : bind.provider;
        const port = bind.args.port?.kind === 'literal' ? String(bind.args.port.value) : String(providerFor(bind.provider)?.port ?? '');
        assert.deepEqual(app.includes(host + ':' + port), false,
          dir + ' ' + env.name + ': ' + bind.alias + ' keeps the docker address ' + host + ':' + port);
        assert.deepEqual(app.includes(': "' + host + '"'), false,
          dir + ' ' + env.name + ': ' + bind.alias + ' keeps the bare docker host ' + host);
      }
      checked += 1;
    }
  }
  assert.ok(checked >= 5, 'the examples still carry cloud environments: ' + checked);
});

// `arcod build` writes one manifest tree per cloud environment. Rendering it
// without naming the environment described the docker view in every tree, so
// k8s-prod advertised the local mysql the plan never creates.
test('build: a cluster environment writes the manifest for its own binds', async () => {
  const source = [
    'module shop @0.1.0 {',
    '}',
    'use capability arcod.std.sql @1',
    'service Store : http {',
    '  uses db: sql',
    '  contract {',
    '    public op list() -> string {',
    '      route: "GET /api/items"',
    '    }',
    '  }',
    '}',
    'environment dev {',
    '  bind db -> mysql(host: "db", port: 3306)',
    '  deploy docker',
    '}',
    'environment staging {',
    '  bind db -> postgres(host: "pg", port: 5432)',
    '  deploy kubernetes(image: "acme/shop:1")',
    '}',
  ].join('\n');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-k8s-env-'));
  try {
    const result = await buildExample(await parse(source, 'shop.arc'), dir);
    const staging = await readFile(join(dir, '.arcod', 'build', 'k8s-staging', 'secret.yaml'), 'utf8');
    assert.match(staging, /DATABASE_URL: "postgres:\/\//, 'staging binds postgres, so that is the URL it gets');
    assert.deepEqual(staging.includes('mysql://'), false, 'the local mysql never reaches the staging tree');
    assert.deepEqual(result.files.some((file) => file.includes('/k8s-dev/')), false, 'a docker environment has no manifest tree');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('helm: a cloud chart reads the same endpoint Secret', async () => {
  const mod = await parse(cloudModule, 'shop.arc');
  const files = helmChart(mod, { environment: 'prod' });
  const app = need(files, 'templates/service.yaml');
  assert.match(app, /secretKeyRef:\n                  name: arcod-shop-endpoints\n                  key: database_url/);
  assert.match(app, /kubectl -n \{\{ \.Release\.Namespace \}\} create secret generic arcod-shop-endpoints/);
  assert.deepEqual(files.some((file) => file.content.includes('pg:5432')), false, 'no docker address anywhere in the chart');
});

// The secret store is an environment's bind, not a property of the docker view:
// a cloud environment that binds vault must get its ExternalSecret from that
// path and store, or the production credentials silently fall back to a secret
// filled with placeholders.
test('k8s: the vault bind of the rendered environment sources the credentials', async () => {
  const source = [
    'module shop @0.1.0 {',
    '}',
    'use capability arcod.std.sql @1',
    'use capability arcod.std.secrets @1',
    'service Store : http {',
    '  uses db: sql',
    '  uses keys: secrets',
    '  contract {',
    '    public op list() -> string {',
    '      route: "GET /api/items"',
    '    }',
    '  }',
    '}',
    'environment dev {',
    '  bind db -> postgres()',
    '  deploy docker',
    '}',
    'environment prod {',
    '  bind db -> postgres(host: "pg", port: 5432)',
    '  bind keys -> vault(path: "secret/data/shop", store: "vault-prod")',
    '  deploy yandex(region: "ru-central1", folder: "f", service: "shop")',
    '}',
  ].join('\n');
  const mod = await parse(source, 'shop.arc');
  const files = k8sManifests(mod, { environment: 'prod' });
  const external = need(files, 'externalsecret.yaml');
  assert.match(external, /name: vault-prod/, 'prod names its own ClusterSecretStore');
  assert.match(external, /key: secret\/data\/shop/);
  assert.deepEqual(files.some((file) => file.path === 'secret.yaml'), false, 'no placeholder secret beside the ExternalSecret');
});

test('k8s: --replicas scales the app, never a single-instance provider', async () => {
  const files = k8sManifests(await onetime(), { image: 'acme/app:1', replicas: 3 });
  assert.match(need(files, 'service.yaml'), /  replicas: 3/);
  assert.match(need(files, 'kv.yaml'), /  replicas: 1/);
  assert.equal(/replicas: 3/.test(need(files, 'kv.yaml')), false);
});

test('helm: replicaCount does not scale a provider Deployment', async () => {
  const files = helmChart(await onetime(), { image: 'acme/app:1', host: 'otm.example.com' });
  assert.match(need(files, 'templates/service.yaml'), /replicas: \{\{ .Values.replicaCount \}\}/);
  assert.match(need(files, 'templates/kv.yaml'), /  replicas: 1/);
  assert.equal(/replicaCount/.test(need(files, 'templates/kv.yaml')), false);
});

test('k8s: a provider rolls as Recreate, the app keeps the rolling default', async () => {
  const files = k8sManifests(await onetime(), { image: 'acme/app:1' });
  assert.match(need(files, 'kv.yaml'), /  replicas: 1\n  strategy:\n    type: Recreate\n  selector:/);
  assert.equal(/strategy:/.test(need(files, 'service.yaml')), false);
  assert.equal(/strategy:/.test(need(files, 'web.yaml')), false);
});
