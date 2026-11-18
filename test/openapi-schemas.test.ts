import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';

// Builtin refinements are contract facts: a client has to see the same size
// limits and formats the service enforces. These cases were uncovered by the
// emit/openapi.ts branch report and are easy to regress silently.

const refined = `module refine @0.1.0 {}

error NotFound

type RawId = uuid
type Big = bytes(min: 1kb, max: 2gb)
type Small = bytes(max: 255)
type Contact = string(format: email)
type Landing = string(format: url)
type Money = decimal
type Stamp = datetime
type Payload = json

enum Visibility { public, private, unlisted }
type Ids = map<string, RawId>
type Tags = list<RawId>
type Maybe = Payload?
type Choice = string | int

service Refine : http {
  contract {
    public op peek(id: RawId) -> Maybe {
      route: "GET /v1/peek/:id"
      errors: NotFound
      on error NotFound: id != null
    }
  }
}
`;

function schemasOf(source: string): Record<string, any> {
  const mod = parse(source, 'main.arc');
  const diags = check(mod).filter((d) => d.severity === 'error');
  assert.deepEqual(diags, [], 'spec has no errors');
  const doc = emitOpenapi(mod);
  return (doc.components as Record<string, any>).schemas as Record<string, any>;
}

test('openapi: builtin refinements keep their limits and formats', () => {
  const schemas = schemasOf(refined);
  assert.deepEqual(schemas.Big, { type: 'string', minLength: 1024, maxLength: 2 * 1024 * 1024 * 1024 });
  assert.deepEqual(schemas.Small, { type: 'string', maxLength: 255 });
  assert.deepEqual(schemas.Contact, { type: 'string', format: 'email' });
  assert.deepEqual(schemas.Landing, { type: 'string', format: 'uri' });
  assert.deepEqual(schemas.Money, { type: 'number', format: 'decimal' });
  assert.deepEqual(schemas.Stamp, { type: 'string', format: 'date-time' });
  assert.deepEqual(schemas.Payload, {});
  assert.deepEqual(schemas.Visibility, { type: 'string', enum: ['public', 'private', 'unlisted'] });
});

test('openapi: containers and optionals point at named components', () => {
  const schemas = schemasOf(refined);
  const ref = '#/components/schemas/RawId';
  assert.deepEqual(schemas.Ids, { type: 'object', additionalProperties: { $ref: ref } });
  assert.deepEqual(schemas.Tags, { type: 'array', items: { $ref: ref } });
  assert.deepEqual(schemas.Maybe, { anyOf: [{ $ref: '#/components/schemas/Payload' }, { type: 'null' }] });
  assert.deepEqual(schemas.Choice, { anyOf: [{ type: 'string' }, { type: 'integer' }] });
});

test('openapi: two errors on one status become oneOf', () => {
  const source = `module pw @0.1.0 {}

error Forbidden
error WrongPassword

type Password = string(min: 8, max: 128)

service Passwords : http {
  uses auth: identity

  contract {
    auth op change(pw: Password) -> void {
      route: "POST /v1/password"
      errors: Forbidden, WrongPassword
      on error Forbidden: pw != null
      on error WrongPassword: pw != null
    }
  }
}

environment dev {
  bind auth -> keycloak(host: "idp", port: 8080)
}
`;
  const mod = parse(source, 'main.arc');
  assert.deepEqual(check(mod).filter((d) => d.severity === 'error'), []);
  const doc = emitOpenapi(mod);
  const op = (doc.paths as Record<string, any>)['/v1/password'].post;
  assert.equal(op.responses['403'].description, 'Forbidden, WrongPassword');
  assert.equal(op.responses['403'].content['application/json'].schema.oneOf.length, 2);
});
