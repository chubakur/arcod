import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { composeYaml, serviceEndpoints } from '../src/emit/compose.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { grpcProto } from '../src/emit/grpc.ts';
import { graphqlSchema } from '../src/emit/graphql.ts';
import { helmChart, k8sManifests } from '../src/emit/k8s.ts';
import { runExamples } from '../src/test.ts';

// A module may declare more than one service. The emitters used to take the
// first internal service only, so half of the spec disappeared without a word;
// the build now writes one context per service and each context carries its
// own routes and its own CONFIG.service.
const twoServices = `
module shop @0.1.0 {}

type Item = { id: string, title: string }

service Store : http {
  uses db: kv
  contract {
    public op create(title: string) -> Item {
      route: "POST /v1/items"
    }

    public op read(id: string) -> Item {
      route: "GET /v1/items/:id"
    }
  }
}

service Cache : http {
  contract {
    public op get(key: string) -> string {
      route: "GET /v1/cache/:key"
    }
  }
}
`;

const oneService = `
module shop @0.1.0 {}

type Item = { id: string, title: string }

service Store : http {
  uses db: kv
  contract {
    public op create(title: string) -> Item {
      route: "POST /v1/items"
    }
  }
}
`;

test('build: every internal service gets its own context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-multi-'));
  try {
    const result = await buildExample(parse(twoServices, 'main.arc'), root, { port: 8080 });
    const store = await readFile(join(result.dir, 'service', 'index.mjs'), 'utf8');
    const cache = await readFile(join(result.dir, 'service-cache', 'index.mjs'), 'utf8');

    assert.match(store, /"service": "Store"/);
    assert.match(cache, /"service": "Cache"/);
    // The routes follow the service they belong to: the second service is not
    // a copy of the first, and its endpoint is not lost.
    assert.match(store, /\/v1\/items/);
    assert.equal(store.includes('/v1/cache'), false);
    assert.match(cache, /\/v1\/cache\/\:key/);
    assert.equal(cache.includes('/v1/items'), false);
    // Each context is buildable on its own.
    assert.ok(existsSync(join(result.dir, 'service-cache', 'Dockerfile')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('build: one service keeps the single service directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-multi-'));
  try {
    const result = await buildExample(parse(oneService, 'main.arc'), root, { port: 8080 });
    const entries = await readdir(result.dir);
    assert.ok(entries.includes('service'), 'the historical context stays');
    assert.deepEqual(entries.filter((name) => name.startsWith('service-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compose: both services get a container, a context and a port', async () => {
  const mod = parse(twoServices, 'main.arc');
  const yaml = composeYaml(mod, 8080, false);
  const lines = yaml.split('\n');
  const keys = lines.filter((line) => /^  [a-z][a-z0-9-]*:$/.test(line)).map((line) => line.trim().replace(':', ''));
  assert.ok(keys.includes('service'), 'the front service stays: ' + keys.join(','));
  assert.ok(keys.includes('service-cache'), 'the second service is not dropped: ' + keys.join(','));
  assert.match(yaml, /context: \.\/service-cache/);
  // The front service keeps the requested port; the second is reachable on the
  // next one, because only the front service sits behind the web proxy.
  assert.match(yaml, /- "8080:3000"/);
  assert.match(yaml, /- "8081:3000"/);
});

test('compose: a single-service module keeps one service block', async () => {
  const mod = parse(oneService, 'main.arc');
  const yaml = composeYaml(mod, 8080, true);
  const lines = yaml.split('\n');
  const keys = lines.filter((line) => /^  [a-z][a-z0-9-]*:$/.test(line)).map((line) => line.trim().replace(':', ''));
  assert.ok(keys.includes('service'));
  assert.ok(keys.includes('web'));
  // A provider block (kv,, a database) is not a service: only the app's own
  // services carry the service- prefix.
  assert.deepEqual(keys.filter((key) => key.startsWith('service-')), []);
  assert.match(yaml, /context: \.\/service$/m);
  assert.equal(yaml.includes('service-'), false);
});

test('compose: a second service gets only the binds it names', async () => {
  const mod = parse(twoServices, 'main.arc');
  const yaml = composeYaml(mod, 8080, false);
  const cache = yaml.slice(yaml.indexOf('  service-cache:'));
  assert.match(cache, /context: \.\/service-cache/);
  // Store names db: kv, Cache names nothing: the cache container must not
  // receive the store's database.
  assert.equal(cache.includes('KV_HOST'), false, cache);
  assert.equal(cache.includes('REDIS_URL'), false, cache);
  const store = yaml.slice(yaml.indexOf('  service:'), yaml.indexOf('  service-cache:'));
  assert.match(store, /KV_HOST: "kv"/);
});

test('run endpoints: every service gets its published port', () => {
  const endpoints = serviceEndpoints(parse(twoServices, 'main.arc'), 8080);
  assert.deepEqual(endpoints.map((item) => [item.name, item.port]), [['Store', 8080], ['Cache', 8081]]);
  assert.deepEqual(endpoints.map((item) => item.url), ['http://localhost:8080', 'http://localhost:8081']);
  assert.deepEqual(serviceEndpoints(parse(oneService, 'main.arc'), 8080).map((item) => item.name), ['Store']);
});

// The OpenAPI document publishes public surface only, so this fixture marks
// its operations public.
const openapiSpec = `
module shop @0.1.0 {}

type Item = { id: string, title: string }

service Store : http {
  contract {
    public op create(title: string) -> Item {
      route: "POST /v1/items"
    }
  }
}

service Cache : http {
  contract {
    public op get(key: string) -> string {
      route: "GET /v1/cache/:key"
    }
  }
}
`;

test('openapi: a module with two services documents both', () => {
  const mod = parse(openapiSpec, 'main.arc');
  const document = emitOpenapi(mod);
  const paths = Object.keys(document.paths as Record<string, unknown>);
  assert.ok(paths.includes('/v1/items'), paths.join(','));
  assert.ok(paths.includes('/v1/cache/{key}'), paths.join(','));
  const cache = emitOpenapi(mod, { service: 'Cache' });
  assert.deepEqual(Object.keys(cache.paths as Record<string, unknown>), ['/v1/cache/{key}']);
});

test('openapi: two services on one route are refused, not silently merged', () => {
  const clashing = openapiSpec.replace('route: "GET /v1/cache/:key"', 'route: "POST /v1/items"');
  assert.throws(() => emitOpenapi(parse(clashing, 'main.arc')), /declared by both Store\.create and Cache\.get/);
});

// A proto or an SDL document describes one service. With two services the
// emitters used to answer for the first and stay quiet about the second; they
// now name the declaration and ask for --service.
test('grpc and graphql: several services are named, not silently narrowed', () => {
  const mod = parse(twoServices, 'main.arc');
  assert.throws(() => grpcProto(mod), /declares 2 services \(Store, Cache\); pass --service/);
  assert.throws(() => graphqlSchema(mod), /declares 2 services \(Store, Cache\); pass --service/);
  assert.match(grpcProto(mod, { service: 'Cache' }), /Cache/);
  assert.match(graphqlSchema(mod, { service: 'Cache' }), /Cache/);
});

// The cluster view owes the same topology as compose: a Deployment and a
// Service per internal service, its own image, its own env, and an Ingress
// path per route set. A manifest that draws one workload loses the other half
// of the spec exactly like compose did before B75.
test('k8s: every internal service gets a Deployment and a Service', () => {
  const mod = parse(twoServices, 'main.arc');
  const files = k8sManifests(mod, { host: 'shop.example.com' });
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes('service.yaml'), paths.join(','));
  assert.ok(paths.includes('service-cache.yaml'), paths.join(','));
  const store = files.find((file) => file.path === 'service.yaml')!.content;
  const cache = files.find((file) => file.path === 'service-cache.yaml')!.content;
  const image = (content: string) => /image: (.+)/.exec(content)![1].trim();
  assert.match(store, /kind: Deployment[\s\S]*kind: Service/);
  assert.match(cache, /kind: Deployment[\s\S]*kind: Service/);
  assert.notEqual(image(store), image(cache));
  // The cache names no bind: the store's kv url must not ride along.
  const configMap = files.find((file) => file.path === 'configmap.yaml')!.content;
  assert.match(configMap, /KV_HOST/);
  assert.doesNotMatch(cache, /configMapRef|KV_HOST/);
});

test('k8s: the ingress routes each service by its route roots', () => {
  const mod = parse(twoServices, 'main.arc');
  const ingress = k8sManifests(mod, { host: 'shop.example.com' })
    .find((file) => file.path === 'ingress.yaml')!.content;
  assert.match(ingress, /path: \/v1\/items[\s\S]*name: service\n/);
  assert.match(ingress, /path: \/v1\/cache[\s\S]*name: service-cache/);
  assert.match(ingress, /path: \/\n/);
});

test('k8s: a one-service module keeps the historical service.yaml', () => {
  const mod = parse(oneService, 'main.arc');
  const files = k8sManifests(mod, { host: 'shop.example.com' });
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes('service.yaml'), paths.join(','));
  assert.ok(!paths.some((path) => path.startsWith('service-')), paths.join(','));
  const ingress = files.find((file) => file.path === 'ingress.yaml')!.content;
  assert.match(ingress, /path: \/\n/);
  assert.equal(ingress.match(/path: /g)!.length, 1);
});


// A chart cannot hard-code an image it is supposed to configure: each later
// service reads its own values entry, and the first keeps the familiar
// image.repository/tag pair.
test('helm: a multi-service chart exposes one values entry per service', () => {
  const mod = parse(twoServices, 'main.arc');
  const files = helmChart(mod, { host: 'shop.example.com' });
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes('templates/service.yaml'), paths.join(','));
  assert.ok(paths.includes('templates/service-cache.yaml'), paths.join(','));
  const values = files.find((file) => file.path === 'values.yaml')!.content;
  assert.match(values, /services:\n  service:\n    repository: /);
  assert.match(values, /service-cache:\n    repository: /);
  const first = files.find((file) => file.path === 'templates/service.yaml')!.content;
  const second = files.find((file) => file.path === 'templates/service-cache.yaml')!.content;
  assert.match(first, /image: \{\{ \.Values\.image\.repository \}\}/);
  assert.match(second, /image: \{\{ index \.Values\.services "service-cache" "repository" \}\}/);
});

test('helm: a one-service chart keeps the single values shape', () => {
  const mod = parse(oneService, 'main.arc');
  const values = helmChart(mod, { host: 'shop.example.com' })
    .find((file) => file.path === 'values.yaml')!.content;
  assert.doesNotMatch(values, /^services:/m);
});


// Each service owns its store, so each store owns its migration plan: a build
// that writes only the first plan tells the second container to start against
// a schema nobody shipped.
const twoStores = twoServices.replace('service Cache : http {\n  contract {', 'service Cache : http {\n  uses cache: kv\n  contract {');

test('build: every service with a store gets its own migration plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-multi-'));
  try {
    const result = await buildExample(parse(twoStores, 'main.arc'), root, { port: 8080 });
    const store = await readFile(join(result.dir, 'migrations', 'changelog.json'), 'utf8');
    const cache = await readFile(join(result.dir, 'migrations-service-cache', 'changelog.json'), 'utf8');
    assert.match(store, /"name": "item"/);
    assert.match(cache, /"name": "arcod_kv"/);
    // With no impl bodies the type list still decides tables, so the second
    // plan carries the declared records too; what matters here is that its own
    // store plan exists at all.
    assert.ok(existsSync(join(result.dir, 'migrations-service-cache', '0001_arcod_kv.up.sql')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('build: a second service without a store writes no migration directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-multi-'));
  try {
    const result = await buildExample(parse(twoServices, 'main.arc'), root, { port: 8080 });
    const entries = await readdir(result.dir);
    assert.ok(entries.includes('migrations'));
    assert.ok(!entries.includes('migrations-cache'), entries.join(','));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


// Two services with examples: the runner used to start only the first context
// and print a green report for half the module. Both are asked now, and the
// shared report names whose example it is.
const twoAlive = `
module shop @0.1.0 {}

type Item = { id: string, title: string }

environment dev {
  bind db -> redis
}

service Store : http {
  uses db: kv

  effects { allow db.set, db.get, db.del }

  contract {
    public op create(title: string) -> Item { route: "POST /v1/items" }
    public op read(id: string) -> Item { route: "GET /v1/items/:id" }
  }

  examples {
    example store_alive {
      when { let item = create("a") }
      then { item.title == "a" }
    }
  }
}

service Cache : http {
  uses db: kv

  effects { allow db.set, db.get, db.del }

  contract {
    public op create(title: string) -> Item { route: "POST /v1/cache" }
    public op read(id: string) -> Item { route: "GET /v1/cache/:id" }
  }

  examples {
    example cache_alive {
      when { let item = create("b") }
      then { item.title == "b" }
    }
  }
}
`;

test('test: every service with examples is started and reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-multi-'));
  try {
    const mod = parse(twoAlive, 'main.arc');
    const result = await buildExample(mod, root, { port: 8080, reference: true });
    const report = await runExamples(mod, result.dir);
    const names = report.examples.map((entry) => entry.example);
    assert.ok(names.includes('Store / store_alive'), names.join(','));
    assert.ok(names.includes('Cache / cache_alive'), names.join(','));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

