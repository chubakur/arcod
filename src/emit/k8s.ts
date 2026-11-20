import type { ModuleNode } from '../ast.ts';
import { kebab } from '../plan.ts';
import { providerFor } from '../providers.ts';
import { composeModel, localEnvironment, providerImage, type RenderedProvider } from './compose.ts';
import { MANAGED_ENDPOINTS } from './terraform.ts';
import { imageContract } from '../deploy.ts';

// The kubernetes target is a second view of the same topology compose emits:
// composeModel() decides which providers exist, their images and the app env,
// and this module draws them as cluster objects. Nothing here talks to a
// cluster: the output is declarative text, deterministic for a given model.

export interface K8sOptions {
  // Which environment's deploy target this render belongs to: its image
  // contract names the image the manifest advertises. Defaults to the first
  // environment that declares a deploy.
  environment?: string;
  image?: string;
  namespace?: string;
  replicas?: number;
  host?: string | null;
  servicePort?: number;
  webImage?: string | null;
  ingressClass?: string;
  // Which sql database a bind-less sql service gets; the same choice the
  // build makes, so the manifest and the service cannot disagree.
  dialect?: 'mysql' | 'postgres';
}

export interface EmittedFile {
  path: string;
  content: string;
}

const APP_PORT = 3000;
const WEB_PORT = 80;

function baseName(mod: ModuleNode): string {
  return 'arcod-' + kebab(mod.name);
}

function labelPairs(partOf: string, name: string, component: string, indent: string): string[] {
  return [
    indent + 'app.kubernetes.io/name: ' + name,
    indent + 'app.kubernetes.io/component: ' + component,
    indent + 'app.kubernetes.io/part-of: ' + partOf,
    indent + 'app.kubernetes.io/managed-by: arcod',
  ];
}

function selectorPairs(name: string, component: string, indent: string): string[] {
  return [
    indent + 'app.kubernetes.io/name: ' + name,
    indent + 'app.kubernetes.io/component: ' + component,
  ];
}

// Docker healthchecks are either ["CMD", ...] or ["CMD-SHELL", "..."]; both map
// onto an exec probe. Anything unparsable falls back to a tcp probe.
function execProbe(test: string | undefined): string[] | null {
  if (!test) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(test);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 2) return null;
  const kind = String(parsed[0]).toUpperCase();
  const rest = parsed.slice(1).map((part) => String(part));
  if (kind === 'CMD') return rest;
  if (kind === 'CMD-SHELL') return ['/bin/sh', '-c', rest.join(' ')];
  return null;
}

function probeLines(port: number, command: string[] | null, indent: string): string[] {
  const lines: string[] = [indent + 'readinessProbe:'];
  if (command) {
    lines.push(indent + '  exec:', indent + '    command: ' + JSON.stringify(command));
  } else if (port > 0) {
    lines.push(indent + '  tcpSocket:', indent + '    port: ' + port);
  } else {
    return [];
  }
  lines.push(
    indent + '  initialDelaySeconds: 3',
    indent + '  periodSeconds: 5',
    indent + '  timeoutSeconds: 3',
    indent + '  failureThreshold: 30',
  );
  return lines;
}

function httpProbeLines(path: string, port: number, indent: string): string[] {
  return [
    indent + 'readinessProbe:',
    indent + '  httpGet:',
    indent + '    path: ' + path,
    indent + '    port: ' + port,
    indent + '  initialDelaySeconds: 3',
    indent + '  periodSeconds: 5',
    indent + '  timeoutSeconds: 3',
    indent + '  failureThreshold: 30',
    indent + 'livenessProbe:',
    indent + '  httpGet:',
    indent + '    path: ' + path,
    indent + '    port: ' + port,
    indent + '  initialDelaySeconds: 10',
    indent + '  periodSeconds: 20',
    indent + '  timeoutSeconds: 5',
    indent + '  failureThreshold: 6',
  ];
}

