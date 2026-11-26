import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

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
