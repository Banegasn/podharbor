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
import { PodSummary, WorkloadSummary } from '../core/models';
import { PrefsService } from '../core/prefs.service';
import { ShortcutsService } from '../core/shortcuts.service';
import { formatAge, isProductionContext, parseImage, podStatusTone } from '../core/format';

export type WorkloadSortKey = 'kind' | 'name' | 'namespace' | 'ready' | 'age';

/** Every column of the table; only some of them sort. */
type WorkloadColumnKey = WorkloadSortKey | 'updated' | 'available' | 'images' | 'conditions';

interface WorkloadRow {
  workload: WorkloadSummary;
  images: string[];
  imageTitle: string;
  age: string;
  healthy: boolean;
  degraded: string | null;
}

@Component({
  selector: 'app-workloads-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ColumnHandleComponent, IconComponent],
  templateUrl: './workloads-table.component.html',
  styleUrl: './workloads-table.component.scss',
})
export class WorkloadsTableComponent {
  protected readonly kube = inject(KubeStateService);
  readonly #prefs = inject(PrefsService);
  readonly #logs = inject(LogsService);
  readonly #confirm = inject(ConfirmService);
  readonly #clock = inject(ClockService);
  readonly #shortcuts = inject(ShortcutsService);

  protected readonly $filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');

  /** Widths are defaults: `ColumnSizing` raises any that would clip its header label. */
  static readonly COLUMNS: (ColumnSpec<WorkloadColumnKey> & { sort?: WorkloadSortKey })[] = [
    { key: 'kind', label: 'Kind', width: 78, sort: 'kind' },
    { key: 'name', label: 'Name', min: 180, grow: true, sort: 'name' },
    { key: 'namespace', label: 'Namespace', width: 120, sort: 'namespace' },
    { key: 'ready', label: 'Ready', width: 78, sort: 'ready' },
    { key: 'age', label: 'Age', width: 70, sort: 'age' },
    { key: 'updated', label: 'Updated', width: 96 },
    { key: 'available', label: 'Available', width: 110 },
    { key: 'images', label: 'Images', width: 170 },
    { key: 'conditions', label: 'Conditions', width: 130 },
  ];

  /** Chevron gutter and row actions bracket the resizable columns. */
  protected readonly columns = new ColumnSizing(
    'workloads',
    WorkloadsTableComponent.COLUMNS,
    this.#prefs,
    '26px',
    '66px',
  );

  protected readonly $filter = signal('');
  protected readonly $sortKey = signal<WorkloadSortKey>('name');
  protected readonly $sortAsc = signal(true);
  protected readonly $expanded = signal<ReadonlySet<string>>(new Set());

  protected readonly $rows = computed<WorkloadRow[]>(() => {
    const now = this.#clock.$now();
    const needle = this.$filter().trim().toLowerCase();
    const rows = this.kube.$workloads().map((workload) => {
      const healthy =
        workload.ready === workload.desired && workload.available === workload.desired;
      const failing = workload.conditions.find(
        (condition) => condition.kind === 'Available' && condition.status !== 'True',
      );
      return {
        workload,
        images: workload.images.map((image) => parseImage(image).short),
        imageTitle: workload.images.join('\n'),
        age: formatAge(workload.createdAt, now),
        healthy,
        degraded: failing ? (failing.reason ?? 'unavailable') : null,
      };
    });
    const filtered = needle
      ? rows.filter((row) =>
          [row.workload.kind, row.workload.name, row.workload.namespace, ...row.images]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        )
      : rows;
    const direction = this.$sortAsc() ? 1 : -1;
    const key = this.$sortKey();
    return [...filtered].sort((left, right) => direction * compare(left, right, key));
  });

  constructor() {
    effect(() => {
      this.#shortcuts.$focusFilter();
      untracked(() => this.$filterInput()?.nativeElement.focus());
    });
  }

  sortBy(key: WorkloadSortKey): void {
    if (this.$sortKey() === key) {
      this.$sortAsc.update((asc) => !asc);
      return;
    }
    this.$sortKey.set(key);
    this.$sortAsc.set(true);
  }

  sortIcon(key: WorkloadSortKey): 'sort' | 'sort-asc' | 'sort-desc' {
    if (this.$sortKey() !== key) {
      return 'sort';
    }
    return this.$sortAsc() ? 'sort-asc' : 'sort-desc';
  }

  toggleExpanded(workload: WorkloadSummary): void {
    this.$expanded.update((expanded) => {
      const next = new Set(expanded);
      if (!next.delete(workload.uid)) {
        next.add(workload.uid);
      }
      return next;
    });
  }

  /** Selector labels resolve the workload's pods from the list already in memory. */
  podsOf(workload: WorkloadSummary): PodSummary[] {
    const selector = Object.entries(workload.selector);
    return this.kube
      .$pods()
      .filter(
        (pod) =>
          pod.namespace === workload.namespace &&
          selector.every(([key, value]) => pod.labels[key] === value),
      );
  }

  tracked(workload: WorkloadSummary): boolean {
    const context = this.kube.$context();
    return !!context && this.#logs.tracksWorkload(context, workload);
  }

  podTone = podStatusTone;

  podAge(pod: PodSummary): string {
    return formatAge(pod.createdAt, this.#clock.$now());
  }

  async tail(pod: PodSummary): Promise<void> {
    const context = this.kube.$context();
    if (!context) {
      return;
    }
    this.#prefs.patch({ view: 'logs' });
    await this.#logs.addPod(context, pod);
  }

  /** The whole workload becomes a log source group — later replicas attach themselves. */
  async tailWorkload(workload: WorkloadSummary): Promise<void> {
    const context = this.kube.$context();
    if (!context) {
      return;
    }
    this.#prefs.patch({ view: 'logs' });
    await this.#logs.addWorkload(context, workload, this.kube.$pods());
  }

  async confirmRestart(workload: WorkloadSummary): Promise<void> {
    const context = this.kube.$context();
    if (!context) {
      return;
    }
    const confirmed = await this.#confirm.ask({
      title: `Rollout restart ${workload.kind.toLowerCase()}/${workload.name}?`,
      message: `Every one of the ${workload.desired} replica(s) is replaced following the rollout strategy.`,
      context: `${context} / ${workload.namespace}`,
      confirmLabel: 'Rollout restart',
      danger: isProductionContext(context),
    });
    if (confirmed) {
      await this.kube.restartWorkload(workload);
    }
  }
}

function compare(left: WorkloadRow, right: WorkloadRow, key: WorkloadSortKey): number {
  switch (key) {
    case 'kind':
      return (
        left.workload.kind.localeCompare(right.workload.kind) ||
        left.workload.name.localeCompare(right.workload.name)
      );
    case 'namespace':
      return (
        left.workload.namespace.localeCompare(right.workload.namespace) ||
        left.workload.name.localeCompare(right.workload.name)
      );
    case 'ready':
      return (
        left.workload.ready -
        left.workload.desired -
        (right.workload.ready - right.workload.desired)
      );
    case 'age':
      return Date.parse(right.workload.createdAt ?? '') - Date.parse(left.workload.createdAt ?? '');
    default:
      return left.workload.name.localeCompare(right.workload.name);
  }
}
