import {
  AppError,
  EnvironmentInfo,
  KubeconfigInfo,
  LogBatch,
  LogStreamEnd,
  LogStreamHandle,
  LogStreamRequest,
  PodsResponse,
  ResourceDocument,
  WorkloadKind,
  WorkloadsResponse,
} from './models';

export type Unlisten = () => void;

/**
 * Every backend call the UI makes. Implemented by `TauriBackend` inside the desktop window and by
 * `MockBackend` in a plain browser, so `pnpm dev` on :4200 is fully usable with demo data.
 */
export abstract class KubeBackend {
  /** True when serving fabricated data (drives the "Demo data" badge). */
  abstract readonly isDemo: boolean;

  abstract environmentInfo(): Promise<EnvironmentInfo>;
  abstract listContexts(): Promise<KubeconfigInfo>;
  /** May reject with `AppError.kind === 'forbidden'`. */
  abstract listNamespaces(context: string): Promise<string[]>;
  abstract probeNamespace(context: string, namespace: string): Promise<number>;

  abstract listPods(context: string, namespaces: string[]): Promise<PodsResponse>;
  abstract getPodDocument(
    context: string,
    namespace: string,
    name: string,
  ): Promise<ResourceDocument>;
  abstract deletePod(context: string, namespace: string, name: string): Promise<string>;

  abstract listWorkloads(context: string, namespaces: string[]): Promise<WorkloadsResponse>;
  abstract getWorkloadDocument(
    context: string,
    namespace: string,
    kind: WorkloadKind,
    name: string,
  ): Promise<ResourceDocument>;
  abstract restartWorkload(
    context: string,
    namespace: string,
    kind: WorkloadKind,
    name: string,
  ): Promise<string>;

  abstract startLogStream(request: LogStreamRequest): Promise<LogStreamHandle>;
  abstract stopLogStream(streamId: string): Promise<void>;
  abstract stopAllLogStreams(): Promise<number>;
  abstract onLogBatch(handler: (batch: LogBatch) => void): Promise<Unlisten>;
  abstract onLogEnd(handler: (end: LogStreamEnd) => void): Promise<Unlisten>;

  abstract openDevtools(): Promise<void>;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function appError(kind: AppError['kind'], message: string, status?: number): AppError {
  return { kind, message, status };
}
