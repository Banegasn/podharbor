import { Injectable, signal } from '@angular/core';

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Context the action runs against — always named in the dialog. */
  context: string;
  confirmLabel: string;
  /** Red treatment: destructive action, or a production-looking context. */
  danger: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly #$request = signal<ConfirmRequest | null>(null);
  readonly $request = this.#$request.asReadonly();
  #resolve: ((confirmed: boolean) => void) | null = null;

  ask(request: ConfirmRequest): Promise<boolean> {
    this.#resolve?.(false);
    this.#$request.set(request);
    return new Promise<boolean>((resolve) => {
      this.#resolve = resolve;
    });
  }

  settle(confirmed: boolean): void {
    this.#$request.set(null);
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(confirmed);
  }
}
