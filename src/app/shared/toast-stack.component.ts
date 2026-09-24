import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { IconComponent } from './icon.component';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-toast-stack',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @for (toast of toasts.$toasts(); track toast.id) {
      <div class="toast" [class]="toast.tone">
        <app-icon
          [name]="toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'ok' : 'info'"
          [size]="16"
        />
        <div class="body">
          <strong>{{ toast.title }}</strong>
          @if (toast.detail) {
            <span class="detail selectable">{{ toast.detail }}</span>
          }
          @if (toast.action; as action) {
            <button type="button" class="btn btn-sm action" (click)="toasts.run(toast)">
              {{ action.label }}
            </button>
          }
        </div>
        <button
          type="button"
          class="icon-btn icon-btn-bare icon-btn-plain dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          (click)="toasts.dismiss(toast.id)"
        >
          <app-icon name="close" [size]="13" />
        </button>
      </div>
    }
  `,
  styles: `
    :host {
      position: fixed;
      right: var(--sp-8);
      bottom: 42px;
      z-index: 40;
      display: grid;
      gap: var(--sp-4);
      width: min(420px, calc(100vw - 32px));
    }

    .toast {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: start;
      gap: var(--sp-4);
      padding: var(--sp-6) var(--sp-8);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      box-shadow: var(--shadow-md);
      font-size: var(--fs-sm);
    }

    .toast.error {
      border-color: var(--error-border);
      background: var(--error-bg);
      color: var(--error-fg);
    }

    .toast.success {
      border-color: var(--success-border);
      background: var(--success-bg);
      color: var(--success-fg);
    }

    .toast.info {
      border-color: var(--info-border);
      background: var(--info-bg);
      color: var(--info-fg);
    }

    /* The tone icon only — the dismiss button's icon is centred by .icon-btn. */
    .toast > app-icon {
      margin-top: 2px;
    }

    .body {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .detail {
      opacity: 0.85;
      overflow-wrap: anywhere;
    }

    .action {
      justify-self: start;
      margin-top: var(--sp-2);
      color: var(--fg);
    }

    .dismiss {
      align-self: start;
      color: inherit;
      opacity: 0.7;
    }

    .dismiss:hover:not(:disabled) {
      background: transparent;
      color: inherit;
      opacity: 1;
    }
  `,
})
export class ToastStackComponent {
  protected readonly toasts = inject(ToastService);
}
