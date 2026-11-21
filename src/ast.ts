// Canonical AST. The syntax is only a surface; everything below is what the
// compiler, the planner and the emitters work with.

export interface Loc {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  offset: number;
  end: number;
}

export interface ModuleNode {
  kind: 'module';
  name: string;
  version: string;
  meta: Record<string, string>;
  // Offsets of the `meta { ... }` block and of each entry, so fmt can keep a
  // comment written inside the block where the author put it.
  metaLoc?: Loc;
  metaEntryLocs?: Loc[];
  uses: UseNode[];
  types: TypeDecl[];
  errors: ErrorDecl[];
  enums: EnumDecl[];
  services: ServiceNode[];
  workflows: WorkflowNode[];
  environments: EnvironmentNode[];
  uis: UiNode[];
  file: string;
  source: string;
  loc: Loc;
}

export interface UseNode {
  kind: 'use';
  what: 'module' | 'capability';
  name: string;
  version?: string;
  loc: Loc;
}

export interface TypeDecl {
  kind: 'type';
  name: string;
  type: TypeExpr;
  loc: Loc;
}

export interface ErrorDecl {
  kind: 'error';
  name: string;
  fields: Param[];
  loc: Loc;
}

export interface EnumDecl {
  kind: 'enum';
  name: string;
  values: string[];
  // One loc per value, so fmt can keep a comment written above a value.
  // Optional: specs adopted from OpenAPI have no source offsets.
  valueLocs?: Loc[];
  loc: Loc;
}

export type TypeExpr =
  | { kind: 'named'; name: string; args: TypeArg[]; loc: Loc }
  | { kind: 'optional'; inner: TypeExpr; loc: Loc }
  | { kind: 'union'; variants: TypeExpr[]; loc: Loc }
  | { kind: 'record'; fields: Param[]; loc: Loc };

export interface TypeArg {
  name?: string;
  value: Expr | TypeExpr;
  isType?: boolean;
  loc: Loc;
}

export interface Param {
  name: string;
  type: TypeExpr;
  default?: Expr;
  loc: Loc;
}

// A workflow is a declared graph of steps. Edges are explicit (`needs`), data
// travels through typed ports, and the trigger says when the graph starts.
// Nothing here is executed by arcod itself: the graph is a contract for the
// environment's runner.
export interface WorkflowNode {
  kind: 'workflow';
  name: string;
  trigger: TriggerNode | null;
  overlap: 'skip' | 'queue' | 'parallel' | null;
  catchup: 'none' | 'last' | 'all' | null;
  retry: number | null;
  timeout: Expr | null;
  steps: WorkflowStepNode[];
  // Locations of the clause keywords (trigger/overlap/...), keyed by keyword.
  // fmt needs them to keep a comment written above a clause on that clause's
  // line instead of sliding it onto the first step or out of the block.
  clauseLocs?: Record<string, Loc>;
  // The closing brace: a comment written after the last step belongs to the
  // block and must not slide past it to the end of the file.
  closeLoc?: Loc;
  // Clauses written twice on one workflow. The first keeps its value; the
  // second is kept here so the checker can report it instead of losing it.
  duplicates?: Array<{ key: string; loc: Loc }>;
  loc: Loc;
}

export interface TriggerNode {
  kind: string;
  args: Arg[];
  loc: Loc;
}

export interface WorkflowStepNode {
  name: string;
  params: Param[];
  returns: TypeExpr | null;
  // Operation (or single-step job) whose body this step runs.
  call: string | null;
  needs: string[];
  effects: string[];
  onFail: 'stop' | 'skip' | 'retry' | 'continue' | null;
  retry: number | null;
  timeout: Expr | null;
  // Locations of the clause keywords, keyed by the canonical name (onFail,
  // whatever the source spelling). fmt keeps a comment on its own clause.
  clauseLocs?: Record<string, Loc>;
  // The closing brace, for a comment written after the last clause.
  closeLoc?: Loc;
  // Clauses written twice on one step: first wins, the copy is reported.
  duplicates?: Array<{ key: string; loc: Loc }>;
  loc: Loc;
}

export interface SagaStepNode {
  name: string;
  // The operation this step runs: an unqualified name is the service's own op
  // (invoked in-process); a qualified name (Service.op) is an external service
  // (invoked through remoteCall).
  call: string | null;
  // The compensating operation, run when a later step fails, in reverse order.
  compensate: string | null;
  retry: number | null;
  // Clause keywords and the closing brace. A saga step prints on one line
  // until a comment lands on a clause; then it goes multi-line, as a record
  // with a commented field does.
  clauseLocs?: Record<string, Loc>;
  closeLoc?: Loc;
  loc: Loc;
}

