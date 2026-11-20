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

test('the broker URL comes from the bind that carries the capability, not the first redis', () => {
  const spec = `
module cache @0.1.0 {}

use capability arcod.std.kv @1
use capability arcod.std.stream @1

service Chat : http {
  uses store: kv
  uses bus: stream

  effects {
    allow bus.publish
  }

  contract {
    public op send(text: string) -> bool {
      route: "POST /v1/send"
    }
  }
}

environment dev {
  bind store -> redis(host: "cache", port: 6379)
  bind bus -> redis(host: "bus", port: 6379)
  deploy docker
}
`;
  const yaml = composeYaml(parse(spec, 'main.arc'), 8080, false);
  assert.match(yaml, /STREAM_REDIS_URL: "redis:\/\/bus:6379"/);
  assert.match(yaml, /REDIS_URL: "redis:\/\/cache:6379"/);
  assert.equal(/QUEUE_REDIS_URL/.test(yaml), false, 'nothing uses the queue');
});

test('a kv-only app gets no broker URL', () => {
  const spec = `
module plain @0.1.0 {}

use capability arcod.std.kv @1

service Notes : http {
  uses store: kv

  contract {
    public op get(id: string) -> string {
      route: "GET /v1/notes/:id"
    }
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  deploy docker
}
`;
  const yaml = composeYaml(parse(spec, 'main.arc'), 8080, false);
  assert.match(yaml, /REDIS_URL: "redis:\/\/kv:6379"/);
  assert.equal(/STREAM_REDIS_URL/.test(yaml), false);
  assert.equal(/QUEUE_REDIS_URL/.test(yaml), false);
});

test('the queue URL follows the queue alias when the binds point at different hosts', () => {
  const yaml = composeYaml(parse(twoBinds.replace('bind events -> redis(host: "kv", port: 6379)', 'bind events -> redis(host: "bus", port: 6379)'), 'main.arc'), 8080, false);
  assert.match(yaml, /QUEUE_REDIS_URL: "redis:\/\/bus:6379"/);
});
