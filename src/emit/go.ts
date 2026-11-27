// The Go port kit (B107): a generated service answers the same contract as the
// Node emitter, but in Go. The contract parts — routes, input kinds, success
// status — are read from the contract IR, so a fix there reaches both languages
// and the two emitters cannot drift into two contracts.
import type { ModuleNode, ServiceNode } from '../ast.ts';
import { contractOps, successStatus, type ContractOp } from './contract.ts';
import { messageForError, statusForError } from './service.ts';
import { goModulePath } from './arcodio.ts';

// Features the first Go kit does not carry. It refuses by name instead of
// emitting a service that silently answers half the contract: a store-less
// skeleton that returns 404 for a declared op is worse than a build error.
export function goUnsupported(mod: ModuleNode, svc: ServiceNode): string[] {
  const names: string[] = [];
  for (const use of svc.uses) {
    const capability = use.capability.replace(/^arcod\.std\./, '');
    // kv is carried by the arcodio facade; every other store needs a dialect
    // layer the kit does not have yet.
    if (use.alias === 'store') {
      if (capability !== 'kv') names.push('store: ' + capability);
      continue;
    }
    if (capability === 'stream') names.push('stream');
    // queue is carried whole (B107.5b publishes, B111.2 consumes): a job op
    // runs in the consumer loop of main.go.
    if (capability === 'graphql') names.push('graphql');
    if (capability === 'olap') names.push('olap');
    if (capability === 'mail' || use.alias === 'mail') names.push('mail');
    if (capability === 'files' || use.alias === 'files') names.push('files');
  }
  if (mod.uis.length > 0) names.push('ui page');
  if (svc.roles.length > 0) names.push('roles');
  if (svc.sagas.length > 0) names.push('saga');
  // A job body is a plain function of one message, so the consumer loop runs
  // it (B111.2). A job that drives a saga instead of a body is still refused:
  // the Go kit carries no saga runner, and a loop that dropped such a message
  // would lose the work silently.
  for (const op of svc.contract) {
    if (op.kind !== 'job') continue;
    if ((op.clauses ?? []).some((clause) => clause.kind === 'saga')) names.push('saga job ' + op.name);
  }
  if (svc.contract.some((op) => op.auth)) names.push('auth');
  return [...new Set(names)];
}

// A queue-bound Go service gets the queue half in its own file
// (arcodio/queue.go): publishing from a body, and the receive/requeue/dead
// calls the consumer loop makes. A service that only declares a job consumes
// a queue without naming the capability, so the jobs count too.
export function goQueueBound(svc: ServiceNode): boolean {
  if (goJobs(svc).length > 0) return true;
  return svc.uses.some(
    (use) => use.capability.replace(/^arcod\.std\./, '') === 'queue' || use.alias === 'queue',
  );
}

// One consumer per queue-backed job. The topic, the parameters and the retry
// budget come from the contract, so a Node and a Go service on the same spec
// consume identically; only the loop around them differs.
export interface GoJob {
  name: string;
  topic: string;
  params: string[];
  retry: number;
}

export function goJobs(svc: ServiceNode): GoJob[] {
  const jobs: GoJob[] = [];
  for (const op of svc.contract) {
    if (op.kind !== 'job') continue;
    const consume = op.clauses.find((clause) => clause.kind === 'consume');
    if (!consume || consume.kind !== 'consume') continue;
    const retry = op.clauses.find((clause) => clause.kind === 'retry');
    jobs.push({
      name: op.name,
      // 'queue.orders.created' is alias plus topic; the wire key carries the
      // topic alone, as in the Node runtime.
      topic: consume.source.split('.').slice(1).join('.'),
      params: op.params.map((param) => param.name),
      retry: retry && retry.kind === 'retry' ? retry.value : 3,
    });
  }
  return jobs;
}

function goString(value: string): string {
  return JSON.stringify(value);
}

// A Go struct tag is a backtick string, and a backtick inside this file's
// template-literal source would close it: build the character instead.
const backtick = String.fromCharCode(96);

