import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import { KubeBackend, appError } from './kube-backend';
import { LOG_LEVEL_KEYS, LogLevelKey, PrefsService } from './prefs.service';
import { ToastService } from './toast.service';
import { podColor } from './format';
import {
  AppError,
  LogBatch,
  LogStreamEnd,
  PodSummary,
  WorkloadKind,
  WorkloadSummary,
  describeError,
  toAppError,
} from './models';

export type SourceStatus = 'starting' | 'live' | 'stopped' | 'gone' | 'error';

export interface LogSource {
  /** `context/namespace/pod/container` */
  id: string;
  context: string;
  namespace: string;
  pod: string;
  container: string;
  streamId: string | null;
  status: SourceStatus;
  error?: AppError;
  color: string;
  /** Set when the source was attached by a workload group instead of pod by pod. */
  groupId?: string;
}

/**
 * A whole workload followed as one source: every pod matching its selector streams, and pods that
 * appear later are attached on the next pod refresh (see `reconcileGroups`).
 */
export interface LogSourceGroup {
  /** `context/namespace/kind/name` */
  id: string;
  context: string;
  namespace: string;
  kind: WorkloadKind;
  name: string;
  selector: Record<string, string>;
  /** Pods removed by hand from the picker: the group must not re-attach them. */
  excluded: string[];
}

/** Detected once per line, on the way into the buffer. `null` is "no recognisable level". */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'marker' | null;

export interface LogEntry {
  seq: number;
  ts: number;
  timestamp?: string;
  text: string;
  sourceId: string;
  pod: string;
  namespace: string;
  color: string;
  level: LogLevel;
}

export const LOG_BUFFER_CAP = 20000;
const FLUSH_MS = 100;

