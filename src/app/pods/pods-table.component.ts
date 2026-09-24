import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { ClockService } from '../core/clock.service';
import { ColumnHandleComponent } from '../shared/column-handle.component';
import { ColumnSizing, ColumnSpec } from '../shared/column-sizing';
import { ConfirmService } from '../core/confirm.service';
import { IconComponent } from '../shared/icon.component';
import { KubeStateService } from '../core/kube-state.service';
import { LogsService } from '../core/logs.service';
import { PodDetailsComponent } from './pod-details.component';
import { PodSummary } from '../core/models';
import { PodsSelectionComponent } from './pods-selection.component';
import { PrefsService } from '../core/prefs.service';
import { ShortcutsService } from '../core/shortcuts.service';
import { formatAge, parseImage, podStatusTone } from '../core/format';

export type PodSortKey =
  'name' | 'namespace' | 'workload' | 'ready' | 'status' | 'restarts' | 'age' | 'image' | 'node';

interface PodRow {
  pod: PodSummary;
  workload: string;
  image: string;
  imageTitle: string;
  age: string;
  tone: ReturnType<typeof podStatusTone>;
}

type PodListItem =
  | { kind: 'group'; key: string; label: string; count: number; pods: PodSummary[] }
  | { kind: 'row'; key: string; row: PodRow };

@Component({
  selector: 'app-pods-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ColumnHandleComponent, IconComponent, PodDetailsComponent, PodsSelectionComponent],
  templateUrl: './pods-table.component.html',
  styleUrl: './pods-table.component.scss',
})
export class PodsTableComponent {
  protected readonly kube = inject(KubeStateService);
  protected readonly prefs = inject(PrefsService);
  readonly #logs = inject(LogsService);
  readonly #confirm = inject(ConfirmService);
  readonly #clock = inject(ClockService);
  readonly #shortcuts = inject(ShortcutsService);

  protected readonly $filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');

  /** Widths are defaults: `ColumnSizing` raises any that would clip its header label. */
  static readonly COLUMNS: ColumnSpec<PodSortKey>[] = [
    { key: 'name', label: 'Name', min: 200, grow: true },
    { key: 'namespace', label: 'Namespace', width: 120 },
    { key: 'workload', label: 'Workload', width: 130 },
    { key: 'ready', label: 'Ready', width: 78 },
    { key: 'status', label: 'Status', width: 160, min: 150 },
    { key: 'restarts', label: 'Restarts', width: 100 },
    { key: 'age', label: 'Age', width: 70 },
    { key: 'image', label: 'Image', width: 170 },
    { key: 'node', label: 'Node', width: 130 },
  ];

  /** Checkbox gutter and row actions bracket the resizable columns. */
  protected readonly columns = new ColumnSizing(
    'pods',
    PodsTableComponent.COLUMNS,
    this.prefs,
    '30px',
    '62px',
  );

  protected readonly $filter = signal('');
  protected readonly $sortKey = signal<PodSortKey>('name');
  protected readonly $sortAsc = signal(true);
  protected readonly $selected = signal<ReadonlySet<string>>(new Set());
  protected readonly $openPod = signal<PodSummary | null>(null);

  protected readonly $rows = computed<PodRow[]>(() => {
    const now = this.#clock.$now();
    const needle = this.$filter().trim().toLowerCase();
    const rows = this.kube.$pods().map((pod) => {
      const image = pod.containers[0]?.image ?? '';
      const parsed = parseImage(image);
      return {
        pod,
        workload: pod.workload ? `${pod.workload.name}` : (pod.owner?.name ?? '-'),
        image: parsed.short,
        imageTitle: parsed.full,
        age: formatAge(pod.createdAt, now),
        tone: podStatusTone(pod),
      };
    });
    const filtered = needle
      ? rows.filter((row) =>
          [
            row.pod.name,
            row.pod.namespace,
            row.workload,
            row.pod.status,
            row.image,
            row.pod.node ?? '',
          ]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        )
      : rows;
    return this.#sort(filtered);
  });

  /** Flat list so a single `@for` renders both group headers and rows. */
  protected readonly $items = computed<PodListItem[]>(() => {
    const rows = this.$rows();
    if (!this.prefs.$groupByWorkload()) {
      return rows.map((row) => ({ kind: 'row' as const, key: row.pod.uid, row }));
    }
    const groups = new Map<string, PodRow[]>();
    for (const row of rows) {
      const key = `${row.pod.namespace}/${row.workload}`;
      const group = groups.get(key);
      if (group) {
        group.push(row);
      } else {
        groups.set(key, [row]);
      }
    }
    const items: PodListItem[] = [];
    for (const [key, groupRows] of groups) {
      items.push({
        kind: 'group',
        key: `group:${key}`,
        label: key,
        count: groupRows.length,
        pods: groupRows.map((row) => row.pod),
      });
      items.push(...groupRows.map((row) => ({ kind: 'row' as const, key: row.pod.uid, row })));
    }
    return items;
  });

  protected readonly $selectedPods = computed(() => {
    const selected = this.$selected();
    return this.$rows()
      .map((row) => row.pod)
      .filter((pod) => selected.has(pod.uid));
  });

  /** 2+ pods selected: the drawer summarises the selection instead of one pod's facts. */
  protected readonly $showSelection = computed(() => this.$selectedPods().length > 1);

