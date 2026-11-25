// The proto emitter's scalar table is keyed by type name. It was read with a
// plain index, so a type alias called toString found Object.prototype.toString
// (which has no startsWith) and grpcProto threw "scalar.startsWith is not a
// function" for a spec check had accepted. The table is a record of declared
// scalar names, so the question is an own-key one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { grpcProto } from '../src/emit/grpc.ts';

const SPEC = `module grpcproto @0.1.0 {}

type toString = string
type valueOf = int

service S : grpc {
  contract {
    public op ping(a: toString, b: valueOf, c: string) -> string {
      route: "POST /v1/ping"
    }
  }
}
`;

test('a type alias named like a prototype member still emits its scalar', () => {
  const proto = grpcProto(parse(SPEC, 'main.arc'), {});
  assert.match(proto, /\bstring a = 1;/);
  assert.match(proto, /\bint64 b = 2;/);
  assert.match(proto, /\bstring c = 3;/);
  assert.doesNotMatch(proto, /native code/);
});