/** Stack-trace and multi-line continuations: they carry the level of the line they belong to. */
const CONTINUATION_PATTERN = /^[ \t]+(at\s|\.\.\.\s|Caused by:|Suppressed:)/;
const JSON_LEVEL_PATTERN = /"(?:level|severity|log\.level)"\s*:\s*"([a-zA-Z]+)"/;
const KV_LEVEL_PATTERN = /\blevel\s*[=:]\s*"?([a-zA-Z]+)"?/i;
/** Java/Spring and friends print the level in caps, anywhere on the line. */
const UPPER_LEVEL_PATTERN = /\b(FATAL|SEVERE|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\b/;
/** Lower/mixed case only near the head of the line — "error" mid-sentence is prose, not a level. */
const LOWER_LEVEL_PATTERN = /\b(fatal|severe|error|warning|warn|info|debug|trace)\b/i;
const LEVEL_PREFIX_CHARS = 48;
/** No level token, but unmistakably a failure. */
const FAULT_PATTERN = /Exception|Traceback|\bpanic:/;

@Injectable({ providedIn: 'root' })
export class LogsService {
  readonly #backend = inject(KubeBackend);
  readonly #prefs = inject(PrefsService);
  readonly #toasts = inject(ToastService);

  readonly #$sources = signal<LogSource[]>([]);
  readonly #$groups = signal<LogSourceGroup[]>([]);
  readonly #$lines = signal<LogEntry[]>([]);
  readonly #$filter = signal('');
  readonly #$follow = signal(true);

  readonly $sources = this.#$sources.asReadonly();
  readonly $groups = this.#$groups.asReadonly();
  readonly $lines = this.#$lines.asReadonly();
  readonly $filter = this.#$filter.asReadonly();
  readonly $follow = this.#$follow.asReadonly();

  readonly #$sourceIds = computed(() => new Set(this.$sources().map((source) => source.id)));
  readonly #$groupIds = computed(() => new Set(this.$groups().map((group) => group.id)));

  readonly $activeCount = computed(
    () =>
      this.$sources().filter((source) => source.status === 'live' || source.status === 'starting')
        .length,
  );
  readonly $namespaceCount = computed(
    () => new Set(this.$sources().map((source) => source.namespace)).size,
  );

  /** Distinct pods streaming, whatever the container count: what decides if lines need a badge. */
  readonly $podCount = computed(() => new Set(this.$sources().map((source) => source.pod)).size);

  /** Text filter only — the level chips are applied on top of it, and count against it. */
  readonly #$textMatched = computed<LogEntry[]>(() => {
    const lines = this.$lines();
    const matcher = buildMatcher(this.$filter());
    return matcher ? lines.filter((line) => matcher(line.text)) : lines.slice();
  });

  /** Chip counts ignore the level filter itself, so toggling a chip never moves the numbers. */
  readonly $levelCounts = computed<Record<LogLevelKey, number>>(() => {
    const counts: Record<LogLevelKey, number> = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
    for (const line of this.#$textMatched()) {
      if (line.level !== 'marker') {
        counts[levelKey(line.level)] += 1;
      }
    }
    return counts;
  });

  readonly $filtered = computed<LogEntry[]>(() => {
    const lines = this.#$textMatched();
    const enabled = this.#prefs.$logLevels();
    if (enabled.length === LOG_LEVEL_KEYS.length) {
      return lines;
    }
    const allowed = new Set(enabled);
    // Stream markers ("pod gone", "stream ended") are not log lines: no chip may hide them.
    return lines.filter((line) => line.level === 'marker' || allowed.has(levelKey(line.level)));
  });

  /** streamId → source id */
  readonly #streams = new Map<string, string>();
  #pending: LogEntry[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #sequence = 0;
  #lastTs = new Map<string, number>();
  /** Per stream, the level of the last levelled line — what a continuation line inherits. */
  #lastLevel = new Map<string, LogLevel>();

  constructor() {
    const listeners = [
      this.#backend.onLogBatch((batch) => this.#onBatch(batch)),
      this.#backend.onLogEnd((end) => this.#onEnd(end)),
    ];
    // A scoped instance (the pod drawer) is destroyed with its component: drop the event
    // listeners and stop the streams it owns, leaving every other scope alone.
    inject(DestroyRef).onDestroy(() => {
      for (const listener of listeners) {
        void listener.then((unlisten) => unlisten());
      }
      void this.disposeScope();
    });
  }

  setFilter(filter: string): void {
    this.#$filter.set(filter);
  }

  setFollow(follow: boolean): void {
    this.#$follow.set(follow);
  }

  async addSource(
    context: string,
    namespace: string,
    pod: string,
    container?: string,
  ): Promise<void> {
    await this.#add(context, namespace, pod, container);
  }

  async addSources(
    context: string,
    pods: { namespace: string; name: string; container?: string }[],
  ): Promise<void> {
    for (const pod of pods) {
      await this.#add(context, pod.namespace, pod.name, pod.container);
    }
  }

  /** No container named on a multi-container pod means all of them, one stream each. */
  async addPod(context: string, pod: PodSummary, container?: string): Promise<void> {
    await this.#addPod(context, pod, container);
  }

  async removePod(context: string, pod: PodSummary, container?: string): Promise<void> {
    for (const id of this.#idsOf(context, pod, container)) {
      if (this.#$sourceIds().has(id)) {
        await this.removeSource(id);
      }
    }
  }

  tracksContainer(context: string, pod: PodSummary, container?: string): boolean {
    return this.#$sourceIds().has(sourceId(context, pod.namespace, pod.name, container));
  }

  /** Either the default stream, or one per container of a multi-container pod. */
  tracksPod(context: string, pod: PodSummary): boolean {
    return (
      this.tracksContainer(context, pod) ||
      (pod.containers.length > 0 &&
        pod.containers.every((container) => this.tracksContainer(context, pod, container.name)))
    );
  }

  tracksWorkload(context: string, workload: WorkloadSummary): boolean {
    return this.#$groupIds().has(groupId(context, workload));
  }

  /** Adds the workload as a group: its current pods now, the ones that show up later on refresh. */
  async addWorkload(context: string, workload: WorkloadSummary, pods: PodSummary[]): Promise<void> {
    const id = groupId(context, workload);
    const group: LogSourceGroup = {
      id,
      context,
      namespace: workload.namespace,
      kind: workload.kind,
      name: workload.name,
      selector: workload.selector,
      excluded: [],
    };
    // Re-adding a group forgets the pods that had been removed one by one.
    this.#$groups.update((groups) => [...groups.filter((item) => item.id !== id), group]);
    for (const pod of matchingPods(group, pods)) {
      await this.#addPod(context, pod, undefined, id);
    }
  }

  async removeWorkload(context: string, workload: WorkloadSummary): Promise<void> {
    await this.removeGroup(groupId(context, workload));
  }

  async removeGroup(id: string): Promise<void> {
    this.#$groups.update((groups) => groups.filter((group) => group.id !== id));
    for (const source of this.$sources().filter((source) => source.groupId === id)) {
      await this.removeSource(source.id);
    }
  }

  /**
   * Called after every pod refresh: each tracked workload picks up its new pods, and the sources
   * of pods that no longer match are marked gone (a StatefulSet replica coming back is restarted).
   */
  reconcileGroups(context: string, pods: PodSummary[]): void {
    const groups = this.$groups().filter((group) => group.context === context);
    if (groups.length === 0) {
      return;
    }
    const sources = this.$sources();
    for (const group of groups) {
      const matching = matchingPods(group, pods);
      const alive = new Set(matching.map((pod) => pod.name));
      for (const pod of matching) {
        if (!this.tracksPod(context, pod)) {
          void this.#addPod(context, pod, undefined, group.id);
          continue;
        }
        for (const source of sources) {
          if (source.groupId === group.id && source.pod === pod.name && source.status === 'gone') {
            void this.restartSource(source.id);
          }
        }
      }
      for (const source of sources) {
        if (source.groupId === group.id && !alive.has(source.pod)) {
          void this.#markGone(source);
        }
      }
    }
  }

  async stopSource(id: string): Promise<void> {
    const source = this.$sources().find((item) => item.id === id);
    if (!source) {
      return;
    }
    if (source.streamId) {
      this.#streams.delete(source.streamId);
      try {
        await this.#backend.stopLogStream(source.streamId);
      } catch {
        // The stream may already be gone on the backend side.
      }
    }
    this.#patch(id, { status: 'stopped', streamId: null });
  }

  async removeSource(id: string): Promise<void> {
    const source = this.$sources().find((item) => item.id === id);
    await this.stopSource(id);
    this.#$sources.update((sources) => sources.filter((item) => item.id !== id));
    this.#$lines.update((lines) => lines.filter((line) => line.sourceId !== id));
    if (source?.groupId) {
      this.#exclude(source.groupId, source.pod);
    }
  }

  async restartSource(id: string): Promise<void> {
    const source = this.$sources().find((item) => item.id === id);
    if (!source) {
      return;
    }
    await this.stopSource(id);
    this.#patch(id, { status: 'starting', error: undefined });
    await this.#start({ ...source, status: 'starting' });
  }

  /** Tail size / "since" only take effect on a (re)start. */
  async restartAll(): Promise<void> {
    for (const source of this.$sources()) {
      await this.restartSource(source.id);
    }
  }

  async stopAll(): Promise<void> {
    for (const source of this.$sources()) {
      if (source.streamId) {
        this.#streams.delete(source.streamId);
      }
    }
    try {
      await this.#backend.stopAllLogStreams();
    } catch {
      // Nothing to stop.
    }
    this.#$sources.update((sources) =>
      sources.map((source) => ({ ...source, status: 'stopped' as SourceStatus, streamId: null })),
    );
  }

  clear(): void {
    this.#pending = [];
    this.#$lines.set([]);
  }

  /** Context switch: no source, group or line from the previous cluster survives. */
  async reset(): Promise<void> {
    await this.stopAll();
    this.#$sources.set([]);
    this.#$groups.set([]);
    this.clear();
  }

  /**
   * Same as `reset`, but stopping stream by stream instead of asking the backend to stop every
   * stream it holds — the only safe teardown for an instance that shares the backend with others.
   */
  async disposeScope(): Promise<void> {
    for (const source of this.$sources()) {
      await this.stopSource(source.id);
    }
    this.#$sources.set([]);
    this.#$groups.set([]);
    this.clear();
  }

  /** Whole buffer as plain text, for the download button. */
  toText(): string {
    return this.$filtered()
      .map((line) =>
        [line.timestamp ?? '', `${line.namespace}/${line.pod}`, line.text]
          .filter(Boolean)
          .join(' '),
      )
      .join('\n');
  }

  async #add(
    context: string,
    namespace: string,
    pod: string,
    container: string | undefined,
    groupId?: string,
  ): Promise<void> {
    const id = sourceId(context, namespace, pod, container);
    if (this.#$sourceIds().has(id)) {
      return;
    }
    const source: LogSource = {
      id,
      context,
      namespace,
      pod,
      container: container ?? '',
      streamId: null,
      status: 'starting',
      color: podColor(pod),
      groupId,
    };
    this.#$sources.update((sources) => [...sources, source]);
    await this.#start(source);
  }

  async #addPod(
    context: string,
    pod: PodSummary,
    container: string | undefined,
    groupId?: string,
  ): Promise<void> {
    if (container) {
      await this.#add(context, pod.namespace, pod.name, container, groupId);
      return;
    }
    if (pod.containers.length > 1) {
      for (const item of pod.containers) {
        await this.#add(context, pod.namespace, pod.name, item.name, groupId);
      }
      return;
    }
    await this.#add(context, pod.namespace, pod.name, undefined, groupId);
  }

  #idsOf(context: string, pod: PodSummary, container?: string): string[] {
    if (container) {
      return [sourceId(context, pod.namespace, pod.name, container)];
    }
    return [
      sourceId(context, pod.namespace, pod.name),
      ...pod.containers.map((item) => sourceId(context, pod.namespace, pod.name, item.name)),
    ];
  }

  #exclude(groupId: string, pod: string): void {
    this.#$groups.update((groups) =>
      groups.map((group) =>
        group.id === groupId && !group.excluded.includes(pod)
          ? { ...group, excluded: [...group.excluded, pod] }
          : group,
      ),
    );
  }

  /** Same treatment as a `not_found` stream end: the source stays, marked, ready to restart. */
  async #markGone(source: LogSource): Promise<void> {
    if (source.status === 'gone') {
      return;
    }
    if (source.streamId) {
      this.#streams.delete(source.streamId);
      try {
        await this.#backend.stopLogStream(source.streamId);
      } catch {
        // The kubelet may have closed it already.
      }
    }
    this.#patch(source.id, {
      status: 'gone',
      streamId: null,
      error: appError('not_found', `pods "${source.pod}" is no longer part of the workload`, 404),
    });
    this.#marker(source, `pod gone — ${source.pod} left the workload`);
  }

  async #start(source: LogSource): Promise<void> {
    try {
      const handle = await this.#backend.startLogStream({
        context: source.context,
        namespace: source.namespace,
        pod: source.pod,
        container: source.container || undefined,
        tailLines: this.#prefs.$tailLines(),
        sinceSeconds: this.#prefs.$sinceSeconds() ?? undefined,
        follow: true,
      });
      this.#streams.set(handle.streamId, source.id);
      this.#patch(source.id, {
        streamId: handle.streamId,
        container: handle.container,
        status: 'live',
      });
    } catch (raw) {
      const error = toAppError(raw);
      this.#patch(source.id, { status: 'error', error, streamId: null });
      this.#toasts.failure(`Cannot tail ${source.pod}`, error);
    }
  }

  #patch(id: string, patch: Partial<LogSource>): void {
    this.#$sources.update((sources) =>
      sources.map((source) => (source.id === id ? { ...source, ...patch } : source)),
    );
  }

  #onBatch(batch: LogBatch): void {
    const sourceId = this.#streams.get(batch.streamId);
    if (!sourceId) {
      return;
    }
    const source = this.$sources().find((item) => item.id === sourceId);
    if (!source) {
      return;
    }
    let previous = this.#lastTs.get(batch.streamId) ?? Date.now();
    let previousLevel = this.#lastLevel.get(batch.streamId) ?? null;
    for (const line of batch.lines) {
      const parsed = line.timestamp ? Date.parse(line.timestamp) : NaN;
      // Lines without a kubelet timestamp (or with a broken one) inherit the previous line's.
      const ts = Number.isNaN(parsed) ? previous : parsed;
      previous = ts;
      const level = detectLevel(line.text, previousLevel);
      previousLevel = level;
      this.#pending.push({
        seq: ++this.#sequence,
        ts,
        timestamp: line.timestamp,
        text: line.text,
        sourceId,
        pod: source.pod,
        namespace: source.namespace,
        color: source.color,
        level,
      });
    }
    this.#lastTs.set(batch.streamId, previous);
    this.#lastLevel.set(batch.streamId, previousLevel);
    this.#scheduleFlush();
  }

  #onEnd(end: LogStreamEnd): void {
    const sourceId = this.#streams.get(end.streamId);
    if (!sourceId) {
      return;
    }
    this.#streams.delete(end.streamId);
    const source = this.$sources().find((item) => item.id === sourceId);
    if (!source) {
      return;
    }
    if (end.error) {
      const gone = end.error.kind === 'not_found';
      this.#patch(sourceId, { status: gone ? 'gone' : 'error', error: end.error, streamId: null });
      this.#marker(
        source,
        gone
          ? `pod gone — ${source.pod} no longer exists, restart the source once it is back`
          : `stream ended — ${describeError(end.error)}`,
      );
    } else {
      this.#patch(sourceId, { status: 'stopped', streamId: null });
      this.#marker(source, `stream ended — ${source.pod}`);
    }
  }

  #marker(source: LogSource, text: string): void {
    this.#pending.push({
      seq: ++this.#sequence,
      ts: Date.now(),
      text: `── ${text} ──`,
      sourceId: source.id,
      pod: source.pod,
      namespace: source.namespace,
      color: source.color,
      level: 'marker',
    });
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) {
      return;
    }
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flush();
    }, FLUSH_MS);
  }

  /** One merge per flush: batches from several streams are coalesced first. */
  #flush(): void {
    if (this.#pending.length === 0) {
      return;
    }
    const incoming = this.#pending;
    this.#pending = [];
    incoming.sort((left, right) => left.ts - right.ts || left.seq - right.seq);
    this.#$lines.update((lines) => {
      const merged = mergeByTimestamp(lines, incoming);
      return merged.length > LOG_BUFFER_CAP ? merged.slice(merged.length - LOG_BUFFER_CAP) : merged;
    });
  }
}

