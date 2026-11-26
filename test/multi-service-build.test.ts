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
