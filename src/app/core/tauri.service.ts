import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { KubeBackend, Unlisten } from './kube-backend';
import {
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
  toAppError,
} from './models';

/** Typed wrappers over the Rust commands; rejections are normalized to `AppError`. */
@Injectable()
export class TauriBackend extends KubeBackend {
  readonly isDemo = false;

  environmentInfo(): Promise<EnvironmentInfo> {
    return this.#call('environment_info');
  }

  listContexts(): Promise<KubeconfigInfo> {
    return this.#call('list_contexts');
  }

  listNamespaces(context: string): Promise<string[]> {
    return this.#call('list_namespaces', { context });
  }

  probeNamespace(context: string, namespace: string): Promise<number> {
    return this.#call('probe_namespace', { context, namespace });
  }

  listPods(context: string, namespaces: string[]): Promise<PodsResponse> {
    return this.#call('list_pods', { context, namespaces });
  }

  getPodDocument(context: string, namespace: string, name: string): Promise<ResourceDocument> {
    return this.#call('get_pod_document', { context, namespace, name });
  }

  deletePod(context: string, namespace: string, name: string): Promise<string> {
    return this.#call('delete_pod', { context, namespace, name });
  }

  listWorkloads(context: string, namespaces: string[]): Promise<WorkloadsResponse> {
    return this.#call('list_workloads', { context, namespaces });
  }

  getWorkloadDocument(
    context: string,
    namespace: string,
    kind: WorkloadKind,
    name: string,
  ): Promise<ResourceDocument> {
    return this.#call('get_workload_document', { context, namespace, kind, name });
  }

  restartWorkload(
    context: string,
    namespace: string,
    kind: WorkloadKind,
    name: string,
  ): Promise<string> {
    return this.#call('restart_workload', { context, namespace, kind, name });
  }

  startLogStream(request: LogStreamRequest): Promise<LogStreamHandle> {
    return this.#call('start_log_stream', { ...request });
  }

  stopLogStream(streamId: string): Promise<void> {
    return this.#call('stop_log_stream', { streamId });
  }

  stopAllLogStreams(): Promise<number> {
    return this.#call('stop_all_log_streams');
  }

  async onLogBatch(handler: (batch: LogBatch) => void): Promise<Unlisten> {
    return listen<LogBatch>('log-batch', (event) => handler(event.payload));
  }

  async onLogEnd(handler: (end: LogStreamEnd) => void): Promise<Unlisten> {
    return listen<LogStreamEnd>('log-end', (event) => handler(event.payload));
  }

  openDevtools(): Promise<void> {
    return this.#call('open_devtools');
  }

  async #call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return await invoke<T>(command, args);
    } catch (raw) {
      throw toAppError(raw);
    }
  }
}
