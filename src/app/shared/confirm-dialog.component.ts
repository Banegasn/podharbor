import { ChangeDetectionStrategy, Component, effect, inject, untracked } from '@angular/core';

import { ConfirmService } from '../core/confirm.service';
import { ShortcutsService } from '../core/shortcuts.service';

@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (confirm.$request(); as request) {
      <div class="backdrop" (click)="confirm.settle(false)"></div>
      <div class="dialog" [class.danger]="request.danger" role="dialog" aria-modal="true">
        <h2>{{ request.title }}</h2>
        <p class="message selectable">{{ request.message }}</p>
        <p class="context">
          Context <strong>{{ request.context }}</strong>
        </p>
        <div class="actions">
          <button type="button" class="btn" (click)="confirm.settle(false)">Cancel</button>
          <button
            type="button"
            class="btn"
            [class.btn-danger]="request.danger"
            [class.btn-primary]="!request.danger"
            (click)="confirm.settle(true)"
          >
            {{ request.confirmLabel }}
          </button>
        </div>
      </div>
    }
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 50;
      background: rgba(8, 20, 27, 0.48);
      backdrop-filter: blur(3px);
    }

    .dialog {
      position: fixed;
      z-index: 51;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(460px, 90vw);
      display: grid;
      gap: var(--sp-6);
      padding: var(--sp-10);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      box-shadow: var(--shadow-lg);
    }

    .dialog.danger {
      border-color: var(--error-border);
      border-top: 4px solid var(--error-fg);
    }

    h2 {
      margin: 0;
      font-size: var(--fs-lg);
      letter-spacing: -0.025em;
    }

    .message {
      margin: 0;
      color: var(--fg-muted);
      overflow-wrap: anywhere;
    }

    .context {
      margin: 0;
      padding: var(--sp-3) var(--sp-4);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-sm);
      background: var(--subtle);
      font-size: var(--fs-sm);
    }

    .dialog.danger .context {
      border-color: var(--error-border);
      background: var(--error-bg);
      color: var(--error-fg);
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--sp-4);
      margin-top: var(--sp-2);
    }

    .dialog.danger .actions .btn-danger {
      border-color: var(--error-fg);
      background: var(--error-fg);
      color: var(--surface);
    }

    .dialog.danger .actions .btn-danger:hover {
      filter: brightness(1.08);
      background: var(--error-fg);
    }
  `,
})
export class ConfirmDialogComponent {
  protected readonly confirm = inject(ConfirmService);
  readonly #shortcuts = inject(ShortcutsService);

  constructor() {
    effect(() => {
      const tick = this.#shortcuts.$escape();
      if (tick > 0 && untracked(() => this.confirm.$request() !== null)) {
        this.confirm.settle(false);
      }
    });
  }
}
