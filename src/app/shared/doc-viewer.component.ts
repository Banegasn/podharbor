import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { IconComponent } from './icon.component';
import { ResourceDocument } from '../core/models';
import { ToastService } from '../core/toast.service';

interface DocLine {
  indent: string;
  dash: string;
  key: string;
  value: string;
  raw: string;
}

const YAML_LINE = /^(\s*)(- )?([\w.\-/[\]"']+):(?: (.*))?$/;
const JSON_LINE = /^(\s*)"([^"]+)":\s?(.*)$/;

@Component({
  selector: 'app-doc-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="bar">
      <div class="tabs">
        <button
          type="button"
          class="btn btn-sm"
          [class.is-on]="$format() === 'yaml'"
          (click)="$format.set('yaml')"
        >
          YAML
        </button>
        <button
          type="button"
          class="btn btn-sm"
          [class.is-on]="$format() === 'json'"
          (click)="$format.set('json')"
        >
          JSON
        </button>
      </div>
      <button type="button" class="btn btn-sm" (click)="copy()">
        <app-icon name="copy" [size]="13" />
        Copy
      </button>
    </div>

    @if ($document()) {
      <div class="doc mono selectable">
        @for (line of $lines(); track $index) {
          <div class="line">
            @if (line.key) {
              <span>{{ line.indent }}</span>
              @if (line.dash) {
                <span class="dash">{{ line.dash }}</span>
              }
              <span class="key">{{ line.key }}</span
              ><span class="punct">:</span>
              @if (line.value) {
                <span class="value">{{ line.value }}</span>
              }
            } @else {
              <span class="plain">{{ line.raw }}</span>
            }
          </div>
        }
      </div>
    } @else {
      <p class="empty muted">Loading manifest…</p>
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-height: 0;
    }

    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-4);
      padding-bottom: var(--sp-3);
    }

    .tabs {
      display: flex;
      gap: var(--sp-2);
    }

    .doc {
      overflow: auto;
      padding: var(--sp-4);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-sm);
      background: var(--bg-light);
      font-size: var(--fs-xs);
      line-height: 1.55;
    }

    .line {
      white-space: pre;
    }

    .key {
      color: var(--accent);
    }

    .punct,
    .dash {
      color: var(--fg-muted);
    }

    .value {
      color: var(--fg);
    }

    .plain {
      color: var(--fg-muted);
    }

    .empty {
      padding: var(--sp-4);
    }
  `,
})
export class DocViewerComponent {
  readonly #toasts = inject(ToastService);

  readonly $document = input.required<ResourceDocument | null>({ alias: 'document' });
  readonly $format = signal<'yaml' | 'json'>('yaml');

  protected readonly $text = computed(() => {
    const document = this.$document();
    if (!document) {
      return '';
    }
    return this.$format() === 'yaml' ? document.yaml : document.json;
  });

  protected readonly $lines = computed<DocLine[]>(() => {
    const pattern = this.$format() === 'yaml' ? YAML_LINE : JSON_LINE;
    return this.$text()
      .split('\n')
      .map((raw) => {
        const match = pattern.exec(raw);
        if (!match) {
          return { indent: '', dash: '', key: '', value: '', raw };
        }
        return this.$format() === 'yaml'
          ? { indent: match[1], dash: match[2] ?? '', key: match[3], value: match[4] ?? '', raw }
          : { indent: match[1], dash: '', key: `"${match[2]}"`, value: match[3] ?? '', raw };
      });
  });

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.$text());
      this.#toasts.success('Manifest copied');
    } catch {
      this.#toasts.error('Clipboard unavailable');
    }
  }
}
