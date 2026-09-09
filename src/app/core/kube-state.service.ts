import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { KubeBackend, appError } from './kube-backend';
import { LogsService } from './logs.service';
import { PrefsService } from './prefs.service';
import { ToastService } from './toast.service';
import { isProductionContext } from './format';
import {
  AppError,
  EnvironmentInfo,
  KubeContext,
  NamespaceError,
  PodSummary,
  WorkloadSummary,
  toAppError,
} from './models';

export type NamespaceMode = 'discovered' | 'manual';

/** `pods: null` — the namespace was already known, or was added without a successful probe. */
export type AddNamespaceResult = { ok: true; pods: number | null } | { ok: false; error: AppError };

/** An exec auth plugin can still be warming up when the first probe fires. */
const PROBE_RETRY_DELAY_MS = 800;

@Injectable({ providedIn: 'root' })
export class KubeStateService {
  readonly #backend = inject(KubeBackend);
  readonly #prefs = inject(PrefsService);
  readonly #toasts = inject(ToastService);
  readonly #logs = inject(LogsService);

  readonly #$kubeconfigPaths = signal<string[]>([]);
  readonly #$contexts = signal<KubeContext[]>([]);
  readonly #$context = signal<string | null>(null);
  readonly #$namespaceMode = signal<NamespaceMode>('discovered');
  readonly #$namespaceNotice = signal<AppError | null>(null);
  readonly #$knownNamespaces = signal<string[]>([]);
  readonly #$discoveredNamespaces = signal<string[]>([]);
  readonly #$manualNamespaces = signal<string[]>([]);
  readonly #$enabledNamespaces = signal<string[]>([]);
  readonly #$pods = signal<PodSummary[]>([]);
  readonly #$workloads = signal<WorkloadSummary[]>([]);
  readonly #$namespaceErrors = signal<NamespaceError[]>([]);
  readonly #$fetchedAt = signal<string | null>(null);
  readonly #$loading = signal(false);
  readonly #$error = signal<AppError | null>(null);
  readonly #$environment = signal<EnvironmentInfo | null>(null);

  /** Guards against a late response from a context the user already left. */
  #requestToken = 0;

  readonly isDemo = this.#backend.isDemo;

  readonly $contexts = this.#$contexts.asReadonly();
  readonly $kubeconfigPaths = this.#$kubeconfigPaths.asReadonly();
  readonly $context = this.#$context.asReadonly();
  readonly $contextInfo = computed(
    () => this.$contexts().find((context) => context.name === this.$context()) ?? null,
  );
  readonly $isProduction = computed(() => isProductionContext(this.$context()));
  readonly $namespaceMode = this.#$namespaceMode.asReadonly();
  readonly $namespaceNotice = this.#$namespaceNotice.asReadonly();
  /** Every namespace the user keeps for this context, enabled or not. */
  readonly $knownNamespaces = this.#$knownNamespaces.asReadonly();
  readonly $discoveredNamespaces = this.#$discoveredNamespaces.asReadonly();
  readonly $manualNamespaces = this.#$manualNamespaces.asReadonly();
  /** The subset used as the list filter. */
  readonly $enabledNamespaces = this.#$enabledNamespaces.asReadonly();
  readonly $pods = this.#$pods.asReadonly();
  readonly $workloads = this.#$workloads.asReadonly();
  readonly $namespaceErrors = this.#$namespaceErrors.asReadonly();
  readonly $fetchedAt = this.#$fetchedAt.asReadonly();
  readonly $loading = this.#$loading.asReadonly();
  readonly $error = this.#$error.asReadonly();
  readonly $environment = this.#$environment.asReadonly();

  readonly $autoPoll = this.#prefs.$autoPoll;
  readonly $pollIntervalMs = this.#prefs.$pollIntervalMs;

  readonly #$enabledSet = computed(() => new Set(this.$enabledNamespaces()));
  readonly #$manualSet = computed(() => new Set(this.$manualNamespaces()));
  readonly #$discoveredSet = computed(() => new Set(this.$discoveredNamespaces()));

  constructor() {
    effect((onCleanup) => {
      const enabled = this.#prefs.$autoPoll();
      const interval = this.#prefs.$pollIntervalMs();
      const context = this.$context();
      const namespaces = this.$enabledNamespaces();
      if (!enabled || !context || namespaces.length === 0) {
        return;
      }
      const timer = setInterval(() => void this.refresh(), interval);
      onCleanup(() => clearInterval(timer));
    });
  }

  async init(): Promise<void> {
    await this.reloadContexts();
    void this.loadEnvironment();
  }

  async reloadContexts(): Promise<void> {
    try {
      const info = await this.#backend.listContexts();
      this.#$contexts.set(info.contexts);
      this.#$kubeconfigPaths.set(info.paths);
      const wanted = this.#prefs.$context();
      const chosen =
        info.contexts.find((context) => context.name === wanted) ??
        info.contexts.find((context) => context.isCurrent) ??
        info.contexts[0];
      if (chosen) {
        await this.selectContext(chosen.name);
      }
    } catch (raw) {
      const error = toAppError(raw);
      this.#$error.set(error);
      this.#toasts.failure('Cannot read the kubeconfig', error);
    }
  }

