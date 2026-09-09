import { Injectable, computed, effect, signal } from '@angular/core';

export type ThemePref = 'light' | 'dark' | 'system';
export type ViewTab = 'pods' | 'workloads' | 'logs';
/** Buckets the log level chips filter on — `other` is every line with no recognisable level. */
export type LogLevelKey = 'error' | 'warn' | 'info' | 'debug' | 'other';

export interface Prefs {
  theme: ThemePref;
  view: ViewTab;
  context: string | null;
  /** Namespaces the user keeps per context: the discovered ones plus every manual addition. */
  knownNamespaces: Record<string, string[]>;
  /** Subset of the known list that was typed by hand — the only removable namespaces. */
  manualNamespaces: Record<string, string[]>;
  /** Namespaces used as the list filter, toggled independently of the known list. */
  enabledNamespaces: Record<string, string[]>;
  pollIntervalMs: number;
  autoPoll: boolean;
  tailLines: number;
  /** `null` = no `--since`, stream from the tail only. */
  sinceSeconds: number | null;
  wrap: boolean;
  timestamps: boolean;
  groupByWorkload: boolean;
  /** Levels currently shown in every log pane; an empty list hides every levelled line. */
  logLevels: LogLevelKey[];
  /** Details drawer width in px, clamped to the viewport when it is read. */
  drawerWidth: number;
  /** Dragged column widths in px, per table id then column key. Absent = the column's default. */
  columnWidths: Record<string, Record<string, number>>;
}

/** Shape written before namespaces were split into "known" and "enabled". */
interface LegacyPrefs {
  namespaces?: Record<string, string[]>;
}

export const LOG_LEVEL_KEYS: LogLevelKey[] = ['error', 'warn', 'info', 'debug', 'other'];
export const DRAWER_WIDTH = { default: 620, min: 380, maxViewportRatio: 0.8 } as const;

export const POLL_INTERVALS = [5000, 10000, 30000] as const;
export const TAIL_SIZES = [100, 200, 500, 2000] as const;
export const SINCE_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'tail only', value: null },
  { label: 'last 5m', value: 300 },
  { label: 'last 15m', value: 900 },
  { label: 'last 1h', value: 3600 },
  { label: 'last 6h', value: 21600 },
];

const STORAGE_KEY = 'podharbor.prefs';

const DEFAULTS: Prefs = {
  theme: 'system',
  view: 'pods',
  context: null,
  knownNamespaces: {},
  manualNamespaces: {},
  enabledNamespaces: {},
  pollIntervalMs: 10000,
  autoPoll: true,
  tailLines: 200,
  sinceSeconds: null,
  wrap: false,
  timestamps: true,
  groupByWorkload: false,
  logLevels: [...LOG_LEVEL_KEYS],
  drawerWidth: DRAWER_WIDTH.default,
  columnWidths: {},
};

@Injectable({ providedIn: 'root' })
export class PrefsService {
  readonly #$prefs = signal<Prefs>(readPrefs());

  readonly $prefs = this.#$prefs.asReadonly();
  readonly $theme = computed(() => this.$prefs().theme);
  readonly $view = computed(() => this.$prefs().view);
  readonly $context = computed(() => this.$prefs().context);
  readonly $pollIntervalMs = computed(() => this.$prefs().pollIntervalMs);
  readonly $autoPoll = computed(() => this.$prefs().autoPoll);
  readonly $tailLines = computed(() => this.$prefs().tailLines);
  readonly $sinceSeconds = computed(() => this.$prefs().sinceSeconds);
  readonly $wrap = computed(() => this.$prefs().wrap);
  readonly $timestamps = computed(() => this.$prefs().timestamps);
  readonly $groupByWorkload = computed(() => this.$prefs().groupByWorkload);
  readonly $logLevels = computed(() => this.$prefs().logLevels);
  readonly $drawerWidth = computed(() => this.$prefs().drawerWidth);
  readonly $columnWidths = computed(() => this.$prefs().columnWidths);

