/** Formatting helpers: kubectl-style ages, image references, log timestamps. */

export interface ImageRef {
  registry?: string;
  repo: string;
  tag: string;
  digest?: string;
  /** `repo:tag` — what the tables show. */
  short: string;
  full: string;
}

/** kubectl's `duration.HumanDuration`: 45s, 3m20s, 12m, 4h5m, 38h, 7d4h, 96d, 2y. */
export function formatAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) {
    return '-';
  }
  const started = Date.parse(iso);
  if (Number.isNaN(started)) {
    return '-';
  }
  return formatDuration(Math.max(0, Math.round((now - started) / 1000)));
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 120) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
  }
  if (minutes < 180) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 8) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
  }
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (hours < 24 * 8) {
    const rest = hours % 24;
    return rest === 0 ? `${days}d` : `${days}d${rest}h`;
  }
  if (days < 365 * 2) {
    return `${days}d`;
  }
  const years = Math.floor(days / 365);
  const restDays = days % 365;
  return restDays === 0 ? `${years}y` : `${years}y${restDays}d`;
}

/** Splits `registry/repo:tag@sha256:…` — the tag is the last `:` after the last `/`. */
export function parseImage(image: string): ImageRef {
  const full = image ?? '';
  let rest = full;
  let digest: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }

  let tag = digest ? '' : 'latest';
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.indexOf(':', lastSlash + 1);
  if (colon > -1) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }

  let registry: string | undefined;
  let repo = rest;
  if (lastSlash > -1) {
    const first = rest.slice(0, rest.indexOf('/'));
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      registry = first;
      repo = rest.slice(first.length + 1);
    }
  }

  const short = tag ? `${repo}:${tag}` : `${repo}@${(digest ?? '').slice(0, 19)}`;
  return { registry, repo, tag, digest, short, full };
}

/**
 * `api-external-qatar-feature-ob-69593-6cdf6d5455-tc48r` → `api-external-qatar-fe…5455-tc48r`:
 * the replica hash tells two pods of a workload apart, so the tail is what survives.
 */
export function middleEllipsis(value: string, maxLength = 32, tailLength = 10): string {
  const text = value ?? '';
  if (text.length <= maxLength || maxLength < 2) {
    return text;
  }
  const tail = Math.min(tailLength, maxLength - 1);
  return `${text.slice(0, maxLength - tail - 1)}…${text.slice(text.length - tail)}`;
}

/** `2026-09-08T09:14:02.481Z` → `09:14:02.481`. */
export function formatLogTime(timestamp: string | undefined): string {
  if (!timestamp) {
    return '';
  }
  const time = timestamp.slice(11, 23);
  return time.length >= 8 ? time : timestamp;
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) {
    return '-';
  }
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : new Date(parsed).toLocaleString();
}

/** Deterministic 32-bit hash — stable colours for pod badges. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const POD_COLORS = [
  '#3d73a8',
  '#2f8f6f',
  '#a1682b',
  '#8f5b9e',
  '#b2544a',
  '#3f7f4d',
  '#8f7c1f',
  '#4b6ea8',
  '#a04f78',
  '#2c8595',
];

export function podColor(pod: string): string {
  return POD_COLORS[hashString(pod) % POD_COLORS.length];
}

export type StatusTone = 'success' | 'warning' | 'error' | 'neutral' | 'info';

export function podStatusTone(pod: {
  status: string;
  phase: string;
  readyCount: number;
  totalCount: number;
  deletionTimestamp?: string;
}): StatusTone {
  const status = pod.status;
  if (pod.deletionTimestamp || status === 'Terminating') {
    return 'neutral';
  }
  if (
    /CrashLoopBackOff|Error|ImagePull|InvalidImageName|CreateContainerConfigError|OOMKilled|Evicted|Failed/i.test(
      status,
    )
  ) {
    return 'error';
  }
  if (status === 'Completed' || status === 'Succeeded') {
    return 'neutral';
  }
  if (status === 'Running' && pod.readyCount === pod.totalCount && pod.totalCount > 0) {
    return 'success';
  }
  if (/Pending|ContainerCreating|PodInitializing|Init:|NotReady|Unknown/i.test(status)) {
    return 'warning';
  }
  return 'info';
}

/** `pro`-like context names get the production treatment. */
export function isProductionContext(context: string | null | undefined): boolean {
  return !!context && /(^|[^a-z])(pro|prod|production|live)([^a-z]|$)/i.test(context);
}