  async loadEnvironment(): Promise<void> {
    try {
      this.#$environment.set(await this.#backend.environmentInfo());
    } catch {
      this.#$environment.set(null);
    }
  }

  async selectContext(name: string): Promise<void> {
    if (this.$context() === name) {
      return;
    }
    await this.#logs.reset();
    this.#$context.set(name);
    this.#prefs.patch({ context: name });
    this.#$pods.set([]);
    this.#$workloads.set([]);
    this.#$namespaceErrors.set([]);
    this.#$fetchedAt.set(null);
    this.#$error.set(null);
    await this.#loadNamespaces(name);
    await this.refresh();
  }

  isNamespaceEnabled(namespace: string): boolean {
    return this.#$enabledSet().has(namespace);
  }

  /** Only namespaces typed by hand can leave the known list; discovered ones come back anyway. */
  isNamespaceRemovable(namespace: string): boolean {
    return this.#$manualSet().has(namespace);
  }

  /** False for the context default, which is kept even when `list_namespaces` is forbidden. */
  isNamespaceDiscovered(namespace: string): boolean {
    return this.#$discoveredSet().has(namespace);
  }

  /** Chips and the manage popover toggle the filter — they never touch the known list. */
  toggleNamespaceEnabled(namespace: string): void {
    const enabled = this.$enabledNamespaces();
    this.#setEnabled(
      enabled.includes(namespace)
        ? enabled.filter((item) => item !== namespace)
        : [...enabled, namespace].sort(),
    );
    void this.refresh();
  }

  setAllNamespacesEnabled(enabled: boolean): void {
    this.#setEnabled(enabled ? [...this.$knownNamespaces()] : []);
    void this.refresh();
  }

  /** Validates with `probe_namespace` (one retry) before the namespace joins the known list. */
  async addNamespace(namespace: string): Promise<AddNamespaceResult> {
    const context = this.$context();
    const clean = namespace.trim();
    if (!context || !clean) {
      return { ok: false, error: appError('config', 'Pick a context and type a namespace name.') };
    }
    if (this.$knownNamespaces().includes(clean)) {
      this.#enable(clean);
      return { ok: true, pods: null };
    }
    try {
      const pods = await this.#probe(context, clean);
      this.#remember(context, clean);
      this.#enable(clean);
      this.#toasts.success(
        `Namespace ${clean} added`,
        pods === 0 ? '0 pods right now' : `${pods} pods readable`,
      );
      return { ok: true, pods };
    } catch (raw) {
      const error = toAppError(raw);
      this.#toasts.error(`Cannot read namespace ${clean}`, probeFailureDetail(error), {
        label: 'Add anyway',
        run: () => this.addNamespaceUnvalidated(clean),
      });
      return { ok: false, error };
    }
  }

  /** Escape hatch after a failed probe: the per-namespace error then tells the truth on refresh. */
  addNamespaceUnvalidated(namespace: string): void {
    const context = this.$context();
    const clean = namespace.trim();
    if (!context || !clean) {
      return;
    }
    this.#remember(context, clean);
    this.#enable(clean);
    this.#toasts.info(
      `Namespace ${clean} added unvalidated`,
      'Any read error for it shows up in the status bar on the next refresh.',
    );
  }

  removeKnownNamespace(namespace: string): void {
    const context = this.$context();
    if (!context || !this.isNamespaceRemovable(namespace)) {
      return;
    }
    const known = this.$knownNamespaces().filter((item) => item !== namespace);
    const manual = this.$manualNamespaces().filter((item) => item !== namespace);
    this.#$knownNamespaces.set(known);
    this.#$manualNamespaces.set(manual);
    this.#prefs.setKnownNamespaces(context, known);
    this.#prefs.setManualNamespaces(context, manual);
    this.#setEnabled(this.$enabledNamespaces().filter((item) => item !== namespace));
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const context = this.$context();
    const namespaces = this.$enabledNamespaces();
    if (!context) {
      return;
    }
    if (namespaces.length === 0) {
      this.#$pods.set([]);
      this.#$workloads.set([]);
      this.#$namespaceErrors.set([]);
      return;
    }
    const token = ++this.#requestToken;
    this.#$loading.set(true);
    try {
      const [pods, workloads] = await Promise.all([
        this.#backend.listPods(context, namespaces),
        this.#backend.listWorkloads(context, namespaces),
      ]);
      if (token !== this.#requestToken) {
        return;
      }
      this.#$pods.set(pods.pods);
      this.#$workloads.set(workloads.workloads);
      this.#$namespaceErrors.set(mergeErrors(pods.errors, workloads.errors));
      this.#$fetchedAt.set(pods.fetchedAt);
      this.#$error.set(null);
      // Workload log groups follow the fresh pod list: new replicas in, vanished ones marked gone.
      this.#logs.reconcileGroups(context, pods.pods);
    } catch (raw) {
      if (token !== this.#requestToken) {
        return;
      }
      const error = toAppError(raw);
      this.#$error.set(error);
      this.#toasts.failure('Could not list the cluster', error);
    } finally {
      if (token === this.#requestToken) {
        this.#$loading.set(false);
      }
    }
  }

  async deletePod(pod: PodSummary): Promise<void> {
    const context = this.$context();
    if (!context) {
      return;
    }
    try {
      await this.#backend.deletePod(context, pod.namespace, pod.name);
      this.#toasts.success(`Deleted ${pod.name}`, `${context}/${pod.namespace}`);
      await this.refresh();
    } catch (raw) {
      this.#toasts.failure(`Cannot delete ${pod.name}`, toAppError(raw));
    }
  }

  async restartWorkload(workload: WorkloadSummary): Promise<void> {
    const context = this.$context();
    if (!context) {
      return;
    }
    try {
      await this.#backend.restartWorkload(
        context,
        workload.namespace,
        workload.kind,
        workload.name,
      );
      this.#toasts.success(
        `Rollout restarted ${workload.kind.toLowerCase()}/${workload.name}`,
        `${context}/${workload.namespace}`,
      );
      await this.refresh();
    } catch (raw) {
      this.#toasts.failure(`Cannot restart ${workload.name}`, toAppError(raw));
    }
  }

  setAutoPoll(autoPoll: boolean): void {
    this.#prefs.patch({ autoPoll });
  }

  setPollInterval(pollIntervalMs: number): void {
    this.#prefs.patch({ pollIntervalMs });
  }

  /** A `forbidden` is a real answer; anything else gets one retry before the user sees an error. */
  async #probe(context: string, namespace: string): Promise<number> {
    try {
      return await this.#backend.probeNamespace(context, namespace);
    } catch (raw) {
      const error = toAppError(raw);
      if (error.kind === 'forbidden') {
        throw error;
      }
      await delay(PROBE_RETRY_DELAY_MS);
      return this.#backend.probeNamespace(context, namespace);
    }
  }

  async #loadNamespaces(context: string): Promise<void> {
    const fallback = this.$contextInfo()?.namespace ?? 'default';
    let discovered: string[] = [];
    try {
      discovered = await this.#backend.listNamespaces(context);
      this.#$namespaceMode.set('discovered');
      this.#$namespaceNotice.set(null);
    } catch (raw) {
      this.#$namespaceMode.set('manual');
      this.#$namespaceNotice.set(toAppError(raw));
    }

    const manual = this.#prefs.manualNamespacesFor(context);
    const known = unique([
      ...discovered,
      ...this.#prefs.knownNamespacesFor(context),
      ...manual,
      // Without a listing the context default is the one namespace we can assume.
      ...(discovered.length === 0 ? [fallback] : []),
    ]).sort();
    this.#$discoveredNamespaces.set(discovered);
    this.#$manualNamespaces.set(manual.filter((item) => !discovered.includes(item)));
    this.#$knownNamespaces.set(known);
    this.#prefs.setKnownNamespaces(context, known);

    const persisted = this.#prefs
      .enabledNamespacesFor(context)
      .filter((item) => known.includes(item));
    this.#setEnabled(
      persisted.length ? persisted : known.includes(fallback) ? [fallback] : known.slice(0, 1),
    );
  }

  #remember(context: string, namespace: string): void {
    const known = unique([...this.$knownNamespaces(), namespace]).sort();
    const manual = unique([...this.$manualNamespaces(), namespace]).sort();
    this.#$knownNamespaces.set(known);
    this.#$manualNamespaces.set(manual);
    this.#prefs.setKnownNamespaces(context, known);
    this.#prefs.setManualNamespaces(context, manual);
  }

  #enable(namespace: string): void {
    if (this.isNamespaceEnabled(namespace)) {
      return;
    }
    this.#setEnabled([...this.$enabledNamespaces(), namespace].sort());
    void this.refresh();
  }

  #setEnabled(namespaces: string[]): void {
    this.#$enabledNamespaces.set(namespaces);
    const context = this.$context();
    if (context) {
      this.#prefs.setEnabledNamespaces(context, namespaces);
    }
  }
}

function mergeErrors(...groups: NamespaceError[][]): NamespaceError[] {
  const seen = new Map<string, NamespaceError>();
  for (const group of groups) {
    for (const error of group) {
      seen.set(`${error.namespace}/${error.error.message}`, error);
    }
  }
  return [...seen.values()];
}

/** The toast shows the backend verbatim — kind, status and message — not a rewritten hint. */
function probeFailureDetail(error: AppError): string {
  const status = error.status ? ` ${error.status}` : '';
  // A `forbidden` is answered on the first call; only the other kinds got a second chance.
  const retried = error.kind === 'forbidden' ? '' : ' (retried once)';
  return `${error.kind}${status} — ${error.message}${retried}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function delay(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}
