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
import { providerFor } from '../providers.ts';

export interface TerraformOptions {
  environment?: string;
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
  if (!env) throw new Error('no environment to render' + (name ? ': ' + name : ''));
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

  const resources: string[] = [];
  const unmapped: string[] = [];
  for (const bind of env.binds) {
    const spec = providerFor(bind.provider);
    if (!spec) continue;
    if (bind.provider === 'postgres') resources.push(postgresBlock(bind, name));
    else if (bind.provider === 'redis') resources.push(redisBlock(bind, name));
    else if (bind.provider === 's3' || bind.provider === 'minio') resources.push(bucketBlock(bind, name));
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
    unimplementedComment(unmapped),
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
  ].join('\n');

  const tfvars = [
    '# Copy to terraform.tfvars and fill in. Never commit the filled copy.',
    'folder_id = "b1g..."',
    'zone      = ' + hclString(zoneOf(args.region ?? 'ru-central1')),
    '# db_password      = "..."',
    '# redis_password   = "..."',
    '# s3_access_key    = "..."',
    '# s3_secret_key    = "..."',
    '',
  ].join('\n');

  return [
    { path: 'main.tf', content: main },
    { path: 'variables.tf', content: variables },
    { path: 'terraform.tfvars.example', content: tfvars },
  ];
}

function unimplementedComment(binds: string[]): string {
  if (binds.length === 0) return '';
  return '# No managed equivalent rendered for: ' + [...new Set(binds)].sort().join(', ') + '\n';
}

export function formatTerraform(files: TerraformFile[]): string {
  return files.map((file) => '# ' + file.path + '\n' + file.content).join('\n---\n');
}
