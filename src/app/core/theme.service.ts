import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { PrefsService, ThemePref } from './prefs.service';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly #prefs = inject(PrefsService);
  readonly #$systemDark = signal(matchMedia('(prefers-color-scheme: dark)').matches);

  readonly $preference = this.#prefs.$theme;
  readonly $resolved = computed<'light' | 'dark'>(() => {
    const preference = this.$preference();
    if (preference === 'system') {
      return this.#$systemDark() ? 'dark' : 'light';
    }
    return preference;
  });

  constructor() {
    const query = matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', (event) => this.#$systemDark.set(event.matches));

    effect(() => {
      document.documentElement.dataset['theme'] = this.$resolved();
    });
  }

  /** Cycles light → dark → system. */
  cycle(): void {
    const next: Record<ThemePref, ThemePref> = { light: 'dark', dark: 'system', system: 'light' };
    this.#prefs.patch({ theme: next[this.$preference()] });
  }
}
