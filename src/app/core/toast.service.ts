import { Injectable, signal } from '@angular/core';

import { AppError, describeError } from './models';

export type ToastTone = 'info' | 'success' | 'error';

/** One secondary action rendered inside the toast — e.g. "Add anyway" after a failed probe. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
  action?: ToastAction;
}

const DISMISS_AFTER_MS = 7000;
/** An actionable toast has to survive long enough to be clicked. */
const ACTION_DISMISS_AFTER_MS = 20000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly #$toasts = signal<Toast[]>([]);
  readonly $toasts = this.#$toasts.asReadonly();
  #sequence = 0;

  info(title: string, detail?: string): void {
    this.#push('info', title, detail);
  }

  success(title: string, detail?: string): void {
    this.#push('success', title, detail);
  }

  error(title: string, detail?: string, action?: ToastAction): void {
    this.#push('error', title, detail, action);
  }

  failure(title: string, error: AppError, action?: ToastAction): void {
    this.#push('error', title, describeError(error), action);
  }

  dismiss(id: number): void {
    this.#$toasts.update((toasts) => toasts.filter((toast) => toast.id !== id));
  }

  /** The toast goes away as soon as its action fires. */
  run(toast: Toast): void {
    this.dismiss(toast.id);
    toast.action?.run();
  }

  #push(tone: ToastTone, title: string, detail?: string, action?: ToastAction): void {
    const id = ++this.#sequence;
    this.#$toasts.update((toasts) => [...toasts, { id, tone, title, detail, action }]);
    setTimeout(() => this.dismiss(id), action ? ACTION_DISMISS_AFTER_MS : DISMISS_AFTER_MS);
  }
}
