import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { deployManifest, imageContract } from '../src/deploy.ts';
import { k8sManifests } from '../src/emit/k8s.ts';

// An image name is a contract between the build and every runner. It comes
// from the spec version, can be redirected to a registry or pinned explicitly,
// and lands in deploy.<env>.json with its parts, so a CI job never guesses.

const tasksUrl = new URL('../examples/tasks/main.arc', import.meta.url);

// No explicit image: the contract has to derive one.
function unpinned(deployArgs = ''): ReturnType<typeof parse> {
  const source = [
    'module board @0.1.0 {}',
    'type Card = { id: uuid, title: string }',
    'service Board : http {',
    '  contract { public op create(id: uuid, title: string) -> Card { route: "POST /v1/c" } }',
    '}',
    'environment prod {',
    '  deploy yandex(region: "ru-central1", folder: "f", service: "board"' + deployArgs + ')',
    '}',
  ].join('\n');
  return parse(source, 'main.arc');
}

test('the default image is arcod/<module>-<service>:<spec version>', () => {
  const mod = unpinned();
  const env = mod.environments[0];
  assert.deepEqual(imageContract(mod, env, 'Board'), {
    registry: '',
    repository: 'arcod/board-Board',
    tag: '0.1.0',
    image: 'arcod/board-Board:0.1.0',
  });
});

test('a registry and repository redirect the image without changing the tag', () => {
  const mod = unpinned(', registry: "cr.yandex/arcod", repository: "board"');
  const contract = imageContract(mod, mod.environments[0], 'Board');
  assert.equal(contract.image, 'cr.yandex/arcod/board:0.1.0');
  assert.equal(contract.registry, 'cr.yandex/arcod');
  assert.equal(contract.repository, 'board');
  assert.equal(contract.tag, '0.1.0');
});

test('an explicit image wins and semver metadata becomes a legal tag', async () => {
  const mod = parse(await readFile(tasksUrl, 'utf8'), 'main.arc');
  const env = mod.environments.find((item) => item.name === 'prod')!;
  assert.equal(imageContract(mod, env, 'TaskBoard').image, 'cr.yandex/arcod/tasks:0.1.0');

  mod.version = '0.2.0+build.7';
  const derived = unpinned();
  derived.version = '0.2.0+build.7';
  assert.equal(imageContract(derived, derived.environments[0], 'Board').tag, '0.2.0-build.7');
});

test('a pinned image with a port is split into registry, repository and tag', () => {
  const mod = unpinned(', image: "registry.local:5000/team/board:9.9.9"');
  const contract = imageContract(mod, mod.environments[0], 'Board');
  assert.equal(contract.image, 'registry.local:5000/team/board:9.9.9');
  assert.equal(contract.registry, 'registry.local:5000');
  assert.equal(contract.repository, 'team/board');
  assert.equal(contract.tag, '9.9.9');
});

test('k8s renders the same image name the manifest publishes', async () => {
  const mod = parse(await readFile(tasksUrl, 'utf8'), 'main.arc');
  const render = (environment?: string) => {
    const deployment = k8sManifests(mod, { environment })
      .find((file) => file.path === 'service.yaml');
    assert.ok(deployment, 'the service workload is rendered');
    const line = deployment.content.split('\n').find((item) => item.trim().startsWith('image:'));
    return line!.trim().slice('image:'.length).trim();
  };
  assert.equal(render('prod'), 'cr.yandex/arcod/tasks:0.1.0', 'prod contract');
  assert.equal(render(), 'arcod/tasks-TaskBoard:0.1.0', 'first deploy env contract');
});

test('the deploy manifest carries images and their parts', async () => {
  const mod = parse(await readFile(tasksUrl, 'utf8'), 'main.arc');
  const env = mod.environments.find((item) => item.name === 'prod')!;
  const manifest = deployManifest(mod, env) as {
    services: Array<{ name: string; image: string; tag: string }>;
    images: Record<string, { image: string; repository: string }>;
  };
  const svc = manifest.services.find((item) => item.name === 'TaskBoard')!;
  assert.equal(svc.image, 'cr.yandex/arcod/tasks:0.1.0');
  assert.equal(svc.tag, '0.1.0');
  assert.equal(manifest.images.TaskBoard.image, svc.image);
  assert.equal(manifest.images.TaskBoard.repository, 'arcod/tasks');
});
