import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { IconComponent } from '../shared/icon.component';
import { KubeStateService } from '../core/kube-state.service';
import { NamespacePickerComponent } from './namespace-picker.component';
import { POLL_INTERVALS, PrefsService, ViewTab } from '../core/prefs.service';
import { ThemeService } from '../core/theme.service';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '../core/kube-backend';

/**
 * Elements that own their pointer behaviour. Tauri honours `data-tauri-drag-region` only when the
 * mousedown target *is* the element carrying it, and the header's children cover it edge to edge —
 * hence the handlers below rather than the attribute alone.
 */
const INTERACTIVE =
  'button, input, select, textarea, a, [role="button"], [contenteditable], .no-drag';

@Component({
  selector: 'app-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, NamespacePickerComponent],
  templateUrl: './app-header.component.html',
  styleUrl: './app-header.component.scss',
  host: {
    'data-tauri-drag-region': '',
    '[class.macos-inset]': '$macosInset()',
    '(mousedown)': 'onPointerDown($event)',
    '(dblclick)': 'onDoubleClick($event)',
  },
})
export class AppHeaderComponent {
  protected readonly kube = inject(KubeStateService);
  protected readonly prefs = inject(PrefsService);
  protected readonly theme = inject(ThemeService);

  protected readonly intervals = POLL_INTERVALS;
  protected readonly tabs: { id: ViewTab; label: string; icon: 'pods' | 'workloads' | 'logs' }[] = [
    { id: 'pods', label: 'Pods', icon: 'pods' },
    { id: 'workloads', label: 'Workloads', icon: 'workloads' },
    { id: 'logs', label: 'Logs', icon: 'logs' },
  ];

  /** macOS overlay title bar: leave room for the traffic lights. */
  protected readonly $macosInset = computed(
    () => isTauriRuntime() && navigator.userAgent.includes('Mac'),
  );

  protected readonly $themeIcon = computed(() => {
    const preference = this.theme.$preference();
    return preference === 'light' ? 'sun' : preference === 'dark' ? 'moon' : 'monitor';
  });

  /** Primary button on an inert part of the bar: the OS takes over and moves the window. */
  protected onPointerDown(event: MouseEvent): void {
    if (event.button === 0 && this.#isDragArea(event.target)) {
      void getCurrentWindow()
        .startDragging()
        .catch(() => undefined);
    }
  }

  protected onDoubleClick(event: MouseEvent): void {
    if (this.#isDragArea(event.target)) {
      void getCurrentWindow()
        .toggleMaximize()
        .catch(() => undefined);
    }
  }

  /** No-op in the browser: `getCurrentWindow()` has nothing to talk to outside the Tauri window. */
  #isDragArea(target: EventTarget | null): boolean {
    return isTauriRuntime() && target instanceof Element && !target.closest(INTERACTIVE);
  }

  setView(view: ViewTab): void {
    this.prefs.patch({ view });
  }

  onContextChange(event: Event): void {
    void this.kube.selectContext((event.target as HTMLSelectElement).value);
  }

  onIntervalChange(event: Event): void {
    this.kube.setPollInterval(Number((event.target as HTMLSelectElement).value));
  }

  seconds(interval: number): string {
    return `${interval / 1000}s`;
  }
}
