import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { composeYaml } from '../src/emit/compose.ts';

const twoBinds = `
module saga @0.1.0 {}

use capability arcod.std.kv @1

type Item = { id: uuid, label: string }

service Orders : http {
  uses store: kv
  uses events: queue

  contract {
    public op put(label: string) -> Item {
      route: "POST /v1/put"
      effects: store.insert
    }
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind events -> redis(host: "kv", port: 6379)
  deploy docker
}
`;

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('two binds to the same redis host render one compose service', () => {
  const yaml = composeYaml(parse(twoBinds, 'main.arc'), 8080, false);
  assert.equal(count(yaml, '\n  kv:\n'), 1, 'the kv service key appears once');
  assert.equal(count(yaml, 'redis:7-alpine'), 1, 'the image is written once');
  assert.equal(count(yaml, '\n      kv:\n'), 1, 'depends_on names kv once');
  // Both binds keep their environment, disambiguated by alias.
  assert.match(yaml, /KV_HOST: "kv"/);
  assert.match(yaml, /KV_HOST_EVENTS: "kv"/);
});

test('different hosts still render separate services', () => {
  const yaml = composeYaml(parse(twoBinds.replace('bind events -> redis(host: "kv", port: 6379)', 'bind events -> redis(host: "bus", port: 6379)'), 'main.arc'), 8080, false);
  assert.equal(count(yaml, '\n  kv:\n'), 1);
  assert.equal(count(yaml, '\n  bus:\n'), 1);
  assert.equal(count(yaml, 'redis:7-alpine'), 2);
});

test('the saga example builds a compose file with a single kv', async () => {
  const spec = await readFile(new URL('../examples/saga/main.arc', import.meta.url), 'utf8');
  const yaml = composeYaml(parse(spec, 'main.arc'), 8080, false);
  assert.equal(count(yaml, '\n  kv:\n'), 1);
  assert.equal(count(yaml, '\n      kv:\n'), 1);
});
