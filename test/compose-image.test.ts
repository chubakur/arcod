import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { composeYaml } from '../src/emit/compose.ts';

const spec = `
module notes @0.1.0 {}

use capability arcod.std.kv @1

type Note = { id: string, title: string }

service Notes : http {
  uses store: kv

  contract {
    public op add(title: string) -> Note {
      route: "POST /v1/notes"
      effects: store.insert
    }

    public op get(id: string) -> Note {
      route: "GET /v1/notes/:id"
      effects: store.fetch
    }
  }
}
`;

const body = `export async function add({ title }) {
  return io.insert('Note', { id: io.ids.next(), title });
}
`;

test('compose tags the containers with the build revision', () => {
  const yaml = composeYaml(parse(spec, 'main.arc'), 8080, true, undefined, 'mysql', 'abc123def456');
  assert.match(yaml, /\n  service:\n    image: arcod\/notes-service:abc123def456\n    build:\n      context: \.\/service/, 'service image carries the revision');
  assert.match(yaml, /\n  web:\n    image: arcod\/notes-web:abc123def456\n    build:\n      context: \.\/web/, 'web image carries the revision');
});

test('compose without a revision keeps the untagged form', () => {
  const yaml = composeYaml(parse(spec, 'main.arc'), 8080, true);
  assert.doesNotMatch(yaml, /image: arcod\/notes-/, 'no local image name without a revision');
  assert.match(yaml, /\n  service:\n    build:\n      context: \.\/service/);
});

test('a build and a rebuild of the same bodies share one tag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-image-'));
  try {
    await writeFile(join(root, 'main.arc'), spec);
    await mkdir(join(root, 'impl'));
    await writeFile(join(root, 'impl', 'add.mjs'), body);
    const mod = parse(spec, 'main.arc');

    const first = await buildExample(mod, root, { port: 8080 });
    assert.equal(first.images.length, 1, 'only the service gets an image without a page');
    assert.match(first.images[0], /^arcod\/notes-service:[0-9a-f]{12}$/);

    const second = await buildExample(mod, root, { port: 8080 });
    assert.deepEqual(second.images, first.images, 'unchanged inputs keep the tag');

    // Same content, different timestamp on disk: still the same tag, so the
    // image is reused and nothing is rebuilt for a no-op.
    const compose = await readFile(join(root, '.arcod', 'build', 'docker-compose.yml'), 'utf8');
    assert.ok(compose.includes('image: ' + first.images[0]), 'compose refers to the tag');

    // A single changed body is a new image, which is exactly what a plain
    // `docker compose up` needs to stop running the old one.
    await writeFile(join(root, 'impl', 'add.mjs'), body.replace("io.ids.next()", "'fixed'"));
    const third = await buildExample(mod, root, { port: 8080 });
    assert.notDeepEqual(third.images, first.images, 'a changed body changes the tag');
    const rewritten = await readFile(join(root, '.arcod', 'build', 'docker-compose.yml'), 'utf8');
    assert.ok(rewritten.includes('image: ' + third.images[0]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