  /** A single selected pod owns the drawer, so deselecting down to one falls back to its details. */
  protected readonly $drawerPod = computed(() => {
    const selected = this.$selectedPods();
    return selected.length === 1 ? selected[0] : this.$openPod();
  });

  protected readonly $allSelected = computed(() => {
    const rows = this.$rows();
    return rows.length > 0 && rows.every((row) => this.$selected().has(row.pod.uid));
  });

  constructor() {
    effect(() => {
      this.#shortcuts.$focusFilter();
      untracked(() => this.$filterInput()?.nativeElement.focus());
    });

    effect(() => {
      const tick = this.#shortcuts.$escape();
      if (tick === 0) {
        return;
      }
      untracked(() => {
        if (this.$showSelection()) {
          this.clearSelection();
        } else if (this.$openPod() !== null) {
          this.$openPod.set(null);
        }
      });
    });

    // Keep the open drawer in sync with the polled list; close it when the pod disappears.
    effect(() => {
      const pods = this.kube.$pods();
      const open = untracked(() => this.$openPod());
      if (!open) {
        return;
      }
      const fresh = pods.find((pod) => pod.uid === open.uid);
      this.$openPod.set(fresh ?? null);
    });
  }

  sortBy(key: PodSortKey): void {
    if (this.$sortKey() === key) {
      this.$sortAsc.update((asc) => !asc);
      return;
    }
    this.$sortKey.set(key);
    this.$sortAsc.set(true);
  }

  sortIcon(key: PodSortKey): 'sort' | 'sort-asc' | 'sort-desc' {
    if (this.$sortKey() !== key) {
      return 'sort';
    }
    return this.$sortAsc() ? 'sort-asc' : 'sort-desc';
  }

  /** A plain row click inspects that pod: it replaces the selection, as a table click does. */
  openRow(pod: PodSummary): void {
    this.$selected.set(new Set());
    this.$openPod.set(pod);
  }

  /** The drawer's close button: a pod shown because it is the only selected one is deselected. */
  closeDrawer(pod: PodSummary): void {
    this.$openPod.set(null);
    this.$selected.update((selected) => {
      const next = new Set(selected);
      next.delete(pod.uid);
      return next;
    });
  }

  toggle(pod: PodSummary): void {
    this.$selected.update((selected) => {
      const next = new Set(selected);
      if (!next.delete(pod.uid)) {
        next.add(pod.uid);
      }
      return next;
    });
  }

  toggleAll(): void {
    const rows = this.$rows();
    this.$selected.set(this.$allSelected() ? new Set() : new Set(rows.map((row) => row.pod.uid)));
  }

  clearSelection(): void {
    this.$selected.set(new Set());
  }

  async tailSelection(): Promise<void> {
    await this.tailPods(this.$selectedPods());
  }

  /** Used by the group-by-workload header: every pod of the group at once. */
  async tailPods(pods: PodSummary[]): Promise<void> {
    const context = this.kube.$context();
    if (!context || pods.length === 0) {
      return;
    }
    this.prefs.patch({ view: 'logs' });
    for (const pod of pods) {
      await this.#logs.addPod(context, pod);
    }
  }

  async tail(pod: PodSummary, container?: string): Promise<void> {
    const context = this.kube.$context();
    if (!context) {
      return;
    }
    this.prefs.patch({ view: 'logs' });
    await this.#logs.addPod(context, pod, container);
  }

  async confirmDelete(pod: PodSummary): Promise<void> {
    const context = this.kube.$context();
    if (!context) {
      return;
    }
    const confirmed = await this.#confirm.ask({
      title: `Delete pod ${pod.name}?`,
      message:
        'The pod is deleted; its controller recreates it. In-flight requests on this replica are dropped.',
      context: `${context} / ${pod.namespace}`,
      confirmLabel: 'Delete pod',
      danger: true,
    });
    if (confirmed) {
      await this.kube.deletePod(pod);
    }
  }

  #sort(rows: PodRow[]): PodRow[] {
    const key = this.$sortKey();
    const direction = this.$sortAsc() ? 1 : -1;
    return [...rows].sort((left, right) => direction * compare(left, right, key));
  }
}

function compare(left: PodRow, right: PodRow, key: PodSortKey): number {
  switch (key) {
    case 'restarts':
      return left.pod.restarts - right.pod.restarts;
    case 'ready':
      return (
        left.pod.readyCount - right.pod.readyCount || left.pod.name.localeCompare(right.pod.name)
      );
    case 'age':
      return Date.parse(right.pod.createdAt ?? '') - Date.parse(left.pod.createdAt ?? '');
    case 'namespace':
      return (
        left.pod.namespace.localeCompare(right.pod.namespace) ||
        left.pod.name.localeCompare(right.pod.name)
      );
    case 'status':
      return (
        left.pod.status.localeCompare(right.pod.status) ||
        left.pod.name.localeCompare(right.pod.name)
      );
    case 'workload':
      return (
        left.workload.localeCompare(right.workload) || left.pod.name.localeCompare(right.pod.name)
      );
    case 'image':
      return left.image.localeCompare(right.image);
    case 'node':
      return (left.pod.node ?? '').localeCompare(right.pod.node ?? '');
    default:
      return left.pod.name.localeCompare(right.pod.name);
  }
}