interface Workload {
  partOf: string;
  name: string;
  component: string;
  namespace: string;
  replicas: string;
  // A single-instance store must not overlap two pods: the claim is exclusive
  // and the second instance would answer from a different store.
  strategy?: 'Recreate';
  image: string;
  port: number;
  extraPorts?: number[];
  command?: string[] | null;
  env?: Record<string, string> | null;
  envFromConfigMap?: string | null;
  envFromSecret?: string | null;
  mounts?: Array<{ path: string; claim: string }>;
  // Env entries whose value the cluster only learns at apply time: the pod
  // reads them from a Secret instead of carrying a literal.
  secretRefs?: Array<{ name: string; key: string; secret: string }>;
  probe?: string[];
  resources?: boolean;
}

function workloadYaml(w: Workload): string {
  const lines: string[] = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: ' + w.name,
    '  namespace: ' + w.namespace,
    '  labels:',
    ...labelPairs(w.partOf, w.name, w.component, '    '),
    'spec:',
    '  replicas: ' + w.replicas,
    ...(w.strategy ? ['  strategy:', '    type: ' + w.strategy] : []),
    '  selector:',
    '    matchLabels:',
    ...selectorPairs(w.name, w.component, '      '),
    '  template:',
    '    metadata:',
    '      labels:',
    ...labelPairs(w.partOf, w.name, w.component, '        '),
    '    spec:',
    '      containers:',
    '        - name: ' + w.component,
    '          image: ' + w.image,
    '          imagePullPolicy: IfNotPresent',
  ];

  if (w.command && w.command.length > 0) lines.push('          command: ' + JSON.stringify(w.command));

  if (w.port > 0) {
    lines.push('          ports:', '            - containerPort: ' + w.port);
    for (const extra of w.extraPorts ?? []) lines.push('            - containerPort: ' + extra);
  }

  const refsInEnv = w.secretRefs ?? [];
  if ((w.env && Object.keys(w.env).length > 0) || refsInEnv.length > 0) {
    lines.push('          env:');
    for (const key of Object.keys(w.env ?? {}).sort()) {
      lines.push('            - name: ' + key, '              value: ' + JSON.stringify(w.env![key]));
    }
    for (const ref of refsInEnv) {
      lines.push(
        '            - name: ' + ref.name,
        '              valueFrom:',
        '                secretKeyRef:',
        '                  name: ' + ref.secret,
        '                  key: ' + ref.key,
      );
    }
  }

  const refs: string[] = [];
  if (w.envFromConfigMap) refs.push('            - configMapRef:\n                name: ' + w.envFromConfigMap);
  if (w.envFromSecret) refs.push('            - secretRef:\n                name: ' + w.envFromSecret);
  if (refs.length > 0) {
    lines.push('          envFrom:');
    for (const ref of refs) lines.push(ref);
  }

  if (w.mounts && w.mounts.length > 0) {
    lines.push('          volumeMounts:');
    for (const mount of w.mounts) {
      lines.push('            - name: ' + mount.claim, '              mountPath: ' + mount.path);
    }
  }

  if (w.resources) {
    lines.push(
      '          resources:',
      '            requests:',
      '              cpu: 50m',
      '              memory: 64Mi',
      '            limits:',
      '              memory: 512Mi',
    );
  }

  if (w.probe && w.probe.length > 0) lines.push(...w.probe);

  if (w.mounts && w.mounts.length > 0) {
    lines.push('      volumes:');
    for (const mount of w.mounts) {
      lines.push(
        '        - name: ' + mount.claim,
        '          persistentVolumeClaim:',
        '            claimName: ' + mount.claim,
      );
    }
  }

  return lines.join('\n');
}

function serviceYaml(partOf: string, name: string, component: string, ports: number[], namespace: string): string {
  const lines: string[] = [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: ' + name,
    '  namespace: ' + namespace,
    '  labels:',
    ...labelPairs(partOf, name, component, '    '),
    'spec:',
    '  type: ClusterIP',
    '  selector:',
    ...selectorPairs(name, component, '    '),
    '  ports:',
  ];
  for (const port of ports) {
    lines.push(
      '    - name: port-' + port,
      '      port: ' + port,
      '      targetPort: ' + port,
    );
  }
  return lines.join('\n');
}

