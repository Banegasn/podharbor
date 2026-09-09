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

import { IconComponent } from '../shared/icon.component';
import { KubeStateService } from '../core/kube-state.service';
import { LogsService } from '../core/logs.service';
import { PodSummary, WorkloadSummary } from '../core/models';
import { ShortcutsService } from '../core/shortcuts.service';
import { podStatusTone } from '../core/format';

type PickerTab = 'pods' | 'workloads';

/** Long lists stay usable: the filter narrows them instead of rendering thousands of rows. */
const MAX_ROWS = 200;

/**
 * Adds log sources without leaving the Logs tab: pods (optionally a single container) and whole
 * workloads, which keep following their pods across refreshes. Already-tracked entries are checked
 * and clicking them again removes the source.
 */
@Component({
  selector: 'app-log-source-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:pointerdown)': 'onOutside($event)' },
  imports: [IconComponent],
  template: `
    <button
      type="button"
      class="btn trigger"
      [class.is-on]="$open()"
      [attr.aria-expanded]="$open()"
      title="Add pods or workloads as log sources"
      (click)="toggle()"
    >
      <app-icon name="plus" [size]="14" />
      Add source
    </button>

    @if ($open()) {
      <div class="popover panel" role="dialog" aria-label="Add log sources">
        <div class="tabs" role="tablist">
          @for (tab of tabs; track tab.id) {
            <button
              type="button"
              class="tab"
              role="tab"
              [class.active]="$tab() === tab.id"
              [attr.aria-selected]="$tab() === tab.id"
              (click)="$tab.set(tab.id)"
            >
              <app-icon [name]="tab.icon" [size]="13" />
              {{ tab.label }}
              <span class="muted">{{
                tab.id === 'pods' ? $pods().length : $workloads().length
              }}</span>
            </button>
          }
        </div>

        <input
          #search
          class="input"
          type="search"
          [placeholder]="
            $tab() === 'pods' ? 'filter pods — name, namespace, status' : 'filter workloads'
          "
          autocomplete="off"
          [value]="$query()"
          (input)="$query.set(search.value)"
        />

        @if ($tab() === 'pods') {
          <div class="list">
            @for (pod of $visiblePods(); track pod.uid) {
              <div class="row">
                <button
                  type="button"
                  class="option"
                  [attr.aria-pressed]="logs.tracksPod($context(), pod)"
                  (click)="togglePod(pod)"
                >
                  <span class="box" [class.checked]="logs.tracksPod($context(), pod)">
                    @if (logs.tracksPod($context(), pod)) {
                      <app-icon name="check" [size]="11" />
                    }
                  </span>
                  <span class="who truncate" [title]="pod.namespace + '/' + pod.name">
                    <span class="muted">{{ pod.namespace }}/</span>{{ pod.name }}
                  </span>
                  <span class="badge" [class]="tone(pod)">{{ pod.status }}</span>
                  <span class="muted containers">{{ pod.containers.length }}c</span>
                </button>
                @if (pod.containers.length > 1) {
                  <button
                    type="button"
                    class="row-btn"
                    [attr.aria-label]="'Choose a container of ' + pod.name"
                    [attr.aria-expanded]="$expanded().has(pod.uid)"
                    title="Pick a container"
                    (click)="toggleExpanded(pod)"
                  >
                    <app-icon
                      [name]="$expanded().has(pod.uid) ? 'chevron-down' : 'chevron-right'"
                      [size]="13"
                    />
                  </button>
                }
              </div>

              @if (pod.containers.length > 1 && $expanded().has(pod.uid)) {
                <div class="sub">
                  @for (container of pod.containers; track container.name) {
                    <button
                      type="button"
                      class="option"
                      [attr.aria-pressed]="logs.tracksContainer($context(), pod, container.name)"
                      (click)="toggleContainer(pod, container.name)"
                    >
                      <span
                        class="box"
                        [class.checked]="logs.tracksContainer($context(), pod, container.name)"
                      >
                        @if (logs.tracksContainer($context(), pod, container.name)) {
                          <app-icon name="check" [size]="11" />
                        }
                      </span>
                      <span class="who truncate">{{ container.name }}</span>
                      <span class="muted">{{ container.ready ? 'ready' : container.state }}</span>
                    </button>
                  }
                  <p class="hint muted">The pod row above tails every container at once.</p>
                </div>
              }
            } @empty {
              <p class="hint muted">{{ $emptyText() }}</p>
            }
            @if ($pods().length > $visiblePods().length) {
              <p class="hint muted">
                {{ $pods().length - $visiblePods().length }} more — refine the filter.
              </p>
            }
          </div>
        } @else {
          <div class="list">
            @for (workload of $visibleWorkloads(); track workload.uid) {
              <button
                type="button"
                class="option"
                [attr.aria-pressed]="logs.tracksWorkload($context(), workload)"
                (click)="toggleWorkload(workload)"
              >
                <span class="box" [class.checked]="logs.tracksWorkload($context(), workload)">
                  @if (logs.tracksWorkload($context(), workload)) {
                    <app-icon name="check" [size]="11" />
                  }
                </span>
                <span class="badge neutral">{{
                  workload.kind === 'Deployment' ? 'Deploy' : 'STS'
                }}</span>
                <span class="who truncate" [title]="workload.namespace + '/' + workload.name">
                  <span class="muted">{{ workload.namespace }}/</span>{{ workload.name }}
                </span>
                <span
                  class="muted ready"
                  [class.degraded]="workload.ready !== workload.desired"
                  title="ready / desired"
                >
                  {{ workload.ready }}/{{ workload.desired }}
                </span>
              </button>
            } @empty {
              <p class="hint muted">{{ $emptyText() }}</p>
            }
            @if ($workloads().length > $visibleWorkloads().length) {
              <p class="hint muted">
                {{ $workloads().length - $visibleWorkloads().length }} more — refine the filter.
              </p>
            }
          </div>
          <p class="hint muted">
            A workload keeps following its pods: new replicas are attached on the next refresh.
          </p>
        }
      </div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
    }

    .trigger {
      height: var(--control-height-sm);
      padding: 0 var(--sp-4);
      font-size: var(--fs-xs);
    }

    .panel {
      top: 34px;
      left: 0;
      width: 420px;
      display: grid;
      gap: var(--sp-4);
    }

    .tabs {
      display: flex;
      gap: var(--sp-1);
      padding: 2px;
      border: 1px solid var(--border-input);
      border-radius: var(--radius-md);
      background: var(--subtle);
    }

    .tab {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--sp-3);
      height: var(--control-height-sm);
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--fg-muted);
      font-size: var(--fs-sm);
      font-weight: var(--fw-medium);
      cursor: pointer;
    }

    .tab:hover {
      background: var(--hover);
      color: var(--fg);
    }

    .tab.active {
      background: var(--accent-bg);
      color: var(--accent);
    }

    .list {
      max-height: 320px;
      overflow: auto;
      display: grid;
      gap: 1px;
    }

    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--sp-2);
    }

    .option {
      display: flex;
      align-items: center;
      gap: var(--sp-4);
      min-width: 0;
      height: var(--control-height-sm);
      padding: 0 var(--sp-3);
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--fg);
      font-size: var(--fs-sm);
      cursor: pointer;
      text-align: left;
    }

    .option:hover {
      background: var(--hover);
    }

    .box {
      display: grid;
      place-items: center;
      width: 14px;
      height: 14px;
      flex: none;
      border: 1px solid var(--border-input);
      border-radius: 3px;
      background: var(--surface);
    }

    .box.checked {
      border-color: var(--accent);
      background: var(--accent-bg);
      color: var(--accent);
    }

    .who {
      flex: 1;
      min-width: 0;
      font-family: var(--font-mono);
      font-size: var(--fs-xs);
    }

    .containers,
    .ready {
      flex: none;
      font-size: var(--fs-xs);
      font-variant-numeric: tabular-nums;
    }

    .ready.degraded {
      color: var(--error-fg);
      font-weight: var(--fw-semibold);
    }

    .row-btn {
      display: grid;
      place-items: center;
      width: var(--icon-btn-sm);
      height: var(--icon-btn-sm);
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--fg-muted);
      cursor: pointer;
    }

    .row-btn:hover {
      background: var(--hover);
      color: var(--accent);
    }

    .sub {
      display: grid;
      gap: 1px;
      margin-left: var(--sp-6);
      padding-left: var(--sp-4);
      border-left: 1px solid var(--border-light);
    }

    .hint {
      margin: 0;
      padding: var(--sp-2) var(--sp-3);
      font-size: var(--fs-xs);
    }
  `,
})
export class LogSourcePickerComponent {
  protected readonly logs = inject(LogsService);
  readonly #kube = inject(KubeStateService);
  readonly #shortcuts = inject(ShortcutsService);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly $search = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly tabs: { id: PickerTab; label: string; icon: 'pods' | 'workloads' }[] = [
    { id: 'pods', label: 'Pods', icon: 'pods' },
    { id: 'workloads', label: 'Workloads', icon: 'workloads' },
  ];

  protected readonly $open = signal(false);
  protected readonly $tab = signal<PickerTab>('pods');
  protected readonly $query = signal('');
  protected readonly $expanded = signal<ReadonlySet<string>>(new Set());

  protected readonly $context = computed(() => this.#kube.$context() ?? '');

  protected readonly $pods = computed(() => {
    const needle = this.$query().trim().toLowerCase();
    const pods = [...this.#kube.$pods()].sort(
      (left, right) =>
        left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name),
    );
    return needle
      ? pods.filter((pod) =>
          `${pod.namespace} ${pod.name} ${pod.status}`.toLowerCase().includes(needle),
        )
      : pods;
  });

  protected readonly $workloads = computed(() => {
    const needle = this.$query().trim().toLowerCase();
    const workloads = [...this.#kube.$workloads()].sort(
      (left, right) =>
        left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name),
    );
    return needle
      ? workloads.filter((workload) =>
          `${workload.namespace} ${workload.name} ${workload.kind}`.toLowerCase().includes(needle),
        )
      : workloads;
  });

  protected readonly $visiblePods = computed(() => this.$pods().slice(0, MAX_ROWS));
  protected readonly $visibleWorkloads = computed(() => this.$workloads().slice(0, MAX_ROWS));

  protected readonly $emptyText = computed(() => {
    if (this.#kube.$enabledNamespaces().length === 0) {
      return 'No namespace enabled — enable one in the header.';
    }
    return this.$query() ? 'Nothing matches the filter.' : 'Nothing loaded for this namespace yet.';
  });

  protected readonly tone = podStatusTone;

  constructor() {
    effect(() => {
      if (this.$open()) {
        this.$search()?.nativeElement.focus();
      }
    });

    effect(() => {
      const tick = this.#shortcuts.$escape();
      if (tick > 0 && untracked(() => this.$open())) {
        this.$open.set(false);
      }
    });
  }

  toggle(): void {
    this.$open.update((open) => !open);
  }

  onOutside(event: Event): void {
    if (this.$open() && !this.#host.nativeElement.contains(event.target as Node)) {
      this.$open.set(false);
    }
  }

  toggleExpanded(pod: PodSummary): void {
    this.$expanded.update((expanded) => {
      const next = new Set(expanded);
      if (!next.delete(pod.uid)) {
        next.add(pod.uid);
      }
      return next;
    });
  }

  async togglePod(pod: PodSummary): Promise<void> {
    const context = this.$context();
    if (!context) {
      return;
    }
    if (this.logs.tracksPod(context, pod)) {
      await this.logs.removePod(context, pod);
      return;
    }
    await this.logs.addPod(context, pod);
  }

  async toggleContainer(pod: PodSummary, container: string): Promise<void> {
    const context = this.$context();
    if (!context) {
      return;
    }
    if (this.logs.tracksContainer(context, pod, container)) {
      await this.logs.removePod(context, pod, container);
      return;
    }
    await this.logs.addPod(context, pod, container);
  }

  async toggleWorkload(workload: WorkloadSummary): Promise<void> {
    const context = this.$context();
    if (!context) {
      return;
    }
    if (this.logs.tracksWorkload(context, workload)) {
      await this.logs.removeWorkload(context, workload);
      return;
    }
    await this.logs.addWorkload(context, workload, this.#kube.$pods());
  }
}
