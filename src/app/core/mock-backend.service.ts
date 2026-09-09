import { Injectable } from '@angular/core';

import { KubeBackend, Unlisten, appError } from './kube-backend';
import {
  Condition,
  ContainerSummary,
  EnvironmentInfo,
  KubeconfigInfo,
  LogBatch,
  LogLine,
  LogStreamEnd,
  LogStreamHandle,
  LogStreamRequest,
  NamespaceError,
  PodSummary,
  PodsResponse,
  ResourceDocument,
  WorkloadKind,
  WorkloadSummary,
  WorkloadsResponse,
} from './models';
import { hashString } from './format';
import { toYaml } from './yaml';

const REGISTRY = '123456789012.dkr.ecr.eu-west-1.amazonaws.com/example';

const DEPLOYMENTS = [
  'api-mgmt',
  'api-distribution',
  'api-orders-mgmt',
  'api-catalog',
  'api-payment',
  'api-external',
  'api-monitoring',
  'app-rest',
  'app-channels',
  'app-customers',
  'app-batch',
  'ms-order',
  'ms-event',
  'ms-ticket',
  'ms-client',
  'ms-channel',
  'ms-venue',
  'ms-entity',
  'ms-delivery',
  'ms-notification',
  'ms-promotion',
  'ms-crm',
  'ms-audit',
  'int-avet-connector',
  'int-mapping-service',
  'api-gateway',
];

const STATEFULSETS = ['hazelcast', 'rabbitmq', 'sys-dcp'];

const NAMESPACES: Record<string, string[]> = {
  pre: ['pre', 'pre01', 'features', 'pre-empty', 'kube-system', 'monitoring'],
  pro: ['pro', 'kube-system', 'monitoring', 'ingress-nginx'],
};

const INFRA_NAMESPACES = ['kube-system', 'monitoring', 'ingress-nginx'];

/** Readable and valid, but with nothing in it — a probe returning 0 is still a success. */
const EMPTY_NAMESPACES = ['pre-empty'];

/** First `probe_namespace` on it fails with a non-`forbidden` error, the retry succeeds. */
const FLAKY_NAMESPACE = 'features';

/** Deployment whose replicas are recycled, so log source groups have something to reconcile. */
const CHURN_SERVICE = 'ms-scaler';
const CHURN_REPLICAS = 3;
const CHURN_INTERVAL_MS = 12000;

/** Only in `features`: with the hash and pod suffix its pods are 58 characters — what the log panes have to survive. */
const LONG_NAME_SERVICE = 'api-external-example-feature-12345-canary';
const LONG_NAME_NAMESPACE = 'features';
const LONG_NAME_REPLICAS = 3;

/** Pods of this service run a sidecar, to exercise the container choice in the source picker. */
const SIDECAR_SERVICES = ['api-mgmt', 'ms-order', CHURN_SERVICE];
const SIDECAR_IMAGE = 'docker.io/istio/proxyv2:1.22.3';

const CONTEXTS: KubeconfigInfo = {
  paths: ['/Users/demo/.kube/config'],
  contexts: [
    {
      name: 'pre',
      cluster: 'arn:aws:eks:eu-west-1:123456789012:cluster/example-pre-eks',
      server: 'https://A1B2C3D4E5F6.gr7.eu-west-1.eks.amazonaws.com',
      namespace: 'pre',
      user: 'example-pre-eks',
      auth: 'exec:aws',
      isCurrent: true,
    },
    {
      name: 'pro',
      cluster: 'arn:aws:eks:eu-west-1:123456789012:cluster/example-pro-eks',
      server: 'https://F6E5D4C3B2A1.gr7.eu-west-1.eks.amazonaws.com',
      namespace: 'pro',
      user: 'example-pro-eks',
      auth: 'exec:aws',
      isCurrent: false,
    },
  ],
};