function namespaceYaml(name: string, namespace: string): string {
  return [
    'apiVersion: v1',
    'kind: Namespace',
    'metadata:',
    '  name: ' + namespace,
    '  labels:',
    ...labelPairs(name, name, 'namespace', '    '),
  ].join('\n');
}

function configMapYaml(name: string, namespace: string, env: Record<string, string>): string {
  const header = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: ' + name,
    '  namespace: ' + namespace,
  ];
  const keys = Object.keys(env).sort();
  if (keys.length === 0) return [...header, 'data: {}'].join('\n');
  const lines = [...header, 'data:'];
  for (const key of keys) lines.push('  ' + key + ': ' + JSON.stringify(env[key]));
  return lines.join('\n');
}

// Values from the development defaults are fine for a laptop; a cluster wants
// them to come from a secret store. The annotation says which one this is.
function secretYaml(name: string, namespace: string, partOf: string, values: Record<string, string>): string {
  const lines = [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    '  name: ' + name,
    '  namespace: ' + namespace,
    '  labels:',
    ...labelPairs(partOf, name, 'secret', '    '),
    '  annotations:',
    '    arcod.dev/note: "development defaults; replace with an ExternalSecret or a sealed secret before production"',
    'type: Opaque',
    'stringData:',
  ];
  for (const key of Object.keys(values).sort()) lines.push('  ' + key + ': ' + JSON.stringify(values[key]));
  return lines.join('\n');
}

// When a secrets capability is bound, the same Secret name is produced by the
// External Secrets operator from Vault: no credential is written to disk.
function externalSecretYaml(
  name: string,
  namespace: string,
  partOf: string,
  keys: string[],
  vault: { path: string; store: string },
): string {
  const lines = [
    'apiVersion: external-secrets.io/v1beta1',
    'kind: ExternalSecret',
    'metadata:',
    '  name: ' + name,
    '  namespace: ' + namespace,
    '  labels:',
    ...labelPairs(partOf, name, 'secret', '    '),
    'spec:',
    '  refreshInterval: 1h',
    '  secretStoreRef:',
    '    name: ' + vault.store,
    '    kind: ClusterSecretStore',
    '  target:',
    '    name: ' + name,
    '    creationPolicy: Owner',
    '  data:',
  ];
  for (const key of keys.sort()) {
    lines.push(
      '    - secretKey: ' + key,
      '      remoteRef:',
      '        key: ' + vault.path,
      '        property: ' + key,
    );
  }
  return lines.join('\n');
}

function pvcYaml(partOf: string, claim: string, namespace: string): string {
  return [
    'apiVersion: v1',
    'kind: PersistentVolumeClaim',
    'metadata:',
    '  name: ' + claim,
    '  namespace: ' + namespace,
    '  labels:',
    ...labelPairs(partOf, claim, 'storage', '    '),
    'spec:',
    '  accessModes:',
    '    - ReadWriteOnce',
    '  resources:',
    '    requests:',
    '      storage: 1Gi',
  ].join('\n');
}

interface Ctx {
  name: string;
  namespace: string;
  replicas: string;
  appImage: string;
  webImage: string;
  host: string | null;
  ingressClass: string;
  hasUi: boolean;
  appPort: number;
  providers: RenderedProvider[];
  plainEnv: Record<string, string>;
  hiddenEnv: Record<string, string>;
  vault: { path: string; store: string } | null;
  // Secret that carries the endpoints a cloud assigned, and the env entries
  // that read it. Empty on a docker-view render.
  endpoints: { secret: string; refs: Array<{ name: string; key: string; hint: string }> } | null;
  // Provider hosts the cloud owns: the plan provisions them, so no workload is
  // drawn for them. Empty on a docker-view render.
  managedHosts: string[];
  tpl: boolean;
}

