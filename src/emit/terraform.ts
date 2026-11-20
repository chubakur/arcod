// Terraform is the third view of the same topology: compose says what runs on
// this machine, k8s says what runs in a cluster, terraform says what has to
// exist in the cloud before either can talk to it. It is generated from the
// environment's binds, never hand-edited, and it never contains a credential:
// secrets arrive as variables (sensitive = true).
//
// The emitter targets Yandex Cloud because that is the provider the deploy
// block names; anything else is an explicit error instead of a silently wrong
// plan.

import type { BindNode, EnvironmentNode, ModuleNode } from '../ast.ts';
import { imageContract } from '../deploy.ts';
import { builtinRegistry, type ProviderRegistry } from '../registry.ts';

export interface TerraformOptions {
  environment?: string;
  // The same registry check() and compose use: a provider a plugin declares is
  // configured outside terraform, never silently dropped from the plan.
  registry?: ProviderRegistry;
}

export interface TerraformFile {
  path: string;
  content: string;
}

function literal(bind: BindNode, key: string): string | null {
  const expr = bind.args[key];
  if (!expr || expr.kind !== 'literal' || expr.value == null) return null;
  return String(expr.value);
}

function hclString(value: string): string {
  return JSON.stringify(value);
}

// Yandex Cloud places every resource in a folder and a network; a zone is
// derived from the region with the conventional suffix.
function zoneOf(region: string): string {
  if (region === 'ru-central1') return 'ru-central1-a';
  return region + '-a';
}

function pickEnv(mod: ModuleNode, name?: string): EnvironmentNode {
  const env = name ? mod.environments.find((item) => item.name === name) : mod.environments.find((item) => item.deploy);
  if (!env) {
    const declared = mod.environments.map((item) => item.name);
    let tail: string;
    if (declared.length === 0) tail = ' — module ' + mod.name + ' declares none';
    else if (name) tail = ' — declared: ' + declared.join(', ');
    else tail = ' — declared: ' + declared.join(', ') + ', but none has `deploy`';
    throw new Error('no environment to render' + (name ? ': ' + name : '') + tail);
  }
  return env;
}

function networkFiles(mod: ModuleNode, env: EnvironmentNode): string {
  const name = mod.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return [
    '# Network first: every managed service below lives in it.',
    'resource "yandex_vpc_network" "main" {',
    '  name = ' + hclString(name + '-net'),
    '}',
    '',
    'resource "yandex_vpc_subnet" "main" {',
    '  name           = ' + hclString(name + '-subnet'),
    '  zone           = var.zone',
    '  network_id     = yandex_vpc_network.main.id',
    '  v4_cidr_blocks = ["10.10.0.0/24"]',
    '}',
    '',
  ].join('\n');
}

function postgresBlock(bind: BindNode, name: string): string {
  const version = literal(bind, 'version') ?? '16';
  return [
    'resource "yandex_mdb_postgresql_cluster" "db" {',
    '  name        = ' + hclString(name + '-pg'),
    '  environment = "PRODUCTION"',
    '  network_id  = yandex_vpc_network.main.id',
    '',
    '  config {',
    '    version = ' + hclString(version),
    '',
    '    resources {',
    '      resource_preset_id = "s2.micro"',
    '      disk_type_id       = "network-ssd"',
    '      disk_size          = 20',
    '    }',
    '  }',
    '',
    '  host {',
    '    zone      = var.zone',
    '    subnet_id = yandex_vpc_subnet.main.id',
    '  }',
    '}',
    '',
    'resource "yandex_mdb_postgresql_database" "db" {',
    '  cluster_id = yandex_mdb_postgresql_cluster.db.id',
    '  name       = "arcod"',
    '  owner      = yandex_mdb_postgresql_user.db.name',
    '}',
    '',
    'resource "yandex_mdb_postgresql_user" "db" {',
    '  cluster_id = yandex_mdb_postgresql_cluster.db.id',
    '  name       = "arcod"',
    '  password   = var.db_password',
    '}',
    '',
  ].join('\n');
}

function redisBlock(bind: BindNode, name: string): string {
  const version = literal(bind, 'version') ?? '7.2';
  return [
    'resource "yandex_mdb_redis_cluster" "kv" {',
    '  name        = ' + hclString(name + '-redis'),
    '  environment = "PRODUCTION"',
    '  network_id  = yandex_vpc_network.main.id',
    '  subnet_id   = yandex_vpc_subnet.main.id',
    '  security_group_ids = []',
    '',
    '  config {',
    '    version  = ' + hclString(version),
    '    password = var.redis_password',
    '  }',
    '}',
    '',
  ].join('\n');
}

function bucketBlock(bind: BindNode, name: string): string {
  return [
    'resource "yandex_storage_bucket" "objects" {',
    '  bucket     = ' + hclString(name + '-objects'),
    '  access_key = var.s3_access_key',
    '  secret_key = var.s3_secret_key',
    '}',
    '',
  ].join('\n');
}

