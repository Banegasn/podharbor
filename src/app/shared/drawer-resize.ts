import { DestroyRef, ElementRef, Signal, computed, effect, inject, signal } from '@angular/core';

import { DRAWER_WIDTH, PrefsService } from '../core/prefs.service';

/** One arrow key press on the drag handle. */
const KEYBOARD_STEP = 16;

export interface DrawerResize {
  /** Width that renders: the drag in progress, else the persisted preference, always clamped. */
  readonly $width: Signal<number>;
  readonly bounds: typeof DRAWER_WIDTH;
  onViewportResize(): void;
  onResizeStart(event: PointerEvent): void;
  onResizeMove(event: PointerEvent): void;
  onResizeEnd(): void;
  onResizeKeydown(event: KeyboardEvent): void;
  reset(): void;
}

/**
 * Drag-to-resize for a right-hand drawer, shared by the single-pod details and the multi-selection
 * summary: same handle, same bounds, same persisted `drawerWidth`, so switching between the two
 * never changes the width under the user.
 *
 * Call it from a component's field initialiser or constructor — it injects the host element, prefs
 * and `DestroyRef` from the current injection context. The width is written straight to the host
 * element instead of through a host binding: a host binding is evaluated in the *parent's* view,
 * which a drag inside the drawer never marks dirty.
 */
export function createDrawerResize(): DrawerResize {
  const prefs = inject(PrefsService);
  const host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Width while the handle is held; `null` when the persisted preference is what shows. */
  const $dragWidth = signal<number | null>(null);
  const $viewportWidth = signal(viewportWidth());
  const $width = computed(() => clampWidth($dragWidth() ?? prefs.$drawerWidth(), $viewportWidth()));

  /** Viewport x of the drawer's right edge, captured on pointer down: width = right − pointer. */
  let anchor = 0;

  effect(() => {
    host.nativeElement.style.width = `${$width()}px`;
  });

  // A drawer closed mid-drag must not leave the whole window stuck in resize mode.
  inject(DestroyRef).onDestroy(() => document.body.classList.remove('is-resizing'));

  return {
    $width,
    bounds: DRAWER_WIDTH,

    onViewportResize(): void {
      $viewportWidth.set(viewportWidth());
    },

    onResizeStart(event: PointerEvent): void {
      event.preventDefault();
      anchor = host.nativeElement.getBoundingClientRect().right;
      $dragWidth.set($width());
      document.body.classList.add('is-resizing');
      try {
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // No capture (synthetic pointers): the drag then ends when the pointer leaves the handle.
      }
    },

    onResizeMove(event: PointerEvent): void {
      if ($dragWidth() === null) {
        return;
      }
      $dragWidth.set(clampWidth(anchor - event.clientX, viewportWidth()));
    },

    /** Persisted only on release: prefs write to `localStorage` on every change. */
    onResizeEnd(): void {
      const width = $dragWidth();
      document.body.classList.remove('is-resizing');
      if (width === null) {
        return;
      }
      $dragWidth.set(null);
      prefs.patch({ drawerWidth: Math.round(width) });
    },

    onResizeKeydown(event: KeyboardEvent): void {
      const step =
        event.key === 'ArrowLeft' ? KEYBOARD_STEP : event.key === 'ArrowRight' ? -KEYBOARD_STEP : 0;
      if (step === 0) {
        return;
      }
      event.preventDefault();
      prefs.patch({ drawerWidth: Math.round(clampWidth($width() + step, viewportWidth())) });
    },

    reset(): void {
      $dragWidth.set(null);
      prefs.patch({ drawerWidth: DRAWER_WIDTH.default });
    },
  };
}

function viewportWidth(): number {
  return window.innerWidth || DRAWER_WIDTH.default;
}

/** Never wider than 80% of the window: the drawer gives way before the layout does. */
function clampWidth(width: number, viewport: number): number {
  const max = Math.max(DRAWER_WIDTH.min, viewport * DRAWER_WIDTH.maxViewportRatio);
  return Math.min(Math.max(width, DRAWER_WIDTH.min), max);
}