export function groupId(
  context: string,
  workload: { namespace: string; kind: WorkloadKind; name: string },
): string {
  return `${context}/${workload.namespace}/${workload.kind}/${workload.name}`;
}

/** Selector labels resolve a workload's pods from the list already in memory. */
export function matchingPods(group: LogSourceGroup, pods: PodSummary[]): PodSummary[] {
  const selector = Object.entries(group.selector);
  return pods.filter(
    (pod) =>
      pod.namespace === group.namespace &&
      !group.excluded.includes(pod.name) &&
      selector.every(([key, value]) => pod.labels[key] === value),
  );
}

export function sourceId(
  context: string,
  namespace: string,
  pod: string,
  container?: string,
): string {
  return `${context}/${namespace}/${pod}/${container ?? ''}`;
}

/** `/pattern/flags` is a regex filter, anything else a case-insensitive substring. */
export function buildMatcher(filter: string): ((text: string) => boolean) | null {
  const clean = filter.trim();
  if (!clean) {
    return null;
  }
  const regex = /^\/(.+)\/([gimsuy]*)$/.exec(clean);
  if (regex) {
    try {
      const compiled = new RegExp(regex[1], regex[2].replace('g', ''));
      return (text) => compiled.test(text);
    } catch {
      return () => true;
    }
  }
  const needle = clean.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

/** Which chip a line answers to. Markers are exempt from the level filter and never reach here. */
export function levelKey(level: LogLevel): LogLevelKey {
  return level === null || level === 'marker' ? 'other' : level;
}

/**
 * Level of one line, given the level of the line before it on the same stream. Order matters:
 * an explicit token always beats the `Exception` heuristic, and a continuation line beats both.
 */
export function detectLevel(text: string, previous: LogLevel): LogLevel {
  if (CONTINUATION_PATTERN.test(text)) {
    return previous;
  }
  const tagged = JSON_LEVEL_PATTERN.exec(text) ?? KV_LEVEL_PATTERN.exec(text);
  const fromTag = tagged ? levelFromToken(tagged[1]) : null;
  if (fromTag) {
    return fromTag;
  }
  const upper = UPPER_LEVEL_PATTERN.exec(text);
  if (upper) {
    return levelFromToken(upper[1]);
  }
  const lower = LOWER_LEVEL_PATTERN.exec(text.slice(0, LEVEL_PREFIX_CHARS));
  if (lower) {
    return levelFromToken(lower[1]);
  }
  return FAULT_PATTERN.test(text) ? 'error' : null;
}

function levelFromToken(token: string): LogLevel {
  switch (token.toLowerCase()) {
    case 'fatal':
    case 'severe':
    case 'error':
      return 'error';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'info':
      return 'info';
    // TRACE shares the DEBUG chip: both are the same kind of noise to filter out.
    case 'debug':
    case 'trace':
      return 'debug';
    default:
      return null;
  }
}

function mergeByTimestamp(left: LogEntry[], right: LogEntry[]): LogEntry[] {
  const out = new Array<LogEntry>(left.length + right.length);
  let a = 0;
  let b = 0;
  let index = 0;
  while (a < left.length && b < right.length) {
    out[index++] = left[a].ts <= right[b].ts ? left[a++] : right[b++];
  }
  while (a < left.length) {
    out[index++] = left[a++];
  }
  while (b < right.length) {
    out[index++] = right[b++];
  }
  return out;
}