// Only providers with a managed equivalent are rendered. Anything else would
// need a decision (which cloud resource?) that the model does not make, so it
// is reported in a comment instead of guessed.
const MANAGED = new Set(['postgres', 'mysql', 'mariadb', 'redis', 's3', 'minio']);

// A managed service has no container to address: the cloud assigns the host and
// the service listens on its own port, so a bind's `host`, `port` and `expose`
// are container instructions the plan cannot honor. Instead of dropping them,
// the plan exports the real endpoint and names the arguments it ignored;
// check() reports the same gap as W044 before anyone applies the plan.
export interface ManagedEndpoint {
  port: number;
  resource: string;
  // Prefix of the `_host` / `_port` outputs.
  output: string;
}

export const MANAGED_ENDPOINTS: Record<string, ManagedEndpoint> = {
  postgres: { port: 6432, resource: 'yandex_mdb_postgresql_cluster.db', output: 'db' },
  redis: { port: 6379, resource: 'yandex_mdb_redis_cluster.kv', output: 'kv' },
};

function endpointOutputs(items: ManagedEndpoint[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    if (seen.has(item.output)) continue;
    seen.add(item.output);
    lines.push(
      'output "' + item.output + '_host" {',
      '  value = ' + item.resource + '.host[0].fqdn',
      '}',
      '',
      'output "' + item.output + '_port" {',
      '  value = ' + item.port,
      '}',
      '',
    );
  }
  return lines.join('\n');
}

function ignoredComment(items: string[]): string {
  if (items.length === 0) return '';
  return [
    '# Container arguments on a managed service are not honored: ' + items.join('; ') + '.',
    '# The cloud assigns the address; the plan exports <name>_host and <name>_port.',
  ].join('\n') + '\n';
}