const LOG_TEMPLATES: readonly [string, string][] = [
  ['INFO', 'c.o.web.RequestLogger      : GET /api/v1/events/{id} 200 in {ms}ms'],
  ['INFO', 'c.o.web.RequestLogger      : POST /api/v1/orders 201 in {ms}ms'],
  ['INFO', 'c.o.cache.HazelcastClient  : cache hit ratio {pct}% over {ms} entries'],
  ['INFO', 'c.o.amqp.MessageDispatcher : dispatched order.updated correlationId={trace}'],
  ['DEBUG', 'c.o.jooq.QueryExecutor     : select from example_events where id = {id} ({ms}ms)'],
  [
    'WARN',
    'c.o.http.DatasourceClient  : slow downstream call ms-event took {ms}ms (threshold 800ms)',
  ],
  ['WARN', 'c.o.security.TokenFilter   : token close to expiry for client {id}, refreshing'],
  [
    'ERROR',
    'c.o.order.OrderService     : failed to confirm order {id}: ME0028 event not published',
  ],
  ['ERROR', 'c.o.http.DatasourceClient  : java.net.SocketTimeoutException: Read timed out'],
];

const STACK_TRACE = [
  '\tat com.example.order.OrderService.confirm(OrderService.java:214)',
  '\tat com.example.order.OrderController.confirm(OrderController.java:96)',
  '\tat java.base/java.lang.Thread.run(Thread.java:1583)',
];

interface MockStream {
  handle: LogStreamHandle;
  timer: number;
}

interface ChurnState {
  templateHash: string;
  image: string;
  random: () => number;
  nextAt: number;
}

interface NamespaceStore {
  pods: PodSummary[];
  workloads: WorkloadSummary[];
  churn?: ChurnState;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomToken(random: () => number, length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let index = 0; index < length; index++) {
    token += alphabet[Math.floor(random() * alphabet.length)];
  }
  return token;
}

function iso(millis: number): string {
  return new Date(millis).toISOString();
}

/**
 * Demo backend used outside the Tauri window: deterministic per (context, namespace) so polling
 * does not shuffle the tables, with a forbidden `list_namespaces` on `pre` to exercise the manual
 * namespace path and a forbidden `restart_workload` on `pro`.
 */
@Injectable()
export class MockBackend extends KubeBackend {
  readonly isDemo = true;

  readonly #stores = new Map<string, NamespaceStore>();
  readonly #probed = new Set<string>();
  readonly #streams = new Map<string, MockStream>();
  readonly #batchHandlers = new Set<(batch: LogBatch) => void>();
  readonly #endHandlers = new Set<(end: LogStreamEnd) => void>();
  #streamSequence = 0;

  async environmentInfo(): Promise<EnvironmentInfo> {
    await this.#latency();
    return {
      path: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      home: '/Users/demo',
      kubeconfigEnv: undefined,
      shell: '/bin/zsh',
      // `pro` points at a plugin that is not installed — the diagnostics panel must flag it.
      execPlugins: [
        { context: 'pre', command: 'aws', resolved: '/opt/homebrew/bin/aws' },
        { context: 'pro', command: 'aws-iam-authenticator', resolved: null },
      ],
    };
  }

  async listContexts(): Promise<KubeconfigInfo> {
    await this.#latency();
    return structuredClone(CONTEXTS);
  }

  async listNamespaces(context: string): Promise<string[]> {
    await this.#latency();
    if (context === 'pre') {
      throw appError(
        'forbidden',
        'namespaces is forbidden: User "example-pre-eks" cannot list resource "namespaces" in API group "" at the cluster scope',
        403,
      );
    }
    return [...(NAMESPACES[context] ?? [])];
  }

  async probeNamespace(context: string, namespace: string): Promise<number> {
    await this.#latency();
    const key = `${context}/${namespace}`;
    if (namespace === FLAKY_NAMESPACE && !this.#probed.has(key)) {
      this.#probed.add(key);
      throw appError(
        'api',
        `cannot read namespace features: an error on the server ("unknown") has prevented the request from succeeding (get pods)`,
        500,
      );
    }
    if (!this.#isKnownNamespace(context, namespace)) {
      throw appError('forbidden', `pods is forbidden in namespace "${namespace}"`, 403);
    }
    return this.#store(context, namespace).pods.length;
  }

