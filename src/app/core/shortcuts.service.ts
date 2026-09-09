import { Injectable, signal } from '@angular/core';

/**
 * Keyboard shortcuts are captured once in the shell and broadcast as ticks; whichever component is
 * currently rendered reacts to the tick it cares about.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutsService {
  readonly #$focusFilter = signal(0);
  readonly #$escape = signal(0);

  readonly $focusFilter = this.#$focusFilter.asReadonly();
  readonly $escape = this.#$escape.asReadonly();

  focusFilter(): void {
    this.#$focusFilter.update((tick) => tick + 1);
  }

  escape(): void {
    this.#$escape.update((tick) => tick + 1);
  }
}
