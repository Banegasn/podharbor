/** Mirror of `src-tauri/src/models.rs` (serde camelCase). */

export type AppErrorKind =
  'forbidden' | 'unauthorized' | 'not_found' | 'auth' | 'network' | 'config' | 'api' | 'other';

export interface AppError {
  kind: AppErrorKind;
  message: string;
  status?: number;
}

/** One exec auth plugin declared by a kubeconfig context, resolved against the app's PATH. */
export interface ExecPluginInfo {
  context: string;
  command: string;
  /** Absolute path found on the PATH, `null` when the binary is missing. */
  resolved: string | null;
}

export interface EnvironmentInfo {
  path: string;
  home?: string;
  kubeconfigEnv?: string;
  shell?: string;
  execPlugins: ExecPluginInfo[];
}

export interface KubeContext {
  name: string;
  cluster: string;
  server?: string;
  namespace?: string;
  user: string;
  /** exec:<command> | token | certificate | basic | none */
  auth: string;
  isCurrent: boolean;
}

export interface KubeconfigInfo {
  paths: string[];
  contexts: KubeContext[];
}

export interface NamespaceError {
  namespace: string;
  error: AppError;
}

export interface TerminatedState {
  reason?: string;
  message?: string;
  exitCode: number;
  startedAt?: string;
  finishedAt?: string;
}

export type ContainerState = 'running' | 'waiting' | 'terminated' | 'unknown';

export interface ContainerSummary {
  name: string;
  image: string;
  imageId?: string;
  ready: boolean;
  started?: boolean;
  restartCount: number;
  state: ContainerState;
  stateReason?: string;
  stateMessage?: string;
  startedAt?: string;
  lastTerminated?: TerminatedState;
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  ports: string[];
}

export interface OwnerRef {
  kind: string;
  name: string;
}

export interface Condition {
  kind: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransition?: string;
}

export interface PodSummary {
  uid: string;
  name: string;
  namespace: string;
  phase: string;
  /** kubectl-style status: Running, CrashLoopBackOff, Terminating, Completed... */
  status: string;
  readyCount: number;
  totalCount: number;
  restarts: number;
  createdAt?: string;
  startedAt?: string;
  deletionTimestamp?: string;
  node?: string;
  podIp?: string;
  hostIp?: string;
  qosClass?: string;
  serviceAccount?: string;
  owner?: OwnerRef;
  workload?: OwnerRef;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  containers: ContainerSummary[];
  initContainers: ContainerSummary[];
  conditions: Condition[];
}

export interface PodsResponse {
  context: string;
  pods: PodSummary[];
  errors: NamespaceError[];
  fetchedAt: string;
}

export type WorkloadKind = 'Deployment' | 'StatefulSet';

export interface WorkloadSummary {
  uid: string;
  kind: WorkloadKind;
  name: string;
  namespace: string;
  desired: number;
  ready: number;
  updated: number;
  available: number;
  images: string[];
  createdAt?: string;
  selector: Record<string, string>;
  strategy?: string;
  paused: boolean;
  conditions: Condition[];
  labels: Record<string, string>;
}

export interface WorkloadsResponse {
  context: string;
  workloads: WorkloadSummary[];
  errors: NamespaceError[];
  fetchedAt: string;
}

export interface ResourceDocument {
  yaml: string;
  json: string;
}

export interface LogLine {
  timestamp?: string;
  text: string;
}

export interface LogBatch {
  streamId: string;
  lines: LogLine[];
}

export interface LogStreamEnd {
  streamId: string;
  error?: AppError;
}

export interface LogStreamHandle {
  streamId: string;
  namespace: string;
  pod: string;
  container: string;
}

export interface LogStreamRequest {
  context: string;
  namespace: string;
  pod: string;
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
  follow?: boolean;
  previous?: boolean;
}

/** Normalizes anything a rejected `invoke` may carry into an `AppError`. */
export function toAppError(raw: unknown): AppError {
  if (raw && typeof raw === 'object' && 'kind' in raw && 'message' in raw) {
    return raw as AppError;
  }
  const message = raw instanceof Error ? raw.message : String(raw ?? 'Unknown error');
  return { kind: 'other', message };
}

/** `AppError.kind` drives the user-facing copy. */
export function describeError(error: AppError): string {
  switch (error.kind) {
    case 'auth':
      return `Credentials expired — refresh them (e.g. \`aws sso login\`) and retry. ${error.message}`;
    case 'unauthorized':
      return `Not authenticated against the cluster. ${error.message}`;
    case 'forbidden':
      return `Your role cannot perform this operation. ${error.message}`;
    case 'network':
      return `Cluster unreachable — are you on the VPN? ${error.message}`;
    case 'config':
      return `Kubeconfig problem: ${error.message}`;
    case 'not_found':
      return `Not found: ${error.message}`;
    default:
      return error.message;
  }
}