  async listPods(context: string, namespaces: string[]): Promise<PodsResponse> {
    await this.#latency();
    const pods: PodSummary[] = [];
    const errors: NamespaceError[] = [];
    for (const namespace of namespaces) {
      if (!this.#isKnownNamespace(context, namespace)) {
        errors.push({
          namespace,
          error: appError('forbidden', `pods is forbidden in namespace "${namespace}"`, 403),
        });
        continue;
      }
      this.#recycleChurnPod(context, namespace);
      pods.push(...this.#store(context, namespace).pods);
    }
    return { context, pods: structuredClone(pods), errors, fetchedAt: iso(Date.now()) };
  }

  async getPodDocument(
    context: string,
    namespace: string,
    name: string,
  ): Promise<ResourceDocument> {
    await this.#latency();
    const pod = this.#store(context, namespace).pods.find((item) => item.name === name);
    if (!pod) {
      throw appError('not_found', `pods "${name}" not found`, 404);
    }
    const manifest = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: pod.name,
        namespace: pod.namespace,
        uid: pod.uid,
        creationTimestamp: pod.createdAt ?? null,
        labels: pod.labels,
        annotations: pod.annotations,
      },
      spec: {
        serviceAccountName: pod.serviceAccount ?? 'default',
        nodeName: pod.node ?? null,
        containers: pod.containers.map((container) => ({
          name: container.name,
          image: container.image,
          ports: container.ports,
          resources: {
            requests: {
              cpu: container.cpuRequest ?? null,
              memory: container.memoryRequest ?? null,
            },
            limits: { cpu: container.cpuLimit ?? null, memory: container.memoryLimit ?? null },
          },
        })),
      },
      status: {
        phase: pod.phase,
        podIP: pod.podIp ?? null,
        hostIP: pod.hostIp ?? null,
        qosClass: pod.qosClass ?? null,
        startTime: pod.startedAt ?? null,
        conditions: pod.conditions.map((condition) => ({
          type: condition.kind,
          status: condition.status,
          reason: condition.reason ?? null,
          lastTransitionTime: condition.lastTransition ?? null,
        })),
        containerStatuses: pod.containers.map((container) => ({
          name: container.name,
          ready: container.ready,
          restartCount: container.restartCount,
          image: container.image,
          imageID: container.imageId ?? null,
          state: { [container.state]: { reason: container.stateReason ?? null } },
        })),
      },
    };
    return { yaml: toYaml(manifest), json: JSON.stringify(manifest, null, 2) };
  }

  async deletePod(context: string, namespace: string, name: string): Promise<string> {
    await this.#latency();
    const store = this.#store(context, namespace);
    const pod = store.pods.find((item) => item.name === name);
    if (!pod) {
      throw appError('not_found', `pods "${name}" not found`, 404);
    }
    pod.status = 'Terminating';
    pod.deletionTimestamp = iso(Date.now());
    setTimeout(() => {
      store.pods = store.pods.filter((item) => item.name !== name);
      this.#endStreamsOfPod(name);
    }, 4000);
    return name;
  }

  async listWorkloads(context: string, namespaces: string[]): Promise<WorkloadsResponse> {
    await this.#latency();
    const workloads: WorkloadSummary[] = [];
    const errors: NamespaceError[] = [];
    for (const namespace of namespaces) {
      if (!this.#isKnownNamespace(context, namespace)) {
        errors.push({
          namespace,
          error: appError('forbidden', `deployments is forbidden in namespace "${namespace}"`, 403),
        });
        continue;
      }
      workloads.push(...this.#store(context, namespace).workloads);
    }
    return { context, workloads: structuredClone(workloads), errors, fetchedAt: iso(Date.now()) };
  }

  async getWorkloadDocument(
    context: string,
    namespace: string,
    kind: WorkloadKind,
    name: string,
  ): Promise<ResourceDocument> {
    await this.#latency();
    const workload = this.#store(context, namespace).workloads.find(
      (item) => item.kind === kind && item.name === name,
    );
    if (!workload) {
      throw appError('not_found', `${kind} "${name}" not found`, 404);
    }
    const manifest = {
      apiVersion: 'apps/v1',
      kind: workload.kind,
      metadata: {
        name: workload.name,
        namespace: workload.namespace,
        uid: workload.uid,
        creationTimestamp: workload.createdAt ?? null,
        labels: workload.labels,
      },
      spec: {
        replicas: workload.desired,
        strategy: { type: workload.strategy ?? 'RollingUpdate' },
        selector: { matchLabels: workload.selector },
        template: {
          metadata: { labels: workload.selector },
          spec: {
            containers: workload.images.map((image, index) => ({ name: `c${index}`, image })),
          },
        },
      },
      status: {
        replicas: workload.desired,
        readyReplicas: workload.ready,
        updatedReplicas: workload.updated,
        availableReplicas: workload.available,
        conditions: workload.conditions.map((condition) => ({
          type: condition.kind,
          status: condition.status,
          reason: condition.reason ?? null,
        })),
      },
    };
    return { yaml: toYaml(manifest), json: JSON.stringify(manifest, null, 2) };
  }

  async restartWorkload(
    context: string,
    namespace: string,
    kind: WorkloadKind,
    name: string,
  ): Promise<string> {
    await this.#latency();
    if (context === 'pro') {
      throw appError(
        'forbidden',
        `${kind.toLowerCase()}s.apps "${name}" is forbidden: User "example-pro-eks" cannot patch resource in namespace "${namespace}"`,
        403,
      );
    }
    return name;
  }

  async startLogStream(request: LogStreamRequest): Promise<LogStreamHandle> {
    await this.#latency(60);
    const pod = this.#store(request.context, request.namespace).pods.find(
      (item) => item.name === request.pod,
    );
    if (!pod) {
      throw appError('not_found', `pods "${request.pod}" not found`, 404);
    }
    const container = request.container ?? pod.containers[0]?.name ?? pod.name;
    const handle: LogStreamHandle = {
      streamId: `demo-${++this.#streamSequence}`,
      namespace: request.namespace,
      pod: request.pod,
      container,
    };
    const random = mulberry32(hashString(handle.streamId + pod.name));
    const service = container;

    // Backfill the requested tail, then keep emitting.
    const backfill = Math.min(request.tailLines ?? 200, 200);
    const now = Date.now();
    const lines: LogLine[] = [];
    for (let index = backfill; index > 0; index--) {
      lines.push(...this.#fabricate(service, random, now - index * 900));
    }
    const stream: MockStream = { handle, timer: 0 };
    setTimeout(() => this.#emit({ streamId: handle.streamId, lines }), 30);

    stream.timer = setInterval(() => {
      this.#emit({
        streamId: handle.streamId,
        lines: this.#fabricate(service, random, Date.now()),
      });
    }, 300) as unknown as number;
    this.#streams.set(handle.streamId, stream);
    return handle;
  }

  async stopLogStream(streamId: string): Promise<void> {
    const stream = this.#streams.get(streamId);
    if (!stream) {
      return;
    }
    clearInterval(stream.timer);
    this.#streams.delete(streamId);
    for (const handler of this.#endHandlers) {
      handler({ streamId });
    }
  }

  async stopAllLogStreams(): Promise<number> {
    const ids = [...this.#streams.keys()];
    for (const id of ids) {
      await this.stopLogStream(id);
    }
    return ids.length;
  }

  async onLogBatch(handler: (batch: LogBatch) => void): Promise<Unlisten> {
    this.#batchHandlers.add(handler);
    return () => this.#batchHandlers.delete(handler);
  }

  async onLogEnd(handler: (end: LogStreamEnd) => void): Promise<Unlisten> {
    this.#endHandlers.add(handler);
    return () => this.#endHandlers.delete(handler);
  }

  async openDevtools(): Promise<void> {
    // Nothing to open in a plain browser.
  }

  /** A deleted pod kills its streams the way the kubelet does — exercises the "pod gone" marker. */
  #endStreamsOfPod(pod: string): void {
    for (const [streamId, stream] of this.#streams) {
      if (stream.handle.pod !== pod) {
        continue;
      }
      clearInterval(stream.timer);
      this.#streams.delete(streamId);
      const error = appError('not_found', `pods "${pod}" not found`, 404);
      for (const handler of this.#endHandlers) {
        handler({ streamId, error });
      }
    }
  }

  #emit(batch: LogBatch): void {
    for (const handler of this.#batchHandlers) {
      handler(batch);
    }
  }

  #fabricate(service: string, random: () => number, at: number) {
    const [level, template] = LOG_TEMPLATES[Math.floor(random() * LOG_TEMPLATES.length)];
    const thread = `http-nio-8080-exec-${1 + Math.floor(random() * 8)}`;
    const body = template
      .replace('{id}', String(40000 + Math.floor(random() * 20000)))
      .replace('{ms}', String(4 + Math.floor(random() * 1400)))
      .replace('{pct}', String(70 + Math.floor(random() * 30)))
      .replace('{trace}', randomToken(random, 16));
    const lines = [
      {
        timestamp: iso(at),
        text: `${level.padEnd(5)} 1 --- [${thread}] ${service} : ${body}`,
      },
    ];
    if (level === 'ERROR' && random() > 0.4) {
      STACK_TRACE.forEach((frame, index) =>
        lines.push({ timestamp: iso(at + index + 1), text: frame }),
      );
    }
    return lines;
  }

  #isKnownNamespace(context: string, namespace: string): boolean {
    return (NAMESPACES[context] ?? []).includes(namespace);
  }

  #latency(base = 140): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, base + Math.random() * 120));
  }

  #store(context: string, namespace: string): NamespaceStore {
    const key = `${context}/${namespace}`;
    const existing = this.#stores.get(key);
    if (existing) {
      return existing;
    }
    const created = this.#generate(context, namespace);
    this.#stores.set(key, created);
    return created;
  }

  #generate(context: string, namespace: string): NamespaceStore {
    if (EMPTY_NAMESPACES.includes(namespace)) {
      return { pods: [], workloads: [] };
    }
    const random = mulberry32(hashString(`${context}/${namespace}`));
    const now = Date.now();
    const infra = INFRA_NAMESPACES.includes(namespace);
    const services = infra
      ? ['coredns', 'aws-node', 'kube-proxy', 'prometheus', 'grafana', 'fluent-bit']
      : namespace === LONG_NAME_NAMESPACE
        ? [LONG_NAME_SERVICE, ...DEPLOYMENTS]
        : DEPLOYMENTS;
    const statefulsets = infra ? [] : STATEFULSETS;

    const pods: PodSummary[] = [];
    const workloads: WorkloadSummary[] = [];
    const target = infra ? 14 : 40;
    let index = 0;

    const churn = infra ? undefined : this.#seedChurn(namespace, random, now, pods, workloads);

    for (const service of [...statefulsets, ...services]) {
      if (pods.length >= target) {
        break;
      }
      const kind: WorkloadKind = statefulsets.includes(service) ? 'StatefulSet' : 'Deployment';
      const desired =
        service === LONG_NAME_SERVICE
          ? LONG_NAME_REPLICAS
          : kind === 'StatefulSet'
            ? 3
            : 1 + Math.floor(random() * 3);
      const version = `${4 + Math.floor(random() * 3)}.${Math.floor(random() * 20)}.${Math.floor(random() * 9)}`;
      const image = infra
        ? `public.ecr.aws/eks-distro/${service}:v1.29.${Math.floor(random() * 9)}`
        : `${REGISTRY}/${service}:${version}`;
      const templateHash = randomToken(random, 9);
      const createdAt = iso(now - Math.floor(3600 + random() * 26 * 24 * 3600) * 1000);
      const selector = { app: service };
      const replicaPods: PodSummary[] = [];

      for (let replica = 0; replica < desired && pods.length < target; replica++) {
        const name =
          kind === 'StatefulSet'
            ? `${service}-${replica}`
            : `${service}-${templateHash}-${randomToken(random, 5)}`;
        const pod = this.#pod({
          name,
          namespace,
          service,
          image,
          kind,
          templateHash,
          index: index++,
          random,
          now,
        });
        pods.push(pod);
        replicaPods.push(pod);
      }

      const ready = replicaPods.filter((pod) => pod.readyCount === pod.totalCount).length;
      workloads.push({
        uid: `wl-${hashString(`${namespace}/${service}`)}`,
        kind,
        name: service,
        namespace,
        desired: replicaPods.length,
        ready,
        updated: replicaPods.length,
        available: ready,
        images: [image],
        createdAt,
        selector,
        strategy: kind === 'Deployment' ? 'RollingUpdate' : 'RollingUpdate',
        paused: false,
        conditions: [
          {
            kind: 'Available',
            status: ready === replicaPods.length ? 'True' : 'False',
            reason:
              ready === replicaPods.length
                ? 'MinimumReplicasAvailable'
                : 'MinimumReplicasUnavailable',
            lastTransition: createdAt,
          },
          {
            kind: 'Progressing',
            status: 'True',
            reason: 'NewReplicaSetAvailable',
            lastTransition: createdAt,
          },
        ],
        labels: { app: service, 'app.kubernetes.io/managed-by': 'Helm' },
      });
    }

    return { pods, workloads, churn };
  }

  /** The churning deployment: `CHURN_REPLICAS` pods now, replaced one by one as time passes. */
  #seedChurn(
    namespace: string,
    random: () => number,
    now: number,
    pods: PodSummary[],
    workloads: WorkloadSummary[],
  ): ChurnState {
    const churn: ChurnState = {
      templateHash: randomToken(random, 9),
      image: `${REGISTRY}/${CHURN_SERVICE}:2.${Math.floor(random() * 20)}.1`,
      random,
      nextAt: now + CHURN_INTERVAL_MS,
    };
    const createdAt = iso(now - 5 * 3600 * 1000);
    for (let replica = 0; replica < CHURN_REPLICAS; replica++) {
      pods.push(this.#churnPod(namespace, churn, now, 90 + replica * 45));
    }
    workloads.push({
      uid: `wl-${hashString(`${namespace}/${CHURN_SERVICE}`)}`,
      kind: 'Deployment',
      name: CHURN_SERVICE,
      namespace,
      desired: CHURN_REPLICAS,
      ready: CHURN_REPLICAS,
      updated: CHURN_REPLICAS,
      available: CHURN_REPLICAS,
      images: [churn.image],
      createdAt,
      selector: { app: CHURN_SERVICE },
      strategy: 'RollingUpdate',
      paused: false,
      conditions: [
        {
          kind: 'Available',
          status: 'True',
          reason: 'MinimumReplicasAvailable',
          lastTransition: createdAt,
        },
        {
          kind: 'Progressing',
          status: 'True',
          reason: 'NewReplicaSetAvailable',
          lastTransition: createdAt,
        },
      ],
      labels: { app: CHURN_SERVICE, 'app.kubernetes.io/managed-by': 'Helm' },
    });
    return churn;
  }

  /** Always Running with a fresh age: a replacement replica must be able to stream logs. */
  #churnPod(namespace: string, churn: ChurnState, now: number, ageSeconds: number): PodSummary {
    return this.#pod({
      name: `${CHURN_SERVICE}-${churn.templateHash}-${randomToken(churn.random, 5)}`,
      namespace,
      service: CHURN_SERVICE,
      image: churn.image,
      kind: 'Deployment',
      templateHash: churn.templateHash,
      index: 0,
      random: churn.random,
      now,
      ageSeconds,
    });
  }

  /**
   * Swaps the oldest churning replica for a brand new one every `CHURN_INTERVAL_MS`, the way a
   * rollout does: the group in the Logs tab loses one pod and gains another between refreshes.
   */
  #recycleChurnPod(context: string, namespace: string): void {
    const store = this.#store(context, namespace);
    const churn = store.churn;
    const now = Date.now();
    if (!churn || now < churn.nextAt) {
      return;
    }
    churn.nextAt = now + CHURN_INTERVAL_MS;
    const replicas = store.pods.filter((pod) => pod.labels['app'] === CHURN_SERVICE);
    const oldest = replicas.reduce<PodSummary | null>(
      (previous, pod) =>
        !previous || Date.parse(pod.createdAt ?? '') < Date.parse(previous.createdAt ?? '')
          ? pod
          : previous,
      null,
    );
    if (oldest) {
      store.pods = store.pods.filter((pod) => pod.name !== oldest.name);
      this.#endStreamsOfPod(oldest.name);
    }
    store.pods.push(this.#churnPod(namespace, churn, now, 3));
  }

  #pod(options: {
    name: string;
    namespace: string;
    service: string;
    image: string;
    kind: WorkloadKind;
    templateHash: string;
    index: number;
    random: () => number;
    now: number;
    /** Left out for a random age; set for a pod that must look freshly created. */
    ageSeconds?: number;
  }): PodSummary {
    const { name, namespace, service, image, kind, templateHash, index, random, now } = options;
    const ageSeconds = options.ageSeconds ?? Math.floor(120 + random() * 22 * 24 * 3600);
    const createdAt = iso(now - ageSeconds * 1000);

    let status = 'Running';
    let phase = 'Running';
    let ready = true;
    let restarts = 0;
    let containerState: ContainerSummary['state'] = 'running';
    let stateReason: string | undefined;
    let deletionTimestamp: string | undefined;

    if (index % 17 === 3) {
      status = 'CrashLoopBackOff';
      phase = 'Running';
      ready = false;
      restarts = 6 + Math.floor(random() * 40);
      containerState = 'waiting';
      stateReason = 'CrashLoopBackOff';
    } else if (index % 23 === 5) {
      status = 'Pending';
      phase = 'Pending';
      ready = false;
      containerState = 'waiting';
      stateReason = 'Unschedulable';
    } else if (index % 29 === 7) {
      status = 'Terminating';
      ready = false;
      deletionTimestamp = iso(now - 25 * 1000);
    } else if (index % 31 === 11) {
      status = 'ContainerCreating';
      phase = 'Pending';
      ready = false;
      containerState = 'waiting';
      stateReason = 'ContainerCreating';
    } else if (index % 13 === 6) {
      restarts = 1 + Math.floor(random() * 4);
    }

    const container: ContainerSummary = {
      name: service,
      image,
      imageId: `docker-pullable://${image.split(':')[0]}@sha256:${randomToken(random, 64)}`,
      ready,
      started: containerState === 'running',
      restartCount: restarts,
      state: containerState,
      stateReason,
      stateMessage:
        stateReason === 'CrashLoopBackOff'
          ? 'back-off 5m0s restarting failed container'
          : stateReason === 'Unschedulable'
            ? '0/6 nodes are available: 6 Insufficient memory'
            : undefined,
      startedAt: containerState === 'running' ? createdAt : undefined,
      lastTerminated:
        restarts > 0
          ? {
              reason: status === 'CrashLoopBackOff' ? 'Error' : 'OOMKilled',
              message: status === 'CrashLoopBackOff' ? 'liveness probe failed' : undefined,
              exitCode: status === 'CrashLoopBackOff' ? 1 : 137,
              startedAt: iso(now - 3600 * 1000),
              finishedAt: iso(now - 3200 * 1000),
            }
          : undefined,
      cpuRequest: '250m',
      cpuLimit: '1',
      memoryRequest: '768Mi',
      memoryLimit: '1Gi',
      ports: ['8080/TCP', '8081/TCP'],
    };

    const containers: ContainerSummary[] = [container];
    if (SIDECAR_SERVICES.includes(service)) {
      containers.push({
        name: 'istio-proxy',
        image: SIDECAR_IMAGE,
        imageId: `docker-pullable://${SIDECAR_IMAGE.split(':')[0]}@sha256:${randomToken(random, 64)}`,
        ready: true,
        started: true,
        restartCount: 0,
        state: 'running',
        startedAt: createdAt,
        cpuRequest: '100m',
        cpuLimit: '2',
        memoryRequest: '128Mi',
        memoryLimit: '1Gi',
        ports: ['15090/TCP', '15021/TCP'],
      });
    }

    const initContainers: ContainerSummary[] = image.startsWith(REGISTRY)
      ? [
          {
            name: 'wait-for-config',
            image: `${REGISTRY}/init-config:1.4.2`,
            imageId: `docker-pullable://${REGISTRY}/init-config@sha256:${randomToken(random, 64)}`,
            ready: true,
            started: false,
            restartCount: 0,
            state: 'terminated',
            stateReason: 'Completed',
            lastTerminated: {
              reason: 'Completed',
              message: `waited for sys-config to serve ${service}.yaml before starting the container`,
              exitCode: 0,
              startedAt: createdAt,
              finishedAt: iso(now - (ageSeconds - 3) * 1000),
            },
            cpuRequest: '50m',
            memoryRequest: '64Mi',
            ports: [],
          },
        ]
      : [];

    const conditions: Condition[] = [
      { kind: 'Initialized', status: 'True', lastTransition: createdAt },
      {
        kind: 'Ready',
        status: ready ? 'True' : 'False',
        reason: ready ? undefined : 'ContainersNotReady',
        message: ready ? undefined : `containers with unready status: [${service}]`,
        lastTransition: createdAt,
      },
      { kind: 'ContainersReady', status: ready ? 'True' : 'False', lastTransition: createdAt },
      {
        kind: 'PodScheduled',
        status: status === 'Pending' ? 'False' : 'True',
        lastTransition: createdAt,
      },
    ];

    return {
      uid: `pod-${hashString(`${namespace}/${name}`)}`,
      name,
      namespace,
      phase,
      status,
      readyCount: containers.filter((item) => item.ready).length,
      totalCount: containers.length,
      restarts,
      createdAt,
      startedAt: createdAt,
      deletionTimestamp,
      node: `ip-10-${40 + Math.floor(random() * 8)}-${Math.floor(random() * 250)}-${Math.floor(random() * 250)}.eu-west-1.compute.internal`,
      podIp: `10.${40 + Math.floor(random() * 8)}.${Math.floor(random() * 250)}.${Math.floor(random() * 250)}`,
      hostIp: `10.${40 + Math.floor(random() * 8)}.${Math.floor(random() * 250)}.1`,
      qosClass: 'Burstable',
      serviceAccount: service,
      owner:
        kind === 'StatefulSet'
          ? { kind: 'StatefulSet', name: service }
          : { kind: 'ReplicaSet', name: `${service}-${templateHash}` },
      workload: { kind, name: service },
      labels: {
        app: service,
        'app.kubernetes.io/name': service,
        'app.kubernetes.io/instance': `${service}-${namespace}`,
        ...(kind === 'Deployment' ? { 'pod-template-hash': templateHash } : {}),
      },
      annotations: {
        'kubectl.kubernetes.io/restartedAt': iso(now - 6 * 3600 * 1000),
        'prometheus.io/scrape': 'true',
      },
      containers,
      initContainers,
      conditions,
    };
  }
}
