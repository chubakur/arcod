// Provider registry: the compiler's knowledge about the infrastructure a
// capability can be bound to. The model names a capability (kv, sql, queue...);
// the environment names a provider (redis, postgres, kafka...).
export interface ProviderContext {
  host: string;
  port: number;
  args: Record<string, string | number | boolean>;
}

export interface ProviderSpec {
  name: string;
  capability: string;
  image?: string;
  // external providers are configured, not provisioned: Sentry, for instance.
  external?: boolean;
  requires?: string[];
  port?: number;
  extraPorts?: number[];
  command?: string[];
  env?: Record<string, string>;
  healthcheck?: {
    test: string;
    interval: string;
    timeout: string;
    retries: number;
    startPeriod?: string;
  };
  volumes?: string[];
  oneShot?: boolean;
  appEnv?: (ctx: ProviderContext) => Record<string, string>;
}

const pgHealth = { test: '["CMD-SHELL", "pg_isready -U arcod"]', interval: '2s', timeout: '2s', retries: 30 };

export const PROVIDERS: Record<string, ProviderSpec> = {
  redis: {
    name: 'redis',
    capability: 'kv',
    image: 'redis:7-alpine',
    port: 6379,
    command: ['redis-server', '--save', '', '--appendonly', 'no'],
    healthcheck: { test: '["CMD", "redis-cli", "ping"]', interval: '2s', timeout: '2s', retries: 30 },
    appEnv: ({ host, port }) => ({ KV_HOST: host, KV_PORT: String(port), REDIS_URL: 'redis://' + host + ':' + port }),
  },
  postgres: {
    name: 'postgres',
    capability: 'sql',
    image: 'postgres:16-alpine',
    port: 5432,
    env: { POSTGRES_USER: 'arcod', POSTGRES_PASSWORD: 'arcod', POSTGRES_DB: 'arcod' },
    healthcheck: pgHealth,
    volumes: ['pgdata:/var/lib/postgresql/data'],
    appEnv: ({ host, port }) => ({ DATABASE_URL: 'postgres://arcod:arcod@' + host + ':' + port + '/arcod' }),
  },
  mysql: {
    name: 'mysql',
    capability: 'sql',
    image: 'mysql:8.4',
    port: 3306,
    env: { MYSQL_ROOT_PASSWORD: 'arcod', MYSQL_DATABASE: 'arcod', MYSQL_USER: 'arcod', MYSQL_PASSWORD: 'arcod' },
    healthcheck: { test: '["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-parcod"]', interval: '2s', timeout: '2s', retries: 30 },
    volumes: ['mysqldata:/var/lib/mysql'],
    appEnv: ({ host, port }) => ({ DATABASE_URL: 'mysql://arcod:arcod@' + host + ':' + port + '/arcod' }),
  },
  mariadb: {
    name: 'mariadb',
    capability: 'sql',
    image: 'mariadb:11',
    port: 3306,
    env: { MARIADB_ROOT_PASSWORD: 'arcod', MARIADB_DATABASE: 'arcod', MARIADB_USER: 'arcod', MARIADB_PASSWORD: 'arcod' },
    healthcheck: { test: '["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]', interval: '2s', timeout: '2s', retries: 30 },
    volumes: ['mariadbdata:/var/lib/mysql'],
    appEnv: ({ host, port }) => ({ DATABASE_URL: 'mysql://arcod:arcod@' + host + ':' + port + '/arcod' }),
  },
  mongodb: {
    name: 'mongodb',
    capability: 'document',
    image: 'mongo:7',
    port: 27017,
    healthcheck: { test: '["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand({ping:1})"]', interval: '2s', timeout: '2s', retries: 30 },
    volumes: ['mongodata:/data/db'],
    appEnv: ({ host, port }) => ({ MONGO_URL: 'mongodb://' + host + ':' + port + '/arcod' }),
  },
  keycloak: {
    name: 'keycloak',
    capability: 'identity',
    image: 'quay.io/keycloak/keycloak:26.0',
    port: 8080,
    command: ['start-dev'],
    env: {
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
      KC_HEALTH_ENABLED: 'true',
    },
    healthcheck: { test: '["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000; echo -e \'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n\' >&3; head -1 <&3 | grep -q 200"]', interval: '5s', timeout: '5s', retries: 40, startPeriod: '20s' },
    appEnv: ({ host, port }) => ({ KEYCLOAK_URL: 'http://' + host + ':' + port }),
  },
  s3: {
    name: 's3',
    capability: 'objectstore',
    image: 'minio/minio:latest',
    port: 9000,
    extraPorts: [9001],
    command: ['server', '/data', '--console-address', ':9001'],
    env: { MINIO_ROOT_USER: 'minio', MINIO_ROOT_PASSWORD: 'minio123' },
    healthcheck: { test: '["CMD", "mc", "ready", "local"]', interval: '5s', timeout: '3s', retries: 30 },
    volumes: ['s3data:/data'],
    appEnv: ({ host, port }) => ({ S3_ENDPOINT: 'http://' + host + ':' + port, S3_ACCESS_KEY: 'minio', S3_SECRET_KEY: 'minio123' }),
  },
  rabbitmq: {
    name: 'rabbitmq',
    capability: 'queue',
    image: 'rabbitmq:3.13-management-alpine',
    port: 5672,
    extraPorts: [15672],
    env: { RABBITMQ_DEFAULT_USER: 'arcod', RABBITMQ_DEFAULT_PASS: 'arcod' },
    healthcheck: { test: '["CMD", "rabbitmq-diagnostics", "-q", "ping"]', interval: '5s', timeout: '5s', retries: 30 },
    volumes: ['rabbitmqdata:/var/lib/rabbitmq'],
    appEnv: ({ host, port }) => ({ AMQP_URL: 'amqp://arcod:arcod@' + host + ':' + port }),
  },
  kafka: {
    name: 'kafka',
    capability: 'queue',
    image: 'apache/kafka:3.8.0',
    port: 9092,
    env: {
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:9092',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@kafka:9093',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      CLUSTER_ID: 'MkU3OEVBNTcwNTJENDM2Qk',
    },
    healthcheck: { test: '["CMD-SHELL", "/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list >/dev/null 2>&1"]', interval: '10s', timeout: '10s', retries: 30, startPeriod: '20s' },
    volumes: ['kafkadata:/var/lib/kafka/data'],
    appEnv: ({ host, port }) => ({ KAFKA_BROKERS: host + ':' + port }),
  },
  nginx: {
    name: 'nginx',
    capability: 'proxy',
    image: 'nginx:1.27-alpine',
    port: 80,
    appEnv: ({ host, port }) => ({ PROXY_URL: 'http://' + host + ':' + port }),
  },
  liquibase: {
    name: 'liquibase',
    capability: 'migrations',
    image: 'liquibase/liquibase:4.29',
    command: ['update'],
    oneShot: true,
    volumes: ['migrations:/liquibase/changelog'],
    appEnv: () => ({}),
  },
  clickhouse: {
    name: 'clickhouse',
    capability: 'olap',
    image: 'clickhouse/clickhouse-server:24.8-alpine',
    port: 8123,
    extraPorts: [9000],
    env: { CLICKHOUSE_DB: 'arcod', CLICKHOUSE_USER: 'arcod', CLICKHOUSE_PASSWORD: 'arcod', CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' },
    healthcheck: { test: '["CMD-SHELL", "wget -qO- http://127.0.0.1:8123/ping | grep -q Ok"]', interval: '2s', timeout: '2s', retries: 30 },
    volumes: ['clickhousedata:/var/lib/clickhouse'],
    appEnv: ({ host, port }) => ({ CLICKHOUSE_URL: 'http://' + host + ':' + port }),
  },
  prometheus: {
    name: 'prometheus',
    capability: 'metrics',
    image: 'prom/prometheus:v2.54.1',
    port: 9090,
    healthcheck: { test: '["CMD-SHELL", "wget -qO- http://127.0.0.1:9090/-/healthy | grep -qi healthy"]', interval: '5s', timeout: '3s', retries: 30 },
    volumes: ['promdata:/prometheus'],
    appEnv: ({ host, port }) => ({ PROMETHEUS_URL: 'http://' + host + ':' + port }),
  },

  sentry: {
    name: 'sentry',
    capability: 'errors',
    external: true,
    requires: ['dsn'],
    appEnv: ({ args }) => ({
      SENTRY_DSN: String(args.dsn ?? ''),
      SENTRY_ENVIRONMENT: String(args.environment ?? 'development'),
    }),
  },
  jaeger: {
    name: 'jaeger',
    capability: 'tracing',
    image: 'jaegertracing/all-in-one:1.62',
    port: 16686,
    extraPorts: [4318, 4317],
    env: { COLLECTOR_OTLP_ENABLED: 'true' },
    healthcheck: { test: '["CMD-SHELL", "wget -qO- http://127.0.0.1:16686/ | head -c 100 >/dev/null"]', interval: '5s', timeout: '3s', retries: 30 },
    appEnv: ({ host, port }) => ({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://' + host + ':4318',
      JAEGER_UI: 'http://' + host + ':' + port,
    }),
  },
  grafana: {
    name: 'grafana',
    capability: 'dashboards',
    image: 'grafana/grafana:11.2.0',
    port: 3000,
    env: { GF_AUTH_ANONYMOUS_ENABLED: 'true', GF_AUTH_ANONYMOUS_ORG_ROLE: 'Admin', GF_USERS_DEFAULT_THEME: 'dark' },
    healthcheck: { test: '["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/api/health | grep -q ok"]', interval: '5s', timeout: '3s', retries: 40, startPeriod: '10s' },
    volumes: ['grafanadata:/var/lib/grafana'],
    appEnv: ({ host, port }) => ({ GRAFANA_URL: 'http://' + host + ':' + port }),
  },
  mailpit: {
    name: 'mailpit',
    capability: 'mail',
    image: 'axllent/mailpit:v1.21',
    port: 1025,
    extraPorts: [8025],
    healthcheck: { test: '["CMD-SHELL", "wget -qO- http://127.0.0.1:8025/livez | grep -q ok"]', interval: '5s', timeout: '3s', retries: 30 },
    appEnv: ({ host, port }) => ({ SMTP_URL: 'smtp://' + host + ':' + port, MAILPIT_UI: 'http://' + host + ':8025' }),
  },
  vault: {
    name: 'vault',
    capability: 'secrets',
    image: 'hashicorp/vault:1.18',
    port: 8200,
    command: ['server', '-dev', '-dev-root-token-id=root'],
    env: { VAULT_DEV_LISTEN_ADDRESS: '0.0.0.0:8200', VAULT_ADDR: 'http://127.0.0.1:8200' },
    healthcheck: { test: '["CMD-SHELL", "vault status >/dev/null 2>&1 || exit 1"]', interval: '3s', timeout: '3s', retries: 30 },
    appEnv: ({ host, port }) => ({ VAULT_ADDR: 'http://' + host + ':' + port, VAULT_TOKEN: 'root' }),
  },
};

export function providerFor(name: string): ProviderSpec | null {
  return PROVIDERS[name] ?? null;
}

export function providerNames(): string[] {
  return Object.keys(PROVIDERS).sort();
}

// Which capability each provider can satisfy, for diagnostics.
export function providersForCapability(capability: string): string[] {
  const name = capability.includes('.') ? capability.split('.').pop()! : capability;
  return Object.values(PROVIDERS)
    .filter((spec) => spec.capability === name)
    .map((spec) => spec.name)
    .sort();
}
