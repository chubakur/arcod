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
  loc: Loc;
}

export interface ServiceNode {
  kind: 'service';
  name: string;
  impl: string;
  external: boolean;
  meta: Record<string, string>;
  uses: CapUse[];
  contract: OpNode[];
  rules: RuleNode[];
  effects: EffectsNode | null;
  examples: ExampleNode[];
  budget: BudgetNode | null;
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
  | { kind: 'idempotent'; loc: Loc }
  | { kind: 'since'; value: string; loc: Loc };

export type RuleNode =
  | { kind: 'invariant'; name: string; expr: Expr; loc: Loc }
  | { kind: 'atomic'; name: string; steps: string[]; loc: Loc }
  | { kind: 'ordering'; pairs: Array<[string, string]>; loc: Loc }
  | { kind: 'unique'; path: string; loc: Loc };

export interface EffectsNode {
  kind: 'effects';
  allow: string[];
  deny: string[];
  loc: Loc;
}

export interface ExampleNode {
  kind: 'example';
  name: string;
  given: Stmt[];
  when: Stmt[];
  then: Stmt[];
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

// A widget is content on a slide, not part of the service: the page owns it
// and the service only counts what it receives.
export interface UiWidget {
  kind: 'poll' | 'rating' | 'comments' | 'qr';
  options: string[];
  max: number | null;
  loc: Loc;
}

export interface UiSlide {
  title: string;
  body: string | null;
  widget: UiWidget | null;
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
  // A presentation page has two audiences (host and guests) and widgets that
  // each need their own operation; every binding is named, never guessed.
  join: string | null;
  state: string | null;
  advance: string | null;
  vote: string | null;
  rate: string | null;
  comment: string | null;
  slides: UiSlide[];
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
