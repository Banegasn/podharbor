import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { LogLevelKey, PrefsService } from '../core/prefs.service';
import { LogsService } from '../core/logs.service';

interface LevelChip {
  key: LogLevelKey;
  label: string;
  short: string;
  hint: string;
}

/**
 * Level chips for the log pane in the injector it sits in: the Logs tab reads the root
 * `LogsService`, the pod drawer its own scoped instance. The enabled set itself lives in prefs, so
 * both panes share it and it survives a reload. Counts follow the text filter, not the chips.
 */
@Component({
  selector: 'app-log-level-filter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="levels" role="group" aria-label="Filter lines by level">
      @for (level of levels; track level.key) {
        <button
          type="button"
          class="level"
          [class]="level.key"
          [class.off]="!prefs.isLevelEnabled(level.key)"
          [class.compact]="$compact()"
          [attr.aria-pressed]="prefs.isLevelEnabled(level.key)"
          [title]="
            (prefs.isLevelEnabled(level.key) ? 'Hide ' : 'Show ') + level.label + ' — ' + level.hint
          "
          (click)="prefs.toggleLevel(level.key)"
        >
          <span class="name">{{ $compact() ? level.short : level.label }}</span>
          <span class="count">{{ logs.$levelCounts()[level.key] }}</span>
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    .levels {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
    }

    .level {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-3);
      height: var(--chip-height);
      padding: 0 var(--sp-4);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      background: var(--hover);
      color: var(--fg-muted);
      font-size: var(--fs-2xs);
      font-weight: var(--fw-semibold);
      letter-spacing: 0.04em;
      white-space: nowrap;
      cursor: pointer;
    }

    .level.compact {
      height: var(--icon-btn-sm);
      padding: 0 var(--sp-3);
      gap: var(--sp-2);
    }

    .level.error {
      border-color: var(--error-border);
      background: var(--error-bg);
      color: var(--error-fg);
    }

    .level.warn {
      border-color: var(--warning-border);
      background: var(--warning-bg);
      color: var(--warning-fg);
    }

    .level.info {
      border-color: var(--info-border);
      background: var(--info-bg);
      color: var(--info-fg);
    }

    /* Off chips drop every tone and go dashed — same language as the namespace chips. */
    .level.off {
      border-style: dashed;
      border-color: var(--border-input);
      background: transparent;
      color: var(--fg-muted);
      font-weight: var(--fw-normal);
    }

    .level.off:hover {
      border-color: var(--border-hover);
      background: var(--hover);
    }

    .level:focus-visible {
      outline: none;
      box-shadow: var(--shadow-focus);
    }

    .count {
      font-variant-numeric: tabular-nums;
      font-weight: var(--fw-normal);
      opacity: 0.8;
    }
  `,
})
export class LogLevelFilterComponent {
  protected readonly logs = inject(LogsService);
  protected readonly prefs = inject(PrefsService);

  /** Short labels and a tighter box, for the pod drawer's narrow bar. */
  readonly $compact = input(false, { alias: 'compact' });

  protected readonly levels: LevelChip[] = [
    {
      key: 'error',
      label: 'ERROR',
      short: 'ERR',
      hint: 'ERROR, FATAL, exceptions and their traces',
    },
    { key: 'warn', label: 'WARN', short: 'WRN', hint: 'WARN and WARNING lines' },
    { key: 'info', label: 'INFO', short: 'INF', hint: 'INFO lines' },
    { key: 'debug', label: 'DEBUG', short: 'DBG', hint: 'DEBUG and TRACE lines' },
    { key: 'other', label: 'other', short: 'OTH', hint: 'lines with no recognisable level' },
  ];
}
