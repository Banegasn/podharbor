import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { AppHeaderComponent } from './shell/app-header.component';
import { ConfirmDialogComponent } from './shared/confirm-dialog.component';
import { KubeStateService } from './core/kube-state.service';
import { LogsService } from './core/logs.service';
import { LogsViewComponent } from './logs/logs-view.component';
import { PodsTableComponent } from './pods/pods-table.component';
import { PrefsService } from './core/prefs.service';
import { ShortcutsService } from './core/shortcuts.service';
import { StatusBarComponent } from './shell/status-bar.component';
import { ThemeService } from './core/theme.service';
import { ToastStackComponent } from './shared/toast-stack.component';
import { WorkloadsTableComponent } from './workloads/workloads-table.component';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppHeaderComponent,
    ConfirmDialogComponent,
    LogsViewComponent,
    PodsTableComponent,
    StatusBarComponent,
    ToastStackComponent,
    WorkloadsTableComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class App {
  protected readonly prefs = inject(PrefsService);
  readonly #kube = inject(KubeStateService);
  readonly #logs = inject(LogsService);
  readonly #shortcuts = inject(ShortcutsService);

  constructor() {
    inject(ThemeService);
    void this.#kube.init();
  }

  onKeydown(event: KeyboardEvent): void {
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.#shortcuts.focusFilter();
      return;
    }
    if (command && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      void this.#kube.refresh();
      return;
    }
    if (command && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      this.#logs.clear();
      return;
    }
    if (event.key === 'Escape') {
      this.#shortcuts.escape();
    }
  }
}