// A saga is a declared, linear multi-step operation with compensation. Unlike a
// workflow (an external-runner contract), the runtime executes a saga itself:
// steps run in order, a failed step is retried, and on final failure the
// completed steps are compensated in reverse. Triggered by a job with
// 'saga: <name>'.
export interface SagaNode {
  kind: 'saga';
  name: string;
  steps: SagaStepNode[];
  loc: Loc;
}

export interface ServiceNode {
  kind: 'service';
  name: string;
  impl: string;
  external: boolean;
  meta: Record<string, string>;
  metaLoc?: Loc;
  metaEntryLocs?: Loc[];
  uses: CapUse[];
  contract: OpNode[];
  sagas: SagaNode[];
  rules: RuleNode[];
  // The role vocabulary the service understands; operations reference it via
  // the `roles:` clause. Roles themselves arrive with the token, the service
  // only declares which ones mean something here.
  roles: string[];
  effects: EffectsNode | null;
  examples: ExampleNode[];
  budget: BudgetNode | null;
  // Closing braces of the blocks that are not nodes of their own, keyed by
  // keyword. fmt needs them to keep a comment written after the brace on that
  // brace instead of dropping it.
  blockCloses?: Partial<Record<'contract' | 'rules' | 'effects' | 'examples' | 'budget', Loc>>;
  // Keywords of the blocks that are not nodes. Without an anchor a comment
  // written above the block slid inside it, onto the first child.
  blockOpens?: Partial<Record<'contract' | 'rules' | 'examples', Loc>>;
  loc: Loc;
}

export interface CapUse {
  kind: 'uses';
  alias: string;
  capability: string;
  params: Record<string, Expr>;
  loc: Loc;
}

export interface OpNode {
  kind: 'op' | 'job';
  name: string;
  isPublic: boolean;
  // `auth op` requires an authenticated actor; anonymous callers get 401
  // before the body runs. Mutually exclusive with isPublic.
  auth: boolean;
  params: Param[];
  returns: TypeExpr | null;
  clauses: Clause[];
  loc: Loc;
}

export type Clause =
  | { kind: 'errors'; names: string[]; loc: Loc }
  // Effects this operation uses, e.g. store.get, files.put. Optional: when
  // absent the planner infers them from parameter and return shapes.
  | { kind: 'effects'; names: string[]; loc: Loc }
  | { kind: 'pre' | 'post'; expr: Expr; loc: Loc }
  | { kind: 'onerror'; error: string; expr: Expr; loc: Loc }
  | { kind: 'route'; value: string; loc: Loc }
  | { kind: 'schedule'; value: string; loc: Loc }
  // A job consumes a queue topic: the runtime starts a consumer before the
  // http server and routes each message to the job body. Retry counts the
  // attempts after the first one before the message lands in the dead letter.
  | { kind: 'consume'; source: string; loc: Loc }
  // A job may run a saga instead of a body: each message drives the saga's
  // steps to completion (or compensation) through the saga runner.
  | { kind: 'saga'; name: string; loc: Loc }
  | { kind: 'retry'; value: number; loc: Loc }
  // Access control, enforced by the generated runtime before the body runs:
  // `roles: admin, manager` requires one of the token roles (403 otherwise),
  // `owner: id` requires the record loaded by param `id` to belong to the
  // actor (403 otherwise; admins bypass, a missing record is NotFound).
  | { kind: 'roles'; names: string[]; loc: Loc }
  | { kind: 'owner'; param: string; loc: Loc }
  | { kind: 'idempotent'; loc: Loc }
  | { kind: 'since'; value: string; loc: Loc };

export type RuleNode =
  | { kind: 'invariant'; name: string; expr: Expr; loc: Loc }
  | { kind: 'atomic'; name: string; steps: string[]; loc: Loc }
  | { kind: 'ordering'; pairs: Array<[string, string]>; loc: Loc }
  // One field or a tuple on the same record: unique Fence.name and
  // unique Fence.(name, fence) / unique Fence.name, Fence.fence.
  | { kind: 'unique'; path: string; fields: string[]; loc: Loc }
  // A non-unique index: same Type.field path, no claim, no error.
  | { kind: 'index'; path: string; loc: Loc };

