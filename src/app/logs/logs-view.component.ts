import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';

import { IconComponent } from '../shared/icon.component';
import { KubeStateService } from '../core/kube-state.service';
import { LOG_BUFFER_CAP, LogsService } from '../core/logs.service';
import { LogLevelFilterComponent } from './log-level-filter.component';
import { LogSourcePickerComponent } from './log-source-picker.component';
import { LogStreamComponent } from './log-stream.component';
import { PrefsService, SINCE_OPTIONS, TAIL_SIZES } from '../core/prefs.service';
import { ShortcutsService } from '../core/shortcuts.service';

@Component({
  selector: 'app-logs-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, LogLevelFilterComponent, LogSourcePickerComponent, LogStreamComponent],
  templateUrl: './logs-view.component.html',
  styleUrl: './logs-view.component.scss',
})
export class LogsViewComponent {
  protected readonly logs = inject(LogsService);
  protected readonly prefs = inject(PrefsService);
  protected readonly kube = inject(KubeStateService);
  readonly #shortcuts = inject(ShortcutsService);

  protected readonly $filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');

  protected readonly tailSizes = TAIL_SIZES;
  protected readonly sinceOptions = SINCE_OPTIONS;
  protected readonly bufferCap = LOG_BUFFER_CAP;

  protected readonly $total = computed(() => this.logs.$filtered().length);

  constructor() {
    effect(() => {
      this.#shortcuts.$focusFilter();
      untracked(() => this.$filterInput()?.nativeElement.focus());
    });
  }

  onTailChange(event: Event): void {
    this.prefs.patch({ tailLines: Number((event.target as HTMLSelectElement).value) });
    void this.logs.restartAll();
  }

  onSinceChange(event: Event): void {
    const raw = (event.target as HTMLSelectElement).value;
    this.prefs.patch({ sinceSeconds: raw === 'null' ? null : Number(raw) });
    void this.logs.restartAll();
  }

  download(): void {
    const blob = new Blob([this.logs.toText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `podharbor-logs-${new Date().toISOString().slice(0, 19)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }
}
