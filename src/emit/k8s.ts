import type { ModuleNode } from '../ast.ts';
import { kebab } from '../plan.ts';
import { composeModel, providerImage, type RenderedProvider } from './compose.ts';

// The kubernetes target is a second view of the same topology compose emits:
// composeModel() decides which providers exist, their images and the app env,
// and this module draws them as cluster objects. Nothing here talks to a
// cluster: the output is declarative text, deterministic for a given model.

export interface K8sOptions {
  image?: string;
  namespace?: string;
  replicas?: number;
  host?: string | null;
  servicePort?: number;
  webImage?: string | null;
  ingressClass?: string;
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
  image: string;
  port: number;
  extraPorts?: number[];
  command?: string[] | null;
  env?: Record<string, string> | null;
  envFromConfigMap?: string | null;
  mounts?: Array<{ path: string; claim: string }>;
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

  if (w.env && Object.keys(w.env).length > 0) {
    lines.push('          env:');
    for (const key of Object.keys(w.env).sort()) {
      lines.push('            - name: ' + key, '              value: ' + JSON.stringify(w.env[key]));
    }
  } else if (w.envFromConfigMap) {
    lines.push(
      '          envFrom:',
      '            - configMapRef:',
      '                name: ' + w.envFromConfigMap,
    );
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
  appEnv: Record<string, string>;
  tpl: boolean;
}

function splitImage(image: string): { repository: string; tag: string } {
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon > slash) return { repository: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { repository: image, tag: 'latest' };
}

function contextOf(mod: ModuleNode, options: K8sOptions, tpl: boolean): Ctx {
  const model = composeModel(mod, 0, mod.uis.length > 0);
  const name = baseName(mod);
  const appImage = options.image && options.image.length > 0 ? options.image : name + ':latest';
  const webImage = options.webImage && options.webImage.length > 0 ? options.webImage : name + '-web:latest';
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
    appEnv: model.appEnv,
    tpl,
  };
}

function providerFiles(ctx: Ctx): EmittedFile[] {
  const files: EmittedFile[] = [];
  for (const item of ctx.providers) {
    const image = providerImage(item);
    if (!image) continue;
    const mountPath = item.spec.volumes?.[0]?.split(':')[1] ?? null;
    const claim = mountPath ? item.host + '-data' : null;
    if (claim) files.push({ path: item.host + '-data.yaml', content: pvcYaml(ctx.name, claim, ctx.namespace) });

    const ports = item.port > 0 ? [item.port, ...(item.spec.extraPorts ?? [])] : [];
    const deployment = workloadYaml({
      partOf: ctx.name,
      name: item.host,
      component: item.host,
      namespace: ctx.namespace,
      replicas: ctx.replicas,
      image,
      port: item.port,
      extraPorts: item.spec.extraPorts,
      // keycloak's --import-realm needs a mounted file, which is a deliberate
      // gap on this target: the realm travels with compose, not with k8s.
      command: item.spec.command ?? null,
      env: item.spec.env ?? null,
      mounts: claim && mountPath ? [{ path: mountPath, claim }] : [],
      probe: probeLines(item.port, execProbe(item.spec.healthcheck?.test), '          '),
    });
    const service = ports.length > 0 ? '\n---\n' + serviceYaml(ctx.name, item.host, item.host, ports, ctx.namespace) : '';
    files.push({ path: item.host + '.yaml', content: deployment + service });
  }
  return files;
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
    envFromConfigMap: ctx.name + '-env',
    probe: httpProbeLines('/healthz', ctx.appPort, '          '),
    resources: true,
  });
  return [
    {
      path: 'service.yaml',
      content: deployment + '\n---\n' + serviceYaml(ctx.name, 'service', 'service', [ctx.appPort], ctx.namespace),
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
    { path: 'configmap.yaml', content: configMapYaml(ctx.name + '-env', ctx.namespace, ctx.appEnv) },
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
    { path: 'templates/configmap.yaml', content: configMapYaml(ctx.name + '-env', ctx.namespace, ctx.appEnv) },
  ];
  for (const file of providerFiles(ctx)) files.push({ path: 'templates/' + file.path, content: file.content });
  for (const file of appFiles(ctx)) files.push({ path: 'templates/' + file.path, content: file.content });
  for (const file of webFiles(ctx)) files.push({ path: 'templates/' + file.path, content: file.content });
  files.push({
    path: 'templates/ingress.yaml',
    content: '{{- if .Values.ingress.enabled }}\n' + ingressYaml(ctx, ctx.hasUi ? 'web' : 'service', ctx.hasUi ? WEB_PORT : ctx.appPort) + '\n{{- end }}\n',
  });
  return files;
}