function splitImage(image: string): { repository: string; tag: string } {
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon > slash) return { repository: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { repository: image, tag: 'latest' };
}

function isSecretKey(key: string, declared: readonly string[]): boolean {
  return declared.some((name) => key === name || key.startsWith(name + '_'));
}

function splitEnv(
  env: Record<string, string>,
  declared: readonly string[],
): { plain: Record<string, string>; hidden: Record<string, string> } {
  const plain: Record<string, string> = {};
  const hidden: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isSecretKey(key, declared)) hidden[key] = value;
    else plain[key] = value;
  }
  return { plain, hidden };
}

function literalArg(bind: { args: Record<string, unknown> }, key: string): string | null {
  const expr = bind.args[key] as { kind?: string; value?: unknown } | undefined;
  if (!expr || expr.kind !== 'literal' || typeof expr.value !== 'string') return null;
  return expr.value;
}

function contextOf(mod: ModuleNode, options: K8sOptions, tpl: boolean): Ctx {
  // The service serves page HTML for render: ssr, so there is no separate web
  // deployment or ingress backend for it.
  const hasUi = mod.uis.length > 0 && mod.uis[0].render !== 'ssr';
  // The topology comes from the environment being rendered, not from the local
  // docker view: a cloud environment binds the providers the plan provisions.
  const model = composeModel(mod, 0, hasUi, undefined, options.dialect, options.environment);
  const name = baseName(mod);
  // The same contract the deploy manifest publishes: no second spelling of
  // the image name that only differs by ':latest'.
  const deployEnv = options.environment
    ? mod.environments.find((item) => item.name === options.environment)
    : mod.environments.find((item) => item.deploy);
  const service = mod.services.find((item) => !item.external);
  const derived = deployEnv && deployEnv.deploy && service
    ? imageContract(mod, deployEnv, service.name).image
    : name + ':latest';
  const appImage = options.image && options.image.length > 0 ? options.image : derived;
  const webImage = options.webImage && options.webImage.length > 0 ? options.webImage : name + '-web:latest';

  // Credentials are whatever the bound providers call sensitive; nothing is
  // guessed from names. A secrets-capability bind switches the same Secret to
  // an ExternalSecret sourced from Vault.
  const declared = new Set<string>();
  for (const item of model.providers) for (const key of item.spec.secrets ?? []) declared.add(key);
  const keys = [...declared];
  const env = splitEnv(model.appEnv, keys);

  // A managed service is one the plan creates. Drawing a Deployment for it
  // would start a second database in the cluster that the app never addresses.
  const managedHosts = deployEnv?.deploy?.provider === 'yandex'
    ? model.providers.filter((item) => MANAGED_ENDPOINTS[item.spec.name]).map((item) => item.host)
    : [];
  const endpoints = managedHosts.length > 0
    ? endpointContract(name, model.providers, env)
    : null;

  // The secret store is an environment's bind like any other: a cloud
  // environment may source credentials from Vault while the local one does not.
  const environment = (options.environment
    ? mod.environments.find((item) => item.name === options.environment)
    : undefined) ?? localEnvironment(mod);
  const vaultBind = (environment?.binds ?? []).find((bind) => providerFor(bind.provider)?.capability === 'secrets');
  const path = vaultBind ? literalArg(vaultBind as unknown as { args: Record<string, unknown> }, 'path') : null;
  const store = vaultBind ? literalArg(vaultBind as unknown as { args: Record<string, unknown> }, 'store') : null;
  const vault = path ? { path, store: store ?? 'vault-backend' } : null;

  return {
    name,
    namespace: tpl ? '{{ .Release.Namespace }}' : options.namespace ?? name,
    replicas: tpl ? '{{ .Values.replicaCount }}' : String(options.replicas ?? 1),
    appImage: tpl ? '{{ .Values.image.repository }}:{{ .Values.image.tag }}' : appImage,
    webImage: tpl ? '{{ .Values.web.image.repository }}:{{ .Values.web.image.tag }}' : webImage,
    host: tpl ? '{{ .Values.ingress.host }}' : options.host ?? null,
    ingressClass: tpl ? '{{ .Values.ingress.className }}' : options.ingressClass ?? 'nginx',
    hasUi: model.hasUi,
    appPort: options.servicePort ?? APP_PORT,
    providers: model.providers,
    plainEnv: env.plain,
    hiddenEnv: env.hidden,
    vault,
    endpoints,
    managedHosts,
    tpl,
  };
}

