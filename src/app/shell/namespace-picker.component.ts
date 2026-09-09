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
import { ShortcutsService } from '../core/shortcuts.service';
import { describeError } from '../core/models';

/**
 * Chips toggle the filter (enabled / disabled); the known list itself is only edited inside the
 * "Manage namespaces" popover, so nothing disappears from a stray click on a chip.
 */
@Component({
  selector: 'app-namespace-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:pointerdown)': 'onOutside($event)' },
  imports: [IconComponent],
  template: `
    <div class="chips">
      @for (namespace of kube.$knownNamespaces(); track namespace) {
        <button
          type="button"
          class="chip"
          [class.off]="!kube.isNamespaceEnabled(namespace)"
          [attr.aria-pressed]="kube.isNamespaceEnabled(namespace)"
          [title]="
            kube.isNamespaceEnabled(namespace)
              ? 'Disable ' + namespace + ' (stops filtering on it)'
              : 'Enable ' + namespace
          "
          (click)="kube.toggleNamespaceEnabled(namespace)"
        >
          {{ namespace }}
        </button>
      } @empty {
        <span class="muted none">no namespace known yet</span>
      }
    </div>

    <button
      type="button"
      class="icon-btn icon-btn-xs manage"
      [class.is-on]="$open()"
      aria-label="Manage namespaces"
      title="Manage namespaces — add, remove, enable"
      (click)="toggle()"
    >
      <app-icon name="settings" [size]="16" />
    </button>

    @if ($open()) {
      <div class="popover panel" role="dialog" aria-label="Manage namespaces">
        <header>
          <h2>Namespaces</h2>
          <span class="muted count">
            {{ kube.$enabledNamespaces().length }}/{{ kube.$knownNamespaces().length }} enabled
          </span>
        </header>

        @if (kube.$namespaceMode() === 'manual') {
          <p class="notice">
            <app-icon name="warning" [size]="13" />
            <span>{{ $noticeText() }}</span>
          </p>
        }

        <div class="bulk">
          <button type="button" class="btn btn-sm" (click)="kube.setAllNamespacesEnabled(true)">
            Enable all
          </button>
          <button type="button" class="btn btn-sm" (click)="kube.setAllNamespacesEnabled(false)">
            Disable all
          </button>
        </div>

        <input
          #search
          class="input"
          placeholder="filter namespaces"
          autocomplete="off"
          [value]="$query()"
          (input)="$query.set(search.value)"
        />

        <div class="list">
          @for (namespace of $matches(); track namespace) {
            <div class="row">
              <button
                type="button"
                class="option"
                [attr.aria-pressed]="kube.isNamespaceEnabled(namespace)"
                (click)="kube.toggleNamespaceEnabled(namespace)"
              >
                <span class="box" [class.checked]="kube.isNamespaceEnabled(namespace)">
                  @if (kube.isNamespaceEnabled(namespace)) {
                    <app-icon name="check" [size]="11" />
                  }
                </span>
                <span class="truncate">{{ namespace }}</span>
              </button>
              @if (kube.isNamespaceRemovable(namespace)) {
                <button
                  type="button"
                  class="icon-btn icon-btn-xs icon-btn-plain danger"
                  [attr.aria-label]="'Remove ' + namespace + ' from the known list'"
                  title="Remove from the list — the namespace itself is untouched"
                  (click)="kube.removeKnownNamespace(namespace)"
                >
                  <app-icon name="trash" [size]="12" />
                </button>
              } @else if (kube.isNamespaceDiscovered(namespace)) {
                <span class="tag muted" title="Discovered from the cluster — cannot be removed">
                  discovered
                </span>
              } @else {
                <span class="tag muted" title="The context default — always kept">default</span>
              }
            </div>
          } @empty {
            <p class="hint muted">No namespace matches.</p>
          }
        </div>

        <form class="add" (submit)="submit($event)">
          <input
            #draftInput
            class="input"
            name="namespace"
            placeholder="add a namespace"
            autocomplete="off"
            [value]="$draft()"
            (input)="$draft.set(draftInput.value)"
          />
          <button type="submit" class="btn btn-primary" [disabled]="$busy() || !$draft().trim()">
            {{ $busy() ? 'Probing…' : 'Probe and add' }}
          </button>
        </form>
        <p class="hint muted">Validated with a pod list — retried once before it fails.</p>
      </div>
    }
  `,
  styles: `
    /* The gear is a sibling of the scrolling strip: it keeps its place — and its alignment with
       the chips — however many namespaces are known. */
    :host {
      position: relative;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: var(--sp-3);
    }

    .chips {
      /* Shrinks and scrolls when the namespaces overflow, but never grows past them: the gear
         stays right next to the last chip. */
      flex: 0 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .chips::-webkit-scrollbar {
      display: none;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-1);
      height: var(--chip-height);
      padding: 0 var(--sp-4);
      border: 1px solid var(--accent);
      border-radius: var(--radius-full);
      background: var(--accent-bg);
      color: var(--accent);
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      white-space: nowrap;
      cursor: pointer;
    }

    .chip.off {
      border-style: dashed;
      border-color: var(--border-input);
      background: transparent;
      color: var(--fg-muted);
      font-weight: var(--fw-normal);
    }

    .chip.off:hover {
      border-color: var(--border-hover);
      background: var(--hover);
    }

    .none {
      font-size: var(--fs-xs);
      white-space: nowrap;
    }

    /* --icon-btn-sm matches --chip-height, so the gear is the same box as the chips it sits
       next to; hover and focus come from the global .icon-btn. */
    .manage {
      align-self: center;
    }

    .panel {
      top: 34px;
      left: 0;
      width: 300px;
      display: grid;
      gap: var(--sp-4);
    }

    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--sp-4);
    }

    h2 {
      margin: 0;
      font-size: var(--fs-md);
    }

    .count {
      font-size: var(--fs-xs);
    }

    .notice {
      display: flex;
      gap: var(--sp-3);
      margin: 0;
      padding: var(--sp-3) var(--sp-4);
      border: 1px solid var(--warning-border);
      border-radius: var(--radius-sm);
      background: var(--warning-bg);
      color: var(--warning-fg);
      font-size: var(--fs-xs);
    }

    .bulk {
      display: flex;
      gap: var(--sp-3);
    }

    .list {
      max-height: 260px;
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

    .tag {
      padding: 0 var(--sp-2);
      font-size: var(--fs-2xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .add {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--sp-3);
    }

    .hint {
      margin: 0;
      font-size: var(--fs-xs);
    }
  `,
})
export class NamespacePickerComponent {
  protected readonly kube = inject(KubeStateService);
  readonly #shortcuts = inject(ShortcutsService);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly $search = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly $open = signal(false);
  protected readonly $query = signal('');
  protected readonly $draft = signal('');
  protected readonly $busy = signal(false);

  protected readonly $matches = computed(() => {
    const query = this.$query().trim().toLowerCase();
    const known = this.kube.$knownNamespaces();
    return query ? known.filter((item) => item.includes(query)) : known;
  });

  protected readonly $noticeText = computed(() => {
    const notice = this.kube.$namespaceNotice();
    return notice
      ? describeError(notice)
      : 'Namespaces cannot be listed — add the ones you need by hand.';
  });

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

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const namespace = this.$draft().trim();
    if (!namespace) {
      return;
    }
    this.$busy.set(true);
    const result = await this.kube.addNamespace(namespace);
    this.$busy.set(false);
    if (result.ok) {
      this.$draft.set('');
    }
  }
}