function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

function handlerName(name: string): string {
  return 'handle' + pascal(name);
}

// The parameter names of a job, as a Go slice literal.
function paramsLiteral(params: string[]): string {
  return '[]string{' + params.map(goString).join(', ') + '}';
}

// Two routes that differ only in the name of their capture — '/v1/items/:id'
// and '/v1/items/:key' — are distinct to check but one Go 1.22 pattern, and
// ServeMux panics on the duplicate at startup. The build names them instead.
export function goPatternCollisions(mod: ModuleNode, svc: ServiceNode): string[] {
  const seen = new Map<string, { display: string; names: string[] }>();
  for (const op of contractOps(mod, svc.contract)) {
    if (!op.route) continue;
    const display = op.route.method + ' ' + goPattern(op.route.path);
    // The wildcard name does not affect matching, so '{id}' and '{key}' are the
    // same pattern to ServeMux even though the text differs.
    const shape = display.replace(/\{[^}]*\}/g, '{}');
    const entry = seen.get(shape) ?? { display, names: [] };
    entry.names.push(op.name);
    seen.set(shape, entry);
  }
  return [...seen.values()]
    .filter((entry) => entry.names.length > 1)
    .map((entry) => entry.display + ' is ' + entry.names.join(' and '));
}

// ':id' is Go 1.22's '{id}'; a literal segment keeps its text.
function goPattern(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '{' + segment.slice(1) + '}' : segment))
    .join('/');
}

function kindsLiteral(op: ContractOp): string {
  const entries = Object.entries(op.inputKinds).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'nil';
  return 'map[string]string{' + entries.map(([name, kind]) => goString(name) + ': ' + goString(kind)).join(', ') + '}';
}

function requiredLiteral(op: ContractOp, svc: ServiceNode): string {
  const params = opOf(svc, op).params.map((param) => goString(param.name)).join(', ');
  return '[]string{' + params + '}';
}

function errorsIn(svc: ServiceNode): string[] {
  const names = new Set<string>();
  for (const op of svc.contract) {
    if (op.kind !== 'op') continue;
    const clause = op.clauses.find((item) => item.kind === 'errors');
    if (clause && clause.kind === 'errors') for (const name of clause.names) names.add(name);
  }
  return [...names].sort();
}

function opOf(svc: ServiceNode, op: ContractOp) {
  return svc.contract.find((item) => item.kind === 'op' && item.name === op.name)!;
}

// One success-status rule for every emitter: the IR decides, not a copy.
function statusLiteral(op: ContractOp, svc: ServiceNode): string {
  return String(successStatus(opOf(svc, op)));
}