// A secret becomes a terraform input named after the provider that needs it:
// faxapi + FAX_TOKEN -> var.faxapi_fax_token. The value only ever arrives from
// the environment, never from the spec.
function secretVariable(provider: string, secret: string): string {
  return (provider + '_' + secret).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Variables declared by the emitter itself. A provider secret that maps onto
// one of them would be a duplicate block, which terraform rejects.
const BUILTIN_VARIABLES = ['folder_id', 'zone', 'db_password', 'redis_password', 's3_access_key', 's3_secret_key'];

function externalVariables(items: ExternalProvider[]): Array<{ name: string; provider: string; secret: string }> {
  const out: Array<{ name: string; provider: string; secret: string }> = [];
  for (const item of items) {
    for (const secret of item.secrets) {
      const name = secretVariable(item.name, secret);
      const clash = out.find((entry) => entry.name === name);
      if (clash) {
        throw new Error(
          'providers ' + clash.provider + ' and ' + item.name + ' both need terraform variable ' + name +
          ' (secrets ' + clash.secret + ' and ' + secret + '); rename one secret',
        );
      }
      if (BUILTIN_VARIABLES.includes(name)) {
        throw new Error('provider ' + item.name + ' secret ' + secret + ' collides with the built-in variable ' + name);
      }
      out.push({ name, provider: item.name, secret });
    }
  }
  return out;
}

interface ExternalProvider {
  name: string;
  origin?: string;
  secrets: string[];
}

// External providers are real parts of the topology (a plugin's payment API, a
// hosted queue) but terraform does not own them. The plan states what the
// operator has to configure and which inputs the service will read.
function externalComment(items: ExternalProvider[]): string {
  if (items.length === 0) return '';
  const lines = ['# External providers: configured outside this plan, never provisioned here.'];
  for (const item of items) {
    const declared = item.origin ? ' (declared by ' + item.origin + ')' : '';
    const inputs = item.secrets.length > 0
      ? ' — inputs: ' + item.secrets.map((secret) => 'var.' + secretVariable(item.name, secret)).join(', ')
      : '';
    lines.push('#   ' + item.name + declared + inputs);
  }
  return lines.join('\n') + '\n';
}

export function terraformFiles(mod: ModuleNode, options: TerraformOptions = {}): TerraformFile[] {
  const env = pickEnv(mod, options.environment);
  const deploy = env.deploy;
  if (!deploy) throw new Error('environment ' + env.name + ' declares no deploy target');
  if (deploy.provider !== 'yandex') {
    throw new Error('terraform target is implemented for yandex; ' + env.name + ' deploys to ' + deploy.provider);
  }
  const args: Record<string, string> = {};
  for (const [key, expr] of Object.entries(deploy.args)) {
    if (expr.kind === 'literal' && expr.value != null) args[key] = String(expr.value);
  }
  const name = mod.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const service = mod.services.find((item) => !item.external);
  const image = service ? imageContract(mod, env, service.name) : null;

  const registry = options.registry ?? builtinRegistry();
  const resources: string[] = [];
  const endpoints: ManagedEndpoint[] = [];
  const ignored: string[] = [];
  const unmapped: string[] = [];
  const unknown: string[] = [];
  const external: ExternalProvider[] = [];
  for (const bind of env.binds) {
    const spec = registry.get(bind.provider);
    if (!spec) {
      unknown.push(bind.provider);
      continue;
    }
    if (spec.external) {
      // Two binds may name the same external provider; terraform rejects a
      // duplicate variable, so the plan lists each provider once.
      if (!external.some((item) => item.name === spec.name)) {
        external.push({ name: spec.name, origin: registry.origin[spec.name], secrets: spec.secrets ?? [] });
      }
      continue;
    }
    if (bind.provider === 'postgres') resources.push(postgresBlock(bind, name));
    else if (bind.provider === 'redis') resources.push(redisBlock(bind, name));
    else if (bind.provider === 's3' || bind.provider === 'minio') resources.push(bucketBlock(bind, name));
    const endpoint = MANAGED_ENDPOINTS[bind.provider];
    if (endpoint) {
      endpoints.push(endpoint);
      const dropped = ['host', 'port', 'expose'].filter((key) => key in bind.args);
      if (dropped.length > 0) ignored.push(bind.alias + ' (' + bind.provider + '): ' + dropped.join(', '));
    }
    else if (!MANAGED.has(bind.provider)) unmapped.push(bind.provider);
  }

  const main = [
    '# Generated by arcod from ' + mod.name + '@' + mod.version + ' (' + env.name + '). Do not edit.',
    '# The deployment target, not a hand-written plan: bindings decide resources.',
    '',
    'terraform {',
    '  required_version = ">= 1.6"',
    '  required_providers {',
    '    yandex = {',
    '      source  = "yandex-cloud/yandex"',
    '      version = ">= 0.100"',
    '    }',
    '  }',
    '}',
    '',
    'provider "yandex" {',
    '  folder_id = var.folder_id',
    '  zone      = var.zone',
    '}',
    '',
    networkFiles(mod, env),
    externalComment(external),
    ignoredComment(ignored),
    unimplementedComment(unmapped, unknown),
    resources.join('\n'),
    'output "network_id" {',
    '  value = yandex_vpc_network.main.id',
    '}',
    '',
    'output "subnet_id" {',
    '  value = yandex_vpc_subnet.main.id',
    '}',
    '',
    image ? 'output "image" {\n  value = ' + hclString(image.image) + '\n}\n' : '',
    endpointOutputs(endpoints),
  ].filter((part) => part.length > 0).join('\n');

  const variables = [
    '# Inputs, not constants: a folder is per-installation and every password',
    '# is a secret. Nothing here is committed with a value.',
    'variable "folder_id" {',
    '  type        = string',
    '  description = "Yandex Cloud folder"',
    '}',
    '',
    'variable "zone" {',
    '  type    = string',
    '  default = ' + hclString(zoneOf(args.region ?? 'ru-central1')),
    '}',
    '',
    'variable "db_password" {',
    '  type      = string',
    '  sensitive = true',
    '}',
    '',
    'variable "redis_password" {',
    '  type      = string',
    '  sensitive = true',
    '}',
    '',
    'variable "s3_access_key" {',
    '  type      = string',
    '  sensitive = true',
    '}',
    '',
    'variable "s3_secret_key" {',
    '  type      = string',
    '  sensitive = true',
    '}',
    '',
    ...externalVariables(external).flatMap((entry) => [
      'variable "' + entry.name + '" {',
      '  type        = string',
      '  description = ' + hclString(entry.provider + ' credential'),
      '  sensitive   = true',
      '}',
      '',
    ]),
  ].join('\n');

  const tfvars = [
    '# Copy to terraform.tfvars and fill in. Never commit the filled copy.',
    'folder_id = "b1g..."',
    'zone      = ' + hclString(zoneOf(args.region ?? 'ru-central1')),
    '# db_password      = "..."',
    '# redis_password   = "..."',
    '# s3_access_key    = "..."',
    '# s3_secret_key    = "..."',
    ...externalVariables(external).map((entry) => '# ' + entry.name + ' = "..."'),
    '',
  ].join('\n');

  return [
    { path: 'main.tf', content: main },
    { path: 'variables.tf', content: variables },
    { path: 'terraform.tfvars.example', content: tfvars },
  ];
}

function unimplementedComment(binds: string[], unknown: string[] = []): string {
  const parts: string[] = [];
  if (binds.length > 0) parts.push('# No managed equivalent rendered for: ' + [...new Set(binds)].sort().join(', '));
  if (unknown.length > 0) parts.push('# Providers unknown to the registry (check reports them): ' + [...new Set(unknown)].sort().join(', '));
  return parts.length === 0 ? '' : parts.join('\n') + '\n';
}

export function formatTerraform(files: TerraformFile[]): string {
  return files.map((file) => '# ' + file.path + '\n' + file.content).join('\n---\n');
}
