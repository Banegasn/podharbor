import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { LogEntry, LogsService } from '../core/logs.service';
import { PrefsService } from '../core/prefs.service';
import { formatLogTime, middleEllipsis } from '../core/format';

/** Mirrors `--log-line-height` in `_tokens.scss`: the virtualiser's fixed row pitch. */
const ROW_HEIGHT = 20;
const OVERSCAN = 12;
/** Wrapped lines have no fixed height, so that mode renders a capped tail instead of a window. */
const WRAP_TAIL = 1500;
/**
 * Pod badge budgets, sized to stay inside each variant's `--pod-badge-max` (13px mono ≈ 7.8px per
 * character): shortening in code is what keeps the replica hash, which the box would clip away.
 */
const POD_LABEL_MAX = 26;
const POD_LABEL_MAX_COMPACT = 18;

/**
 * Renders the aggregated buffer of the `LogsService` visible in its injector: the Logs tab uses the
 * root one, the pod drawer its own scoped instance (`providers: [LogsService]`).
 */
@Component({
  selector: 'app-log-stream',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './log-stream.component.html',
  styleUrl: './log-stream.component.scss',
  host: { '(window:resize)': 'measure()', '[class.compact]': '$compact()' },
})
export class LogStreamComponent {
  /** Drawer variant: a narrower badge cap, and no badge at all while a single pod streams. */
  readonly $compact = input(false, { alias: 'compact' });

  protected readonly logs = inject(LogsService);
  protected readonly prefs = inject(PrefsService);
  readonly #destroyRef = inject(DestroyRef);

  protected readonly $scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly formatLogTime = formatLogTime;

  readonly #$scrollTop = signal(0);
  readonly #$viewport = signal(600);

  protected readonly $showNamespace = computed(() => this.logs.$namespaceCount() > 1);
  /** In the drawer a lone pod is already named by the title above the pane — the badge is noise. */
  protected readonly $showSource = computed(() => !this.$compact() || this.logs.$podCount() > 1);
  protected readonly $total = computed(() => this.logs.$filtered().length);
  protected readonly $canvasHeight = computed(() => this.$total() * ROW_HEIGHT);

  readonly #$visibleCount = computed(
    // Floor: a hidden or not-yet-measured pane reports a zero-height viewport.
    () => Math.ceil(Math.max(this.#$viewport(), 400) / ROW_HEIGHT) + OVERSCAN * 2,
  );

  /** Clamped: a filter that shrinks the list can leave the scroll position past the new end. */
  protected readonly $start = computed(() => {
    const fromScroll = Math.max(0, Math.floor(this.#$scrollTop() / ROW_HEIGHT) - OVERSCAN);
    return Math.min(fromScroll, Math.max(0, this.$total() - this.#$visibleCount()));
  });
  protected readonly $offsetY = computed(() => this.$start() * ROW_HEIGHT);
  protected readonly $window = computed(() => {
    const lines = this.logs.$filtered();
    if (this.prefs.$wrap()) {
      return lines.slice(Math.max(0, lines.length - WRAP_TAIL));
    }
    const start = this.$start();
    return lines.slice(start, start + this.#$visibleCount());
  });

  constructor() {
    afterNextRender(() => {
      this.measure();
      const element = this.$scroller()?.nativeElement;
      if (element) {
        const observer = new ResizeObserver(() => this.measure());
        observer.observe(element);
        this.#destroyRef.onDestroy(() => observer.disconnect());
      }
    });

    // Follow-to-bottom: after each render caused by new lines — or by follow being turned back
    // on — pin the scroll to the end.
    afterRenderEffect(() => {
      this.logs.$filtered();
      this.prefs.$wrap();
      if (!this.logs.$follow()) {
        return;
      }
      const element = untracked(() => this.$scroller()?.nativeElement);
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }

  /** The untouched `namespace/pod` stays in the cell's `title`. */
  protected podLabel(line: LogEntry): string {
    const pod = middleEllipsis(line.pod, this.$compact() ? POD_LABEL_MAX_COMPACT : POD_LABEL_MAX);
    return this.$showNamespace() ? `${line.namespace}/${pod}` : pod;
  }

  measure(): void {
    const element = this.$scroller()?.nativeElement;
    if (element) {
      this.#$viewport.set(element.clientHeight);
      this.#$scrollTop.set(element.scrollTop);
    }
  }

  onScroll(event: Event): void {
    const element = event.target as HTMLElement;
    this.#$scrollTop.set(element.scrollTop);
    this.#$viewport.set(element.clientHeight);
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    if (atBottom !== this.logs.$follow()) {
      this.logs.setFollow(atBottom);
    }
  }

  jumpToBottom(): void {
    this.logs.setFollow(true);
    const element = this.$scroller()?.nativeElement;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }
}