// A cloud assigns a managed endpoint at apply time, so compose's docker
// address (`postgres://app:secret@pg:5432/app`) would aim the pod at a service
// that does not exist in the cluster. The whole URL moves into a Secret filled
// from the terraform outputs, and the pod reads it by key; W044 names the same
// gap from the spec side, before anything is applied.
function endpointContract(
  appName: string,
  providers: RenderedProvider[],
  env: { plain: Record<string, string>; hidden: Record<string, string> },
): Ctx['endpoints'] {
  const refs: Array<{ name: string; key: string; hint: string }> = [];
  for (const item of providers) {
    const endpoint = MANAGED_ENDPOINTS[item.spec.name];
    if (!endpoint) continue;
    const address = item.host + ':' + item.port;
    for (const bucket of [env.plain, env.hidden]) {
      for (const [key, value] of Object.entries(bucket)) {
        if (!value.includes(address)) continue;
        delete bucket[key];
        if (refs.some((ref) => ref.name === key)) continue;
        refs.push({
          name: key,
          key: key.toLowerCase(),
          hint: endpoint.output + '_host and ' + endpoint.output + '_port',
        });
      }
    }
  }
  if (refs.length === 0) return null;
  refs.sort((a, b) => a.name.localeCompare(b.name));
  return { secret: appName + '-endpoints', refs };
}

// The manifest cannot fill the Secret: only terraform knows the address it just
// created. The comment names the key and the output that feeds it, so the
// deployment is not a pod that starts and fails to resolve `pg`.
function endpointComment(ctx: Ctx): string[] {
  const endpoints = ctx.endpoints;
  if (!endpoints) return [];
  const lines = [
    '# Managed endpoints: the cloud assigns these addresses, so the env entries',
    '# below read them from a Secret instead of a literal docker host name.',
    '# After `terraform apply`, create it in the namespace:',
    '#   kubectl -n ' + ctx.namespace + ' create secret generic ' + endpoints.secret,
  ];
  for (const ref of endpoints.refs) {
    lines.push('#   key ' + ref.key + '  <-  terraform output ' + ref.hint + ' (plus the credentials the app uses)');
  }
  if (ctx.managedHosts.length > 0) {
    lines.push('# Not deployed here, the plan owns them: ' + ctx.managedHosts.join(', ') + '.');
  }
  return lines;
}

function providerFiles(ctx: Ctx): EmittedFile[] {
  const files: EmittedFile[] = [];
  const managed = new Set(ctx.managedHosts);
  for (const item of ctx.providers) {
    if (managed.has(item.host)) continue;
    const image = providerImage(item);
    if (!image) continue;
    const mountPath = item.spec.volumes?.[0]?.split(':')[1] ?? null;
    const claim = mountPath ? item.host + '-data' : null;
    if (claim) files.push({ path: item.host + '-data.yaml', content: pvcYaml(ctx.name, claim, ctx.namespace) });

    // Provider passwords bootstrap the deployed dependency itself, so they stay
    // with the dependency rather than in the app's secret.
    const env = splitEnv(item.spec.env ?? {}, item.spec.secrets ?? []);
    if (Object.keys(env.hidden).length > 0) {
      files.push({
        path: item.host + '-secret.yaml',
        content: secretYaml(item.host + '-env', ctx.namespace, ctx.name, env.hidden),
      });
    }

    const ports = item.port > 0 ? [item.port, ...(item.spec.extraPorts ?? [])] : [];
    const deployment = workloadYaml({
      partOf: ctx.name,
      name: item.host,
      component: item.host,
      namespace: ctx.namespace,
      // A provider image is single-instance software here (redis without
      // cluster config, mysql on a ReadWriteOnce claim): `--replicas` would
      // put independent stores behind one Service, so it scales the app only.
      replicas: '1',
      strategy: 'Recreate',
      image,
      port: item.port,
      extraPorts: item.spec.extraPorts,
      // keycloak's --import-realm needs a mounted file, which is a deliberate
      // gap on this target: the realm travels with compose, not with k8s.
      command: item.spec.command ?? null,
      env: env.plain,
      envFromSecret: Object.keys(env.hidden).length > 0 ? item.host + '-env' : null,
      mounts: claim && mountPath ? [{ path: mountPath, claim }] : [],
      probe: probeLines(item.port, execProbe(item.spec.healthcheck?.test), '          '),
    });
    const service = ports.length > 0 ? '\n---\n' + serviceYaml(ctx.name, item.host, item.host, ports, ctx.namespace) : '';
    files.push({ path: item.host + '.yaml', content: deployment + service });
  }
  return files;
}

