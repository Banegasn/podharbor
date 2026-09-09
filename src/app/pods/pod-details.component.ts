import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';

import { ClockService } from '../core/clock.service';
import { DocViewerComponent } from '../shared/doc-viewer.component';
import { DrawerHandleComponent } from '../shared/drawer-handle.component';
import { IconComponent } from '../shared/icon.component';
import { KubeBackend } from '../core/kube-backend';
import { KubeStateService } from '../core/kube-state.service';
import { LogLevelFilterComponent } from '../logs/log-level-filter.component';
import { LogStreamComponent } from '../logs/log-stream.component';
import { LogsService } from '../core/logs.service';
import { PodSummary, ResourceDocument, toAppError } from '../core/models';
import { PrefsService } from '../core/prefs.service';
import { ToastService } from '../core/toast.service';
import { createDrawerResize } from '../shared/drawer-resize';
import { formatAge, formatDateTime, parseImage, podStatusTone } from '../core/format';

type DetailsTab = 'overview' | 'details';

/**
 * Right drawer for one pod. **Overview** carries the summary plus this pod's logs inline;
 * **Details** everything else (containers, conditions, labels, manifest, delete).
 *
 * The inline tail runs on its own `LogsService` instance (see `providers`): its sources, buffer,
 * filter and follow state are private to the drawer, so opening it never touches what the Logs tab
 * is streaming. That instance is destroyed with the component, which stops only its own streams
 * (`LogsService.disposeScope`). Putting the pod in the *global* Logs tab is an explicit action —
 * "Open in Logs tab", handled by the parent through `tailRequested`.
 *
 * The width is dragged from the handle on the left edge and persisted in prefs, always clamped to
 * the viewport so the drawer can never push the layout sideways.
 */
@Component({
  selector: 'app-pod-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DocViewerComponent,
    DrawerHandleComponent,
    IconComponent,
    LogLevelFilterComponent,
    LogStreamComponent,
  ],
  providers: [LogsService],
  templateUrl: './pod-details.component.html',
  styleUrl: './pod-details.component.scss',
  host: {
    '(window:resize)': 'resize.onViewportResize()',
  },
})
export class PodDetailsComponent {
  readonly #backend = inject(KubeBackend);
  readonly #kube = inject(KubeStateService);
  readonly #toasts = inject(ToastService);
  readonly #clock = inject(ClockService);
  /** Scoped instance — never the root one the Logs tab uses. */
  protected readonly logs = inject(LogsService);
  protected readonly prefs = inject(PrefsService);
  /** Drag handle on the left edge, persisted width — shared with the multi-selection drawer. */
  protected readonly resize = createDrawerResize();

  readonly $pod = input.required<PodSummary>({ alias: 'pod' });

  readonly closed = output<void>();
  readonly tailRequested = output<string | undefined>();
  readonly deleteRequested = output<void>();

  protected readonly $tab = signal<DetailsTab>('overview');
  protected readonly $document = signal<ResourceDocument | null>(null);

  protected readonly $age = computed(() => formatAge(this.$pod().createdAt, this.#clock.$now()));
  protected readonly $tone = computed(() => podStatusTone(this.$pod()));
  protected readonly $labels = computed(() => Object.entries(this.$pod().labels));
  protected readonly $annotations = computed(() => Object.entries(this.$pod().annotations));
  protected readonly $containers = computed(() => [
    ...this.$pod().initContainers.map((container) => ({ container, init: true })),
    ...this.$pod().containers.map((container) => ({ container, init: false })),
  ]);
  protected readonly $images = computed(() =>
    this.$pod().containers.map((container) => ({
      name: container.name,
      short: parseImage(container.image).short,
      full: container.image,
    })),
  );

  /** Stable across polls: a new object for the same pod must not restart the inline tail. */
  readonly #$podKey = computed(() => `${this.$pod().namespace}/${this.$pod().name}`);
  readonly #$containerNames = computed(() =>
    this.$pod()
      .containers.map((container) => container.name)
      .join(','),
  );
  protected readonly $containerOptions = computed(() =>
    this.#$containerNames() ? this.#$containerNames().split(',') : [],
  );

  /** Defaults to the first container, and resets to it whenever the drawer shows another pod. */
  protected readonly $container = linkedSignal<string, string>({
    source: this.#$podKey,
    computation: () => this.$containerOptions()[0] ?? '',
  });

  protected readonly formatDateTime = formatDateTime;
  protected readonly parseImage = parseImage;

  #loadedKey = '';
  #tailToken = 0;

  constructor() {
    // Polling replaces the pod object every tick; only a different pod triggers a re-fetch.
    effect(() => {
      const pod = this.$pod();
      const key = `${pod.namespace}/${pod.name}`;
      if (key === this.#loadedKey) {
        return;
      }
      this.#loadedKey = key;
      void this.#load(pod.namespace, pod.name);
    });

    // Another pod, or another container of the same pod, restarts the inline tail from scratch.
    // `#retail` must stay untracked: its synchronous prefix both reads and writes the log signals,
    // which inside the reactive context would make this effect retrigger itself forever.
    effect(() => {
      this.#$podKey();
      const container = this.$container();
      const context = this.#kube.$context();
      untracked(() => void this.#retail(context, this.$pod(), container));
    });
  }

  onContainerChange(event: Event): void {
    this.$container.set((event.target as HTMLSelectElement).value);
  }

  async #retail(context: string | null, pod: PodSummary, container: string): Promise<void> {
    const token = ++this.#tailToken;
    await this.logs.disposeScope();
    if (!context || token !== this.#tailToken) {
      return;
    }
    await this.logs.addPod(context, pod, container || undefined);
  }

  async #load(namespace: string, name: string): Promise<void> {
    const context = this.#kube.$context();
    if (!context) {
      return;
    }
    this.$document.set(null);
    try {
      this.$document.set(await this.#backend.getPodDocument(context, namespace, name));
    } catch (raw) {
      this.#toasts.failure(`Cannot read ${name}`, toAppError(raw));
    }
  }
}
