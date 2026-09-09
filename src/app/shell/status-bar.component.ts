import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import { IconComponent } from '../shared/icon.component';
import { KubeBackend } from '../core/kube-backend';
import { KubeStateService } from '../core/kube-state.service';
import { LogsService } from '../core/logs.service';
import { describeError } from '../core/models';
import { formatDateTime } from '../core/format';

@Component({
  selector: 'app-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { '(document:pointerdown)': 'onOutside($event)' },
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.scss',
})
export class StatusBarComponent {
  protected readonly kube = inject(KubeStateService);
  protected readonly logs = inject(LogsService);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly #backend = inject(KubeBackend);

  protected readonly $diagnosticsOpen = signal(false);
  protected readonly $errorsOpen = signal(false);

  protected readonly $fetchedAtLabel = computed(() => {
    const fetchedAt = this.kube.$fetchedAt();
    return fetchedAt ? formatDateTime(fetchedAt) : 'never';
  });

  protected readonly $globalError = computed(() => {
    const error = this.kube.$error();
    return error ? describeError(error) : null;
  });

  toggleDiagnostics(): void {
    this.$errorsOpen.set(false);
    this.$diagnosticsOpen.update((open) => !open);
    if (this.$diagnosticsOpen()) {
      void this.kube.loadEnvironment();
    }
  }

  toggleErrors(): void {
    this.$diagnosticsOpen.set(false);
    this.$errorsOpen.update((open) => !open);
  }

  openDevtools(): void {
    void this.#backend.openDevtools();
  }

  onOutside(event: Event): void {
    if (this.#host.nativeElement.contains(event.target as Node)) {
      return;
    }
    this.$diagnosticsOpen.set(false);
    this.$errorsOpen.set(false);
  }

  describe = describeError;
}