  constructor() {
    effect(() => {
      const prefs = this.#$prefs();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch {
        // Private mode or a full quota — preferences are a convenience, never a blocker.
      }
    });
  }

  patch(patch: Partial<Prefs>): void {
    this.#$prefs.update((prefs) => ({ ...prefs, ...patch }));
  }

  isLevelEnabled(level: LogLevelKey): boolean {
    return this.$logLevels().includes(level);
  }

  toggleLevel(level: LogLevelKey): void {
    this.#$prefs.update((prefs) => ({
      ...prefs,
      logLevels: prefs.logLevels.includes(level)
        ? prefs.logLevels.filter((item) => item !== level)
        : LOG_LEVEL_KEYS.filter((item) => item === level || prefs.logLevels.includes(item)),
    }));
  }

  setAllLevels(enabled: boolean): void {
    this.patch({ logLevels: enabled ? [...LOG_LEVEL_KEYS] : [] });
  }

  columnWidthsFor(table: string): Record<string, number> {
    return this.$columnWidths()[table] ?? {};
  }

  setColumnWidth(table: string, column: string, width: number): void {
    this.#$prefs.update((prefs) => ({
      ...prefs,
      columnWidths: {
        ...prefs.columnWidths,
        [table]: { ...(prefs.columnWidths[table] ?? {}), [column]: width },
      },
    }));
  }

  /** Drops the stored width so the column falls back to its computed default. */
  clearColumnWidth(table: string, column: string): void {
    this.#$prefs.update((prefs) => {
      const stored = prefs.columnWidths[table];
      if (!stored || !(column in stored)) {
        return prefs;
      }
      const { [column]: _dropped_, ...rest } = stored;
      return { ...prefs, columnWidths: { ...prefs.columnWidths, [table]: rest } };
    });
  }

  knownNamespacesFor(context: string): string[] {
    return this.$prefs().knownNamespaces[context] ?? [];
  }

  manualNamespacesFor(context: string): string[] {
    return this.$prefs().manualNamespaces[context] ?? [];
  }

  enabledNamespacesFor(context: string): string[] {
    return this.$prefs().enabledNamespaces[context] ?? [];
  }

  setKnownNamespaces(context: string, namespaces: string[]): void {
    this.#$prefs.update((prefs) => ({
      ...prefs,
      knownNamespaces: { ...prefs.knownNamespaces, [context]: namespaces },
    }));
  }

  setManualNamespaces(context: string, namespaces: string[]): void {
    this.#$prefs.update((prefs) => ({
      ...prefs,
      manualNamespaces: { ...prefs.manualNamespaces, [context]: namespaces },
    }));
  }

  setEnabledNamespaces(context: string, namespaces: string[]): void {
    this.#$prefs.update((prefs) => ({
      ...prefs,
      enabledNamespaces: { ...prefs.enabledNamespaces, [context]: namespaces },
    }));
  }
}

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULTS };
    }
    return migrate(JSON.parse(raw) as Partial<Prefs> & LegacyPrefs);
  } catch {
    return { ...DEFAULTS };
  }
}

/** The old `namespaces` map held the selection: it becomes the enabled set and seeds the known one. */
function migrate(stored: Partial<Prefs> & LegacyPrefs): Prefs {
  const { namespaces, ...rest } = stored;
  const prefs: Prefs = { ...DEFAULTS, ...rest };
  if (!namespaces) {
    return prefs;
  }
  const knownNamespaces = { ...prefs.knownNamespaces };
  const enabledNamespaces = { ...prefs.enabledNamespaces };
  for (const [context, selected] of Object.entries(namespaces)) {
    knownNamespaces[context] = unique([
      ...(knownNamespaces[context] ?? []),
      ...(prefs.manualNamespaces[context] ?? []),
      ...selected,
    ]).sort();
    enabledNamespaces[context] = unique([
      ...(enabledNamespaces[context] ?? []),
      ...selected,
    ]).sort();
  }
  return { ...prefs, knownNamespaces, enabledNamespaces };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