export function goMain(mod: ModuleNode, svc: ServiceNode): string {
  const ops = contractOps(mod, svc.contract).filter((op) => op.route !== null);
  const jobs = goJobs(svc);
  const errors = errorsIn(svc);
  const lines: string[] = [];
  lines.push('// Code generated from ' + mod.file + ' by arcod. DO NOT EDIT.');
  lines.push('//');
  lines.push('// The routes and the input table come from the contract IR; the bodies');
  lines.push('// live in ops.go, one function per operation.');
  lines.push('package main');
  lines.push('');
  lines.push('import (');
  lines.push('\t"encoding/json"');
  lines.push('\t"errors"');
  lines.push('\t"io"');
  lines.push('\t"log"');
  lines.push('\t"net/http"');
  lines.push('\t"os"');
  lines.push('\t"strconv"');
  if (jobs.length > 0) lines.push('\t"time"');
  lines.push('');
  lines.push('\tarcodio ' + goString(goModulePath(svc) + '/arcodio'));
  lines.push(')');
  lines.push('');
  lines.push('// OpError is an error the contract declares by name.');
  lines.push('type OpError struct {');
  lines.push('\tName    string');
  lines.push('\tStatus  int');
  lines.push('\tMessage string');
  lines.push('}');
  lines.push('');
  lines.push('func (e *OpError) Error() string { return e.Name }');
  lines.push('');
  if (errors.length > 0) {
    lines.push('var (');
    for (const name of errors) {
      lines.push('\tErr' + pascal(name) + ' = &OpError{Name: ' + goString(name) + ', Status: ' + statusForError(name) + ', Message: ' + goString(messageForError(name)) + '}');
    }
    lines.push(')');
    lines.push('');
  }
  lines.push('var arc = arcodio.Connect()');
  lines.push('');
  lines.push('func main() {');
  lines.push('\tmux := http.NewServeMux()');
  lines.push('\t// A probe is a read: POST /healthz stays a 404, as in the Node runtime.');
  lines.push('\tmux.HandleFunc("GET /healthz", health)');
  for (const op of ops) {
    lines.push('\tmux.HandleFunc(' + goString(op.route!.method + ' ' + goPattern(op.route!.path)) + ', ' + handlerName(op.name) + ')');
  }
  for (const job of jobs) {
    lines.push('\t// The consumer starts with the service: a message that arrived while');
    lines.push('\t// the process was down waits in the topic, not in memory.');
    lines.push('\tgo consume' + pascal(job.name) + '(arc)');
  }
  lines.push('\tlog.Printf("arcod go service %s listening on %s", ' + goString(svc.name) + ', addr())');
  lines.push('\tlog.Fatal(http.ListenAndServe(addr(), mux))');
  lines.push('}');
  lines.push('');
  lines.push('func addr() string {');
  lines.push('\tport := os.Getenv("PORT")');
  lines.push('\tif port == "" {');
  lines.push('\t\tport = "3000"');
  lines.push('\t}');
  lines.push('\treturn ":" + port');
  lines.push('}');
  lines.push('');
  lines.push('func health(w http.ResponseWriter, r *http.Request) {');
  lines.push('\twriteJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": ' + goString(svc.name) + '})');
  lines.push('}');
  // Jobs (B111.2): a consumer per job operation, started with the service.
  // The loop is runtime code, not body code: a body stays a plain function of
  // one message, and retry/dead-letter rules live in one place per language.
  if (jobs.length > 0) {
    lines.push('');
    lines.push('// queuePoll paces an empty topic. The Node runtime polls every 100ms,');
    lines.push('// and a blocking read would hold the one store connection hostage for');
    lines.push('// the whole wait, so the loop sleeps instead.');
    lines.push('const queuePoll = 100 * time.Millisecond');
  }
  for (const job of jobs) {
    const name = pascal(job.name);
    lines.push('');
    lines.push('// consume' + name + ' runs job ' + job.name + ' off queue ' + job.topic + '.');
    lines.push('// One message at a time: a body that fails is retried with backoff and');
    lines.push('// then written to the dead letter, as the Node runtime does on the same');
    lines.push('// wire, so either language can drain a topic the other published to.');
    lines.push('func consume' + name + '(arc *arcodio.IO) {');
    lines.push('\tconst topic = ' + goString(job.topic));
    lines.push('\tconst retry = ' + job.retry);
    lines.push('\tfor {');
    lines.push('\t\traw, ok, err := arc.QueueReceive(topic)');
    lines.push('\t\tif err != nil {');
    lines.push('\t\t\tlog.Printf("queue %s: receive failed: %v, retrying", topic, err)');
    lines.push('\t\t\ttime.Sleep(queuePoll)');
    lines.push('\t\t\tcontinue');
    lines.push('\t\t}');
    lines.push('\t\tif !ok {');
    lines.push('\t\t\ttime.Sleep(queuePoll)');
    lines.push('\t\t\tcontinue');
    lines.push('\t\t}');
    lines.push('\t\tvar envelope struct {');
    lines.push('\t\t\tPayload  any ' + backtick + 'json:"payload"' + backtick);
    lines.push('\t\t\tAttempts int ' + backtick + 'json:"attempts"' + backtick);
    lines.push('\t\t}');
    lines.push('\t\tif err := json.Unmarshal([]byte(raw), &envelope); err != nil {');
    lines.push('\t\t\t// The topic and a fixed phrase only: the raw message is user data.');
    lines.push('\t\t\tlog.Printf("queue %s: unreadable message, moved to dead letter", topic)');
    lines.push('\t\t\tif err := arc.QueueDead(topic, ' + backtick + '{"payload":null,"attempts":0,"lastError":"unreadable message"}' + backtick + '); err != nil {');
    lines.push('\t\t\t\tlog.Printf("queue %s: could not record an unreadable message: %v", topic, err)');
    lines.push('\t\t\t}');
    lines.push('\t\t\tcontinue');
    lines.push('\t\t}');
    lines.push('\t\tout, err := op' + name + '(arc, jobInput(' + paramsLiteral(job.params) + ', envelope.Payload))');
    if (job.params.length > 0) {
      // A job with input that returns nothing did nothing: the body fell
      // through. Acking it would lose the work, so it counts as a failure.
      lines.push('\t\tif err == nil && out == nil {');
      lines.push('\t\t\terr = errors.New("consumer returned no result for its input")');
      lines.push('\t\t}');
    }
    lines.push('\t\tif err == nil {');
    lines.push('\t\t\tcontinue');
    lines.push('\t\t}');
    lines.push('\t\tattempts := envelope.Attempts + 1');
    lines.push('\t\tlastError := describeError(err)');
    lines.push('\t\tif attempts > retry {');
    lines.push('\t\t\t// One line, no payload: the reason a job disappeared is the log.');
    lines.push('\t\t\tlog.Printf("queue %s: attempt %d/%d failed: %s, moved to dead letter", topic, attempts, retry+1, lastError)');
    lines.push('\t\t\tentry, _ := json.Marshal(map[string]any{"payload": envelope.Payload, "attempts": attempts, "lastError": lastError})');
    lines.push('\t\t\tif err := arc.QueueDead(topic, string(entry)); err != nil {');
    lines.push('\t\t\t\tlog.Printf("queue %s: could not record a failed attempt: %v", topic, err)');
    lines.push('\t\t\t}');
    lines.push('\t\t\tcontinue');
    lines.push('\t\t}');
    lines.push('\t\tdelay := retryDelay(attempts)');
    lines.push('\t\tlog.Printf("queue %s: attempt %d/%d failed: %s, requeued in %s", topic, attempts, retry+1, lastError, delay)');
    lines.push('\t\ttime.Sleep(delay)');
    lines.push('\t\tentry, _ := json.Marshal(map[string]any{"payload": envelope.Payload, "attempts": attempts})');
    lines.push('\t\tif err := arc.QueueRequeue(topic, string(entry)); err != nil {');
    lines.push('\t\t\tlog.Printf("queue %s: could not record a failed attempt: %v", topic, err)');
    lines.push('\t\t}');
    lines.push('\t}');
    lines.push('}');
  }
  if (jobs.length > 0) {
    lines.push('');
    lines.push('// jobInput maps a payload onto the parameters a job declares, as the');
    lines.push('// Node runtime does: one parameter takes the field of that name, or the');
    lines.push('// whole payload when the payload has no such field; several parameters');
    lines.push('// take their own fields and nil where the publisher sent nothing.');
    lines.push('func jobInput(params []string, payload any) map[string]any {');
    lines.push('\tin := map[string]any{}');
    lines.push('\tif len(params) == 0 {');
    lines.push('\t\treturn in');
    lines.push('\t}');
    lines.push('\tobject, isObject := payload.(map[string]any)');
    lines.push('\tif len(params) == 1 {');
    lines.push('\t\tif isObject {');
    lines.push('\t\t\tif value, ok := object[params[0]]; ok {');
    lines.push('\t\t\t\tin[params[0]] = value');
    lines.push('\t\t\t\treturn in');
    lines.push('\t\t\t}');
    lines.push('\t\t}');
    lines.push('\t\tin[params[0]] = payload');
    lines.push('\t\treturn in');
    lines.push('\t}');
    lines.push('\tfor _, name := range params {');
    lines.push('\t\tif isObject {');
    lines.push('\t\t\tif value, ok := object[name]; ok {');
    lines.push('\t\t\t\tin[name] = value');
    lines.push('\t\t\t\tcontinue');
    lines.push('\t\t\t}');
    lines.push('\t\t}');
    lines.push('\t\tin[name] = nil');
    lines.push('\t}');
    lines.push('\treturn in');
    lines.push('}');
    lines.push('');
    lines.push('// retryDelay is the Node runtime backoff: 250ms, 500ms, 1s, capped at');
    lines.push('// 30s, so a broken downstream does not burn the budget in milliseconds.');
    lines.push('func retryDelay(attempts int) time.Duration {');
    lines.push('\tdelay := 250 * time.Millisecond');
    lines.push('\tfor attempt := 1; attempt < attempts && delay < 30*time.Second; attempt++ {');
    lines.push('\t\tdelay *= 2');
    lines.push('\t}');
    lines.push('\tif delay > 30*time.Second {');
    lines.push('\t\treturn 30 * time.Second');
    lines.push('\t}');
    lines.push('\treturn delay');
    lines.push('}');
    lines.push('');
    lines.push('// describeError names a failure for the log and the dead letter: a');
    lines.push('// declared error carries its message, anything else its own text.');
    lines.push('func describeError(err error) string {');
    lines.push('\tvar declared *OpError');
    lines.push('\tif errors.As(err, &declared) {');
    lines.push('\t\treturn declared.Message');
    lines.push('\t}');
    lines.push('\treturn err.Error()');
    lines.push('}');
  }
  for (const op of ops) {
    lines.push('');
    lines.push('func ' + handlerName(op.name) + '(w http.ResponseWriter, r *http.Request) {');
    lines.push('\tin, err := input(r, ' + kindsLiteral(op) + ', ' + requiredLiteral(op, svc) + ')');
    lines.push('\tif err != nil {');
    lines.push('\t\tfail(w, err)');
    lines.push('\t\treturn');
    lines.push('\t}');
    lines.push('\tout, err := op' + pascal(op.name) + '(arc, in)');
    lines.push('\tif err != nil {');
    lines.push('\t\tfail(w, err)');
    lines.push('\t\treturn');
    lines.push('\t}');
    lines.push('\twriteJSON(w, ' + statusLiteral(op, svc) + ', out)');
    lines.push('}');
  }
  lines.push('');
  lines.push('// input reads the path captures, the query string and the JSON body into');
  lines.push('// one map, then coerces the scalars a URL carries as text.');
  lines.push('func input(r *http.Request, kinds map[string]string, required []string) (map[string]any, error) {');
  lines.push('\tin := map[string]any{}');
  lines.push('\tfor _, name := range required {');
  lines.push('\t\tif value := r.PathValue(name); value != "" {');
  lines.push('\t\t\tin[name] = value');
  lines.push('\t\t}');
  lines.push('\t\tif values, ok := r.URL.Query()[name]; ok && len(values) > 0 {');
  lines.push('\t\t\tin[name] = values[len(values)-1]');
  lines.push('\t\t}');
  lines.push('\t}');
  lines.push('\tif r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch {');
  lines.push('\t\tvar body map[string]any');
  lines.push('\t\tif err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {');
  lines.push('\t\t\treturn nil, &OpError{Name: "Invalid", Status: 400, Message: "invalid JSON body"}');
  lines.push('\t\t}');
  lines.push('\t\tfor name, value := range body {');
  lines.push('\t\t\tif _, taken := in[name]; !taken {');
  lines.push('\t\t\t\tin[name] = value');
  lines.push('\t\t\t}');
  lines.push('\t\t}');
  lines.push('\t}');
  lines.push('\tif err := coerce(in, kinds); err != nil {');
  lines.push('\t\treturn nil, err');
  lines.push('\t}');
  lines.push('\tfor _, name := range required {');
  lines.push('\t\tif _, ok := in[name]; !ok {');
  lines.push('\t\t\treturn nil, &OpError{Name: "Invalid", Status: 400, Message: "missing parameter " + name}');
  lines.push('\t\t}');
  lines.push('\t}');
  lines.push('\treturn in, nil');
  lines.push('}');
  lines.push('');
  lines.push('func coerce(in map[string]any, kinds map[string]string) error {');
  lines.push('\tfor name, kind := range kinds {');
  lines.push('\t\traw, ok := in[name]');
  lines.push('\t\tif !ok {');
  lines.push('\t\t\tcontinue');
  lines.push('\t\t}');
  lines.push('\t\tswitch kind {');
  lines.push('\t\tcase "int":');
  lines.push('\t\t\tswitch value := raw.(type) {');
  lines.push('\t\t\tcase float64:');
  lines.push('\t\t\t\tin[name] = int64(value)');
  lines.push('\t\t\tcase string:');
  lines.push('\t\t\t\tparsed, err := strconv.ParseInt(value, 10, 64)');
  lines.push('\t\t\t\tif err != nil {');
  lines.push('\t\t\t\t\treturn &OpError{Name: "Invalid", Status: 400, Message: name + " must be an int"}');
  lines.push('\t\t\t\t}');
  lines.push('\t\t\t\tin[name] = parsed');
  lines.push('\t\t\t}');
  lines.push('\t\tcase "number", "decimal", "float":');
  lines.push('\t\t\tswitch value := raw.(type) {');
  lines.push('\t\t\tcase string:');
  lines.push('\t\t\t\tparsed, err := strconv.ParseFloat(value, 64)');
  lines.push('\t\t\t\tif err != nil {');
  lines.push('\t\t\t\t\treturn &OpError{Name: "Invalid", Status: 400, Message: name + " must be a number"}');
  lines.push('\t\t\t\t}');
  lines.push('\t\t\t\tin[name] = parsed');
  lines.push('\t\t\t}');
  lines.push('\t\tcase "bool":');
  lines.push('\t\t\tswitch value := raw.(type) {');
  lines.push('\t\t\tcase string:');
  lines.push('\t\t\t\tparsed, err := strconv.ParseBool(value)');
  lines.push('\t\t\t\tif err != nil {');
  lines.push('\t\t\t\t\treturn &OpError{Name: "Invalid", Status: 400, Message: name + " must be a bool"}');
  lines.push('\t\t\t\t}');
  lines.push('\t\t\t\tin[name] = parsed');
  lines.push('\t\t\t}');
  lines.push('\t\t}');
  lines.push('\t}');
  lines.push('\treturn nil');
  lines.push('}');
  lines.push('');
  lines.push('// fail answers a declared error by its status and name; anything else is');
  lines.push('// Internal, exactly as the Node runtime treats an undeclared error.');
  lines.push('func fail(w http.ResponseWriter, err error) {');
  lines.push('\tvar declared *OpError');
  lines.push('\tif errors.As(err, &declared) {');
  lines.push('\t\twriteJSON(w, declared.Status, map[string]any{"error": declared.Name, "message": declared.Message})');
  lines.push('\t\treturn');
  lines.push('\t}');
  lines.push('\tlog.Printf("internal error: %v", err)');
  lines.push('\twriteJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal"})');
  lines.push('}');
  lines.push('');
  lines.push('func writeJSON(w http.ResponseWriter, status int, body any) {');
  lines.push('\tw.Header().Set("Content-Type", "application/json")');
  lines.push('\tw.WriteHeader(status)');
  lines.push('\tif body == nil {');
  lines.push('\t\treturn');
  lines.push('\t}');
  lines.push('\tif err := json.NewEncoder(w).Encode(body); err != nil {');
  lines.push('\t\tlog.Printf("write response: %v", err)');
  lines.push('\t}');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

// ops.go is assembled from the author's Go bodies where they exist and from
// stubs where they do not: an operation without a body answers 501 by name,
// never a guessed implementation. A body is spliced verbatim — it is the
// author's file, and the build keeps it readable in the output.
// Go imports are per file, not per package: a body spliced into ops.go cannot
// see main.go's imports. The kit therefore allowlists the stdlib a body needs
// (json for a record, strconv for a counter, time for a ttl) and adds an import
// only when the body actually spells that identifier — an unused import is a
// compile error in Go, so guessing would break the service. net/fs/exec are
// not on the list: the contract denies those effects.
const BODY_IMPORTS: Array<[string, string]> = [
  ['encoding/json', 'json'],
  ['errors', 'errors'],
  ['fmt', 'fmt'],
  ['sort', 'sort'],
  ['strconv', 'strconv'],
  ['strings', 'strings'],
  ['time', 'time'],
];

function bodyImports(names: string[], bodies: Record<string, string>): string[] {
  const text = names.map((name) => bodies[name] ?? '').join('\n');
  return BODY_IMPORTS.filter(([, ident]) => new RegExp('(^|[^A-Za-z0-9_.])' + ident + '\\.').test(text)).map(
    ([path]) => path,
  );
}

export function goOps(mod: ModuleNode, svc: ServiceNode, bodies: Record<string, string> = {}): string {
  // Job bodies live in the same file as the http ones: a body is a function of
  // one message either way, and splitting them would make impl/ layout depend
  // on the operation kind.
  const entries = [
    ...contractOps(mod, svc.contract)
      .filter((op) => op.route !== null)
      .map((op) => ({ name: op.name, comment: 'implements ' + op.route!.method + ' ' + op.route!.path })),
    ...goJobs(svc).map((job) => ({ name: job.name, comment: 'implements job ' + job.name + ' off queue ' + job.topic })),
  ];
  const stdlib = bodyImports(entries.map((entry) => entry.name), bodies);
  const lines: string[] = [];
  lines.push('// Operation bodies for ' + svc.name + '. Bodies come from impl/*.go;');
  lines.push('// the rest are stubs. Keep the signature and never edit main.go.');
  lines.push('package main');
  lines.push('');
  if (stdlib.length > 0) {
    lines.push('import (');
    for (const path of stdlib) lines.push('\t' + goString(path));
    lines.push('');
    lines.push('\tarcodio ' + goString(goModulePath(svc) + '/arcodio'));
    lines.push(')');
  } else {
    lines.push('import arcodio ' + goString(goModulePath(svc) + '/arcodio'));
  }
  for (const op of entries) {
    lines.push('');
    lines.push('// op' + pascal(op.name) + ' ' + op.comment + '.');
    const body = bodies[op.name];
    if (body !== undefined) {
      lines.push(body.trimEnd());
      continue;
    }
    lines.push('func op' + pascal(op.name) + '(io *arcodio.IO, in map[string]any) (any, error) {');
    lines.push('\treturn nil, &OpError{Name: "NotImplemented", Status: 501, Message: "implement ' + op.name + ' according to the .arc contract"}');
    lines.push('}');
  }
  lines.push('');
  return lines.join('\n');
}

export function goMod(svc: ServiceNode): string {
  return 'module ' + goModulePath(svc) + '\n\ngo 1.23\n';
}

export function goDockerfile(): string {
  return [
    'FROM golang:1.23-alpine AS build',
    'WORKDIR /src',
    'COPY go.mod ./',
    'COPY main.go ops.go ./',
    'COPY arcodio ./arcodio',
    'RUN CGO_ENABLED=0 go build -trimpath -o /out/service .',
    '',
    'FROM alpine:3.20',
    'WORKDIR /app',
    'COPY --from=build /out/service /app/service',
    'ENV PORT=3000',
    'EXPOSE 3000',
    'CMD ["/app/service"]',
    '',
  ].join('\n');
}
