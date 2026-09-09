import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';

import { ClockService } from '../core/clock.service';
import { DrawerHandleComponent } from '../shared/drawer-handle.component';
import { IconComponent } from '../shared/icon.component';
import { KubeStateService } from '../core/kube-state.service';
import { LogLevelFilterComponent } from '../logs/log-level-filter.component';
import { LogStreamComponent } from '../logs/log-stream.component';
import { LogsService } from '../core/logs.service';
import { PodSummary } from '../core/models';
import { PrefsService } from '../core/prefs.service';
import { StatusTone, formatAge, parseImage, podStatusTone } from '../core/format';
import { createDrawerResize } from '../shared/drawer-resize';

/**
 * Streams cost one kubelet connection each (more on multi-container pods): a wide selection tails
 * its first pods only, and says so.
 */
const MAX_TAIL_PODS = 8;

interface StatusCount {
  status: string;
  count: number;
  tone: StatusTone;
}

/**
 * Right drawer for a selection of 2+ pods: what they have in common (namespaces, workloads,
 * statuses, restarts, images, age spread) over a merged tail of their logs.
 *
 * The tail is the same multi-source mechanism the Logs tab uses, on a `LogsService` instance
 * scoped to this drawer (see `providers`) — so it never touches what the Logs tab streams, and the
 * level chips, wrap and filter controls behave exactly as they do there. "Open in Logs tab" is the
 * explicit hand-over to the global one, handled by the parent.
 */
@Component({
  selector: 'app-pods-selection',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DrawerHandleComponent, IconComponent, LogLevelFilterComponent, LogStreamComponent],
  providers: [LogsService],
  templateUrl: './pods-selection.component.html',
  styleUrl: './pods-selection.component.scss',
  host: {
    '(window:resize)': 'resize.onViewportResize()',
  },
})
export class PodsSelectionComponent {
  readonly #kube = inject(KubeStateService);
  readonly #clock = inject(ClockService);
  /** Scoped instance — never the root one the Logs tab uses. */
  protected readonly logs = inject(LogsService);
  protected readonly prefs = inject(PrefsService);
  protected readonly resize = createDrawerResize();

  readonly $pods = input.required<PodSummary[]>({ alias: 'pods' });

  readonly tailRequested = output<void>();
  readonly clearRequested = output<void>();

  protected readonly maxTailPods = MAX_TAIL_PODS;

  protected readonly $namespaces = computed(() =>
    distinct(this.$pods().map((pod) => pod.namespace)),
  );
  protected readonly $workloads = computed(() =>
    distinct(this.$pods().map((pod) => pod.workload?.name ?? pod.owner?.name ?? '-')),
  );
  protected readonly $restarts = computed(() =>
    this.$pods().reduce((total, pod) => total + pod.restarts, 0),
  );
  protected readonly $notReady = computed(
    () => this.$pods().filter((pod) => pod.readyCount !== pod.totalCount).length,
  );
  protected readonly $images = computed(() =>
    distinct(this.$pods().flatMap((pod) => pod.containers.map((c) => parseImage(c.image).short))),
  );

  protected readonly $statuses = computed<StatusCount[]>(() => {
    const counts = new Map<string, StatusCount>();
    for (const pod of this.$pods()) {
      const entry = counts.get(pod.status);
      if (entry) {
        entry.count += 1;
      } else {
        counts.set(pod.status, { status: pod.status, count: 1, tone: podStatusTone(pod) });
      }
    }
    return [...counts.values()].sort((left, right) => right.count - left.count);
  });

  /** Age spread of the selection — a rolled-out ReplicaSet shows up as a wide one. */
  protected readonly $ages = computed(() => {
    const now = this.#clock.$now();
    const stamps = this.$pods()
      .map((pod) => Date.parse(pod.createdAt ?? ''))
      .filter((value) => !Number.isNaN(value));
    if (stamps.length === 0) {
      return null;
    }
    return {
      oldest: formatAge(new Date(Math.min(...stamps)).toISOString(), now),
      newest: formatAge(new Date(Math.max(...stamps)).toISOString(), now),
    };
  });

  /** Stable across polls: only a different set of pods restarts the merged tail. */
  readonly #$podKeys = computed(() =>
    this.$pods()
      .map((pod) => `${pod.namespace}/${pod.name}`)
      .sort()
      .join(','),
  );
  protected readonly $tailed = computed(() => this.$pods().slice(0, MAX_TAIL_PODS));

  #tailToken = 0;

  constructor() {
    // `#retail` must stay untracked: its synchronous prefix both reads and writes the log signals,
    // which inside the reactive context would make this effect retrigger itself forever.
    effect(() => {
      this.#$podKeys();
      const context = this.#kube.$context();
      untracked(() => void this.#retail(context, this.$tailed()));
    });
  }

  async #retail(context: string | null, pods: PodSummary[]): Promise<void> {
    const token = ++this.#tailToken;
    await this.logs.disposeScope();
    if (!context || token !== this.#tailToken) {
      return;
    }
    for (const pod of pods) {
      if (token !== this.#tailToken) {
        return;
      }
      await this.logs.addPod(context, pod);
    }
  }
}

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort();
}
