// The Go port kit (B107): a generated service answers the same contract as the
// Node emitter, but in Go. The contract parts — routes, input kinds, success
// status — are read from the contract IR, so a fix there reaches both languages
// and the two emitters cannot drift into two contracts.
import type { ModuleNode, ServiceNode } from '../ast.ts';
import { contractOps, type ContractOp } from './contract.ts';
import { messageForError, statusForError } from './service.ts';

// Features the first Go kit does not carry. It refuses by name instead of
// emitting a service that silently answers half the contract: a store-less
// skeleton that returns 404 for a declared op is worse than a build error.
export function goUnsupported(mod: ModuleNode, svc: ServiceNode): string[] {
  const names: string[] = [];
  for (const use of svc.uses) {
    const capability = use.capability.replace(/^arcod\.std\./, '');
    if (use.alias === 'store') {
      names.push(capability === 'kv' ? 'store: kv' : 'store: ' + capability);
      continue;
    }
    if (capability === 'stream') names.push('stream');
    if (capability === 'queue' || use.alias === 'queue') names.push('queue');
    if (capability === 'graphql') names.push('graphql');
    if (capability === 'olap') names.push('olap');
    if (capability === 'mail' || use.alias === 'mail') names.push('mail');
    if (capability === 'files' || use.alias === 'files') names.push('files');
  }
  if (mod.uis.length > 0) names.push('ui page');
  if (svc.roles.length > 0) names.push('roles');
  if (svc.sagas.length > 0) names.push('saga');
  if (svc.contract.some((op) => op.kind === 'job')) names.push('job');
  if (svc.contract.some((op) => op.auth)) names.push('auth');
  return [...new Set(names)];
}

function goString(value: string): string {
  return JSON.stringify(value);
}

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

function statusLiteral(op: ContractOp, svc: ServiceNode): string {
  const node = opOf(svc, op);
  const status = node.clauses.find((clause) => clause.kind === 'status');
  if (status && status.kind === 'status') return String(status.value);
  return String((op.route?.method === 'GET' || op.route?.method === 'HEAD') ? 200 : 201);
}

export function goMain(mod: ModuleNode, svc: ServiceNode): string {
  const ops = contractOps(mod, svc.contract).filter((op) => op.route !== null);
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
  lines.push('func main() {');
  lines.push('\tmux := http.NewServeMux()');
  lines.push('\t// A probe is a read: POST /healthz stays a 404, as in the Node runtime.');
  lines.push('\tmux.HandleFunc("GET /healthz", health)');
  for (const op of ops) {
    lines.push('\tmux.HandleFunc(' + goString(op.route!.method + ' ' + goPattern(op.route!.path)) + ', ' + handlerName(op.name) + ')');
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
  for (const op of ops) {
    lines.push('');
    lines.push('func ' + handlerName(op.name) + '(w http.ResponseWriter, r *http.Request) {');
    lines.push('\tin, err := input(r, ' + kindsLiteral(op) + ', ' + requiredLiteral(op, svc) + ')');
    lines.push('\tif err != nil {');
    lines.push('\t\tfail(w, err)');
    lines.push('\t\treturn');
    lines.push('\t}');
    lines.push('\tout, err := op' + pascal(op.name) + '(in)');
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

export function goOps(mod: ModuleNode, svc: ServiceNode): string {
  const ops = contractOps(mod, svc.contract).filter((op) => op.route !== null);
  const lines: string[] = [];
  lines.push('// Operation bodies for ' + svc.name + '. arcod build wrote these stubs;');
  lines.push('// fill them in, keep the signature, and never edit main.go (it is generated).');
  lines.push('package main');
  for (const op of ops) {
    lines.push('');
    lines.push('// op' + pascal(op.name) + ' implements ' + op.route!.method + ' ' + op.route!.path + '.');
    lines.push('func op' + pascal(op.name) + '(in map[string]any) (any, error) {');
    lines.push('\treturn nil, &OpError{Name: "NotImplemented", Status: 501, Message: "implement ' + op.name + ' according to the .arc contract"}');
    lines.push('}');
  }
  lines.push('');
  return lines.join('\n');
}

export function goMod(svc: ServiceNode): string {
  return 'module arcod/' + pascal(svc.name).toLowerCase() + '\n\ngo 1.23\n';
}

export function goDockerfile(): string {
  return [
    'FROM golang:1.23-alpine AS build',
    'WORKDIR /src',
    'COPY go.mod ./',
    'COPY main.go ops.go ./',
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
