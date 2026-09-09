import { Injectable, signal } from '@angular/core';

/** Shared "now", so relative ages refresh without every table owning a timer. */
@Injectable({ providedIn: 'root' })
export class ClockService {
  readonly #$now = signal(Date.now());
  readonly $now = this.#$now.asReadonly();

  constructor() {
    setInterval(() => this.#$now.set(Date.now()), 10000);
  }
}
