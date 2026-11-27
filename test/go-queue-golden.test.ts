// The Go service of the orders shape, byte for byte: a kv store, a queue and
// the author's Go body that uses both. The fragment tests prove the rules;
// this golden proves the assembled service — body splicing, the facade file
// set and the queue file — did not drift in passing. Regenerate with
// ARCOD_UPDATE_GOLDEN=1 node --test test/go-queue-golden.test.ts, then read
// the diff: it is the review.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const golden = join(here, 'golden', 'go-queue');

const spec = `module orders @0.1.0 {}

use capability arcod.std.kv @1
use capability arcod.std.queue @1

type OrderId = uuid
type Sku = bytes(min: 1, max: 64)

error Invalid

service Orders : http {
  language: go
  uses store: kv
  uses events: queue

  contract {
    public op place(id: OrderId, sku: Sku) -> { id: OrderId, sku: Sku } {
      route: "POST /v1/orders"
      errors: Invalid
      status: 201
    }
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind events -> redis(host: "q", port: 6379)
  deploy docker
}
`;

// The author's body: the facade is the whole API — io.KV for the store, the
// io.QueuePublish half for the announcement.
const body = `// Place the order and announce it.
func opPlace(io *arcodio.IO, in map[string]any) (any, error) {
	id, _ := in["id"].(string)
	sku, _ := in["sku"].(string)
	if sku == "" {
		return nil, ErrInvalid
	}
	if err := io.KV.Set("order:"+id, sku, 0); err != nil {
		return nil, err
	}
	if _, err := io.QueuePublish("orders.created", map[string]any{"id": id, "sku": sku}); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "sku": sku}, nil
}
`;

const files = ['main.go', 'ops.go', 'go.mod', 'Dockerfile', join('arcodio', 'arcodio.go'), join('arcodio', 'queue.go')];

test('the go service of the orders shape matches its golden files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-golden-q-'));
  const update = process.env.ARCOD_UPDATE_GOLDEN === '1';
  try {
    await mkdir(join(dir, 'impl'), { recursive: true });
    await writeFile(join(dir, 'impl', 'place.go'), body, 'utf8');
    const mod = parse(spec, 'main.arc');
    const result = await buildExample(mod, dir, { reference: true });
    assert.ok(result.files.some((file) => file.endsWith(join('arcodio', 'queue.go'))));
    for (const name of files) {
      const built = join(dir, '.arcod', 'build', 'service', name);
      const text = await readFile(built, 'utf8');
      const store = join(golden, name);
      if (update) {
        await mkdir(dirname(store), { recursive: true });
        await writeFile(store, text, 'utf8');
        continue;
      }
      const expected = await readFile(store, 'utf8');
      assert.equal(text, expected, name + ' drifted from its golden file');
    }
    // The body replaced the stub; it did not add a second opPlace.
    const ops = await readFile(join(dir, '.arcod', 'build', 'service', 'ops.go'), 'utf8');
    assert.equal(ops.match(/func opPlace\(/g)?.length, 1);
    assert.doesNotMatch(ops, /NotImplemented/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
