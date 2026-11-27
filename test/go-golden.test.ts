// The whole Go service of the project1 shape, byte for byte (B107.5). The
// fragment assertions in go-emit.test.ts prove the rules; a golden file proves
// the assembled output did not drift in passing. Regenerate with
// ARCOD_UPDATE_GOLDEN=1 node --test test/go-golden.test.ts when the emitter
// changes on purpose — then read the diff, it is the review.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const golden = join(here, 'golden', 'go-project1');

// project1's model without its ui page: the Go kit refuses a page, and a golden
// of a refused build would pin nothing. Everything the kv kit carries stays:
// the ttl on the store, the once/atomic rules, the declared errors and statuses.
const spec = `module project1 @0.1.0 {}

use capability arcod.std.kv @1

type MessageId = uuid
type Author = bytes(min: 1, max: 255)
type Body = bytes(min: 1, max: 64kb)

error NotFound
error Gone
error Invalid

service OneTimeMessage : http {
  language: go
  uses store: kv(ttl: 999s)

  rules {
    invariant read.at_most_once: once(read, by: id, else: Gone)
    atomic read { get; del }
  }

  contract {
    public op create(author: Author, body: Body) -> MessageId {
      route: "POST /v1/api/messages"
      errors: Invalid
      post: result != null
    }

    public op read(id: MessageId) -> { author: Author, body: Body } {
      route: "GET /v1/api/messages/:id"
      errors: NotFound, Gone
      post: !store.has(id)
    }
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  deploy docker
}
`;

const files = ['main.go', 'ops.go', 'go.mod', 'Dockerfile', join('arcodio', 'arcodio.go')];

test('the generated Go service of the project1 shape matches its golden files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-golden-'));
  const update = process.env.ARCOD_UPDATE_GOLDEN === '1';
  try {
    const mod = parse(spec, 'main.arc');
    const result = await buildExample(mod, dir, { reference: true, implDir: null });
    for (const name of files) {
      const built = join(dir, '.arcod', 'build', 'service', name);
      const text = await readFile(built, 'utf8');
      const store = join(golden, name);
      if (update) {
        await writeFile(store, text, 'utf8');
        continue;
      }
      const expected = await readFile(store, 'utf8');
      assert.equal(text, expected, name + ' drifted from its golden file');
    }
    // The build context holds exactly the Go service files, no Node leftovers.
    assert.deepEqual(
      [...result.files]
        .map((file) => file.split('/').slice(-2).join('/'))
        .filter((file) => file.startsWith('service/') || file.startsWith('arcodio/'))
        .sort(),
      ['arcodio/arcodio.go', 'service/Dockerfile', 'service/go.mod', 'service/main.go', 'service/ops.go'].sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
