// The contract a generated service answers: routes, input kinds and (later)
// outcomes. Go and Python kits must speak the contract the Node emitter speaks,
// so the parts a language changes only by template live here, once. A copy per
// emitter is the fork B108 warns about.
import type { ModuleNode, OpNode } from '../ast.ts';
import { baseType } from '../migrate.ts';

export interface RouteParts {
  method: string;
  path: string;
}

// 'post /v1/items' and 'POST /v1/items' are one route: check looks the method
// up case-insensitively (A070), the runtime compares it uppercased. Emitting
// the written casing made a lowercase route answer 404 forever, so every
// reader goes through this parse.
export function parseRoute(op: OpNode): RouteParts | null {
  const clause = op.clauses.find((item) => item.kind === 'route');
  if (!clause || clause.kind !== 'route') return null;
  const parts = clause.value.trim().split(/\s+/);
  const method = (parts[0] || 'GET').toUpperCase();
  const path = parts.slice(1).join(' ') || '/' + op.name;
  return { method, path };
}

// Scalars a URL carries as text. A ':id' capture or '?limit=3' reaches the
// body as a string while the same parameter in a JSON body arrives typed, so
// the boundary coerces these back to the declared scalar; the table is part of
// the contract, not of the Node emitter.
export const INPUT_KINDS = ['int', 'number', 'decimal', 'float', 'bool', 'boolean'] as const;

export type InputKind = (typeof INPUT_KINDS)[number];

export function inputKinds(mod: ModuleNode, op: OpNode): Record<string, string> {
  const table: Record<string, string> = {};
  for (const param of op.params) {
    const base = baseType(mod, param.type);
    if ((INPUT_KINDS as readonly string[]).includes(base)) {
      table[param.name] = base === 'boolean' ? 'bool' : base;
    }
  }
  return table;
}

// Every successful answer the operation declares, in declaration order. The
// first one is the default: a body that names no outcome gets it, which keeps
// the single-code `status: 200` form and the derived 200/201 rule intact.
export interface SuccessOutcome { name: string | null; code: number }

export function successOutcomes(op: OpNode): SuccessOutcome[] {
  const declared = op.clauses.find((clause) => clause.kind === 'status');
  if (declared && declared.kind === 'status') {
    return declared.outcomes.map((outcome) => ({ name: outcome.name, code: outcome.value }));
  }
  const route = parseRoute(op);
  const method = route ? route.method : 'GET';
  return [{ name: null, code: method === 'GET' || method === 'HEAD' ? 200 : 201 }];
}

// The answer a successful call gets. A declared `status` wins (an idempotent
// POST action creates nothing); otherwise a read is 200 and a write is 201.
// The runtime and OpenAPI used two different tables — DELETE was 200 in the
// document and 201 in the response, and the response is what the examples and
// the emitted handlers were built around — so the rule lives here now and both
// callers read it.
export function successStatus(op: OpNode): number {
  return successOutcomes(op)[0].code;
}

export interface ContractOp {
  name: string;
  route: RouteParts | null;
  inputKinds: Record<string, string>;
}

// One operation as every emitter sees it. A service's contract keeps the
// declaration order, so two emitters that walk this list produce the same
// routes in the same order.
export function contractOps(mod: ModuleNode, ops: OpNode[]): ContractOp[] {
  return ops
    .filter((op) => op.kind === 'op')
    .map((op) => ({ name: op.name, route: parseRoute(op), inputKinds: inputKinds(mod, op) }));
}