export interface EffectsNode {
  kind: 'effects';
  allow: string[];
  deny: string[];
  // The `allow`/`deny` keywords: fmt keeps a comment written above them on
  // the line they introduce.
  clauseLocs?: Record<string, Loc>;
  // One location per effect name (`allow store.get`), parallel to `allow` and
  // `deny`. A comment on a single name makes the list print one name per line.
  nameLocs?: { allow: Loc[]; deny: Loc[] };
  loc: Loc;
}

export interface ExampleNode {
  kind: 'example';
  name: string;
  given: Stmt[];
  when: Stmt[];
  then: Stmt[];
  // Closing brace of each section: a comment after the last statement of a
  // section that is not the last one must stay in it, not move to the next.
  sectionCloses?: Partial<Record<'given' | 'when' | 'then', Loc>>;
  loc: Loc;
}

export type Stmt =
  | { kind: 'let'; name: string; expr: Expr; loc: Loc }
  | { kind: 'expr'; expr: Expr; loc: Loc };

export type Expr =
  | { kind: 'literal'; value: string | number | boolean | null; raw: string; loc: Loc }
  | { kind: 'duration'; value: number; unit: string; loc: Loc }
  | { kind: 'ident'; name: string; loc: Loc }
  | { kind: 'member'; object: Expr; property: string; loc: Loc }
  | { kind: 'call'; callee: Expr; args: Arg[]; loc: Loc }
  | { kind: 'list'; items: Expr[]; loc: Loc }
  | { kind: 'record'; fields: Array<{ name: string; value: Expr; loc: Loc }>; loc: Loc }
  | { kind: 'unary'; op: string; operand: Expr; loc: Loc }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; loc: Loc }
  | { kind: 'is'; expr: Expr; error: string; loc: Loc };

export interface Arg {
  name?: string;
  value: Expr;
  loc: Loc;
}

export interface BudgetNode {
  kind: 'budget';
  items: Array<{ key: string; op: string | null; expr: Expr; loc: Loc }>;
  loc: Loc;
}

export interface UiSlide {
  title: string;
  body: string | null;
  // Location of the `body` value: a comment written above the line belongs to
  // it, and without the offset the printer cannot place it inside the slide.
  bodyLoc?: Loc;
  // Location of the slide's closing brace: comments after the last property
  // still belong inside the slide.
  closeLoc?: Loc;
  loc: Loc;
}

export interface UiNode {
  kind: 'ui';
  name: string;
  impl: string;
  route: string;
  title: string | null;
  uses: string[];
  // Optional layout hint: forms are the default, chat is an explicit choice.
  layout: 'forms' | 'chat' | 'presentation' | null;
  history: string | null;
  send: string | null;
  start: string | null;
  // A presentation page has two audiences (host and guests); every binding
  // is named, never guessed.
  join: string | null;
  state: string | null;
  advance: string | null;
  slides: UiSlide[];
  // BCP-47 tag for the generated pages; null means the 'en' default. It drives
  // the html lang attribute and the page's message catalog.
  locale: string | null;
  // Declared catalogs for a locale switcher: ui { locales: "en, ru" }.
  // Null means the page renders just `locale`.
  locales: string[] | null;
  // Token scheme for the generated pages: 'auto' follows the reader's OS.
  theme: 'auto' | 'light' | 'dark';
  // Where the page is rendered: statically at build (default) or by the
  // service at request time (server-side rendering, B12.6).
  render: 'static' | 'ssr';
  // Locations of the property keywords, keyed by keyword as written in the
  // source ('kind' stays 'kind' even though it fills `impl`). fmt keeps a
  // comment above a property on that property's line.
  clauseLocs?: Record<string, Loc>;
  // The closing brace, for a comment trailing the last property (or a dropped
  // default like `theme: auto`): it stays inside the block.
  closeLoc?: Loc;
  loc: Loc;
}

export interface DeployNode {
  kind: 'deploy';
  provider: string;
  args: Record<string, Expr>;
  loc: Loc;
}

export interface EnvironmentNode {
  kind: 'environment';
  name: string;
  binds: BindNode[];
  deploy: DeployNode | null;
  loc: Loc;
}

export interface BindNode {
  kind: 'bind';
  alias: string;
  provider: string;
  args: Record<string, Expr>;
  guarantees: string[];
  loc: Loc;
}

export function locFrom(start: Loc, end: Loc): Loc {
  return { ...start, endLine: end.endLine, endCol: end.endCol, end: end.end };
}