function appSecretFiles(ctx: Ctx): EmittedFile[] {
  const keys = Object.keys(ctx.hiddenEnv);
  if (keys.length === 0) return [];
  if (ctx.vault) {
    return [
      {
        path: 'externalsecret.yaml',
        content: externalSecretYaml(ctx.name + '-env', ctx.namespace, ctx.name, keys, ctx.vault),
      },
    ];
  }
  return [{ path: 'secret.yaml', content: secretYaml(ctx.name + '-env', ctx.namespace, ctx.name, ctx.hiddenEnv) }];
}

function appFiles(ctx: Ctx): EmittedFile[] {
  const deployment = workloadYaml({
    partOf: ctx.name,
    name: 'service',
    component: 'service',
    namespace: ctx.namespace,
    replicas: ctx.replicas,
    image: ctx.appImage,
    port: ctx.appPort,
    envFromConfigMap: Object.keys(ctx.plainEnv).length > 0 ? ctx.name + '-env' : null,
    envFromSecret: Object.keys(ctx.hiddenEnv).length > 0 ? ctx.name + '-env' : null,
    secretRefs: ctx.endpoints ? ctx.endpoints.refs.map((ref) => ({ name: ref.name, key: ref.key, secret: ctx.endpoints!.secret })) : undefined,
    probe: httpProbeLines('/healthz', ctx.appPort, '          '),
    resources: true,
  });
  const comment = endpointComment(ctx);
  return [
    {
      path: 'service.yaml',
      content: (comment.length > 0 ? comment.join('\n') + '\n' : '') +
        deployment + '\n---\n' + serviceYaml(ctx.name, 'service', 'service', [ctx.appPort], ctx.namespace),
    },
  ];
}

function webFiles(ctx: Ctx): EmittedFile[] {
  if (!ctx.hasUi) return [];
  const deployment = workloadYaml({
    partOf: ctx.name,
    name: 'web',
    component: 'web',
    namespace: ctx.namespace,
    replicas: ctx.replicas,
    image: ctx.webImage,
    port: WEB_PORT,
    probe: probeLines(WEB_PORT, ['wget', '-qO-', 'http://127.0.0.1/healthz'], '          '),
    resources: true,
  });
  return [
    {
      path: 'web.yaml',
      content: deployment + '\n---\n' + serviceYaml(ctx.name, 'web', 'web', [WEB_PORT], ctx.namespace),
    },
  ];
}

function ingressYaml(ctx: Ctx, backend: string, backendPort: number): string {
  return [
    'apiVersion: networking.k8s.io/v1',
    'kind: Ingress',
    'metadata:',
    '  name: ' + ctx.name,
    '  namespace: ' + ctx.namespace,
    '  labels:',
    ...labelPairs(ctx.name, ctx.name, 'ingress', '    '),
    'spec:',
    '  ingressClassName: ' + ctx.ingressClass,
    '  rules:',
    '    - host: ' + (ctx.host ?? 'arcod.local'),
    '      http:',
    '        paths:',
    '          - path: /',
    '            pathType: Prefix',
    '            backend:',
    '              service:',
    '                name: ' + backend,
    '                port:',
    '                  number: ' + backendPort,
  ].join('\n');
}

export function k8sManifests(mod: ModuleNode, options: K8sOptions = {}): EmittedFile[] {
  const ctx = contextOf(mod, options, false);
  const files: EmittedFile[] = [
    { path: '00-namespace.yaml', content: namespaceYaml(ctx.name, ctx.namespace) },
    // A module whose whole app env is secret keeps no ConfigMap at all.
    ...(Object.keys(ctx.plainEnv).length > 0
      ? [{ path: 'configmap.yaml', content: configMapYaml(ctx.name + '-env', ctx.namespace, ctx.plainEnv) }]
      : []),
    ...appSecretFiles(ctx),
    ...providerFiles(ctx),
    ...appFiles(ctx),
    ...webFiles(ctx),
  ];
  if (ctx.host) {
    files.push({
      path: 'ingress.yaml',
      content: ingressYaml(ctx, ctx.hasUi ? 'web' : 'service', ctx.hasUi ? WEB_PORT : ctx.appPort),
    });
  }
  return files;
}

function chartYaml(mod: ModuleNode, ctx: Ctx): string {
  return [
    'apiVersion: v2',
    'name: ' + ctx.name,
    'description: ' + JSON.stringify('Arcod module ' + mod.name),
    'type: application',
    'version: 0.1.0',
    'appVersion: "0.1.0"',
    '',
  ].join('\n');
}

function valuesYaml(ctx: Ctx, appImage: string, webImage: string, host: string | null, ingressClass: string): string {
  const app = splitImage(appImage);
  const web = splitImage(webImage);
  return [
    'replicaCount: 1',
    '',
    'image:',
    '  repository: ' + app.repository,
    '  tag: ' + app.tag,
    '  pullPolicy: IfNotPresent',
    '',
    'web:',
    '  image:',
    '    repository: ' + web.repository,
    '    tag: ' + web.tag,
    '',
    'service:',
    '  port: ' + ctx.appPort,
    '',
    'ingress:',
    '  enabled: ' + (host ? 'true' : 'false'),
    '  className: ' + ingressClass,
    '  host: ' + (host ?? 'arcod.local'),
    '',
  ].join('\n');
}

export function helmChart(mod: ModuleNode, options: K8sOptions = {}): EmittedFile[] {
  const ctx = contextOf(mod, options, true);
  const appImage = options.image && options.image.length > 0 ? options.image : ctx.name + ':latest';
  const webImage = options.webImage && options.webImage.length > 0 ? options.webImage : ctx.name + '-web:latest';
  const host = options.host ?? null;
  const files: EmittedFile[] = [
    { path: 'Chart.yaml', content: chartYaml(mod, ctx) },
    { path: 'values.yaml', content: valuesYaml(ctx, appImage, webImage, host, options.ingressClass ?? 'nginx') },
    ...(Object.keys(ctx.plainEnv).length > 0
      ? [{ path: 'templates/configmap.yaml', content: configMapYaml(ctx.name + '-env', ctx.namespace, ctx.plainEnv) }]
      : []),
  ];
  for (const file of appSecretFiles(ctx)) files.push({ path: 'templates/' + file.path, content: file.content });
  for (const file of providerFiles(ctx)) files.push({ path: 'templates/' + file.path, content: file.content });
  for (const file of appFiles(ctx)) files.push({ path: 'templates/' + file.path, content: file.content });
  for (const file of webFiles(ctx)) files.push({ path: 'templates/' + file.path, content: file.content });
  files.push({
    path: 'templates/ingress.yaml',
    content: '{{- if .Values.ingress.enabled }}\n' + ingressYaml(ctx, ctx.hasUi ? 'web' : 'service', ctx.hasUi ? WEB_PORT : ctx.appPort) + '\n{{- end }}\n',
  });
  return files;
}
