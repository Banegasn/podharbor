import { Signal, computed, signal } from '@angular/core';

import { PrefsService } from '../core/prefs.service';

/** One resizable column of a `.grid-table`. */
export interface ColumnSpec<K extends string = string> {
  key: K;
  label: string;
  /** Preferred width in px. Raised to the header's own minimum when the label needs more. */
  width?: number;
  /** Content floor on top of the header minimum (a status pill, a `ready/desired` pair…). */
  min?: number;
  /** The column that soaks up the leftover width — until the user drags it to a fixed size. */
  grow?: boolean;
}

/** A spec with its defaults filled in — extra fields of the caller's spec survive. */
type ResolvedColumn<S extends ColumnSpec> = S & {
  /** Never clips the header label or its sort icon. */
  min: number;
  width: number;
  grow: boolean;
};

/** One arrow key press on a resize handle. */
const KEYBOARD_STEP = 16;
const MAX_WIDTH = 960;
/** Head cell chrome around the label: padding both sides, the gap, the sort icon, a little slack. */
const HEAD_CHROME = 39;
/** Fallback when no canvas is available (SSR, a locked-down WebView): Inter caps at 12px. */
const HEAD_CHAR_WIDTH = 7.4;
const HEAD_FONT = "700 12px Inter, ui-sans-serif, system-ui, 'Segoe UI', sans-serif";
const HEAD_LETTER_SPACING = 0.24;

let measureContext: CanvasRenderingContext2D | null | undefined;

/**
 * Width the header cell needs to show `label` in full, sort icon included. Measured with the real
 * font metrics so no column can start out clipped, whatever the label.
 */
export function headerMinWidth(label: string): number {
  const text = label.toUpperCase();
  const context = headMeasureContext();
  const measured = context
    ? context.measureText(text).width + text.length * HEAD_LETTER_SPACING
    : text.length * HEAD_CHAR_WIDTH;
  return Math.ceil(measured) + HEAD_CHROME;
}

function headMeasureContext(): CanvasRenderingContext2D | null {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
    if (measureContext) {
      measureContext.font = HEAD_FONT;
    }
  }
  return measureContext;
}

/**
 * Column widths of one table: the `grid-template-columns` it renders with, plus the drag, keyboard
 * and reset behaviour of the handles on the header cells' right edge.
 *
 * Widths are persisted per table in prefs and read back through a signal, so a resize survives a
 * reload and the header and every row stay on the same template. A column the user never touched
 * keeps its computed default — which is at least what its header label measures, so the initial
 * layout never clips a label. The `grow` column takes the leftover width until it is dragged, at
 * which point it becomes fixed like the others.
 *
 * Not an injectable: a table component owns one as a plain field (`new ColumnSizing(…)`).
 */
export class ColumnSizing<S extends ColumnSpec = ColumnSpec> {
  readonly columns: ResolvedColumn<S>[];
  readonly $template: Signal<string>;

  /** Width while a handle is held — `null` when the persisted widths are what render. */
  readonly #$drag = signal<{ key: S['key']; width: number } | null>(null);
  /** Viewport x of the resized cell's left edge, captured on pointer down. */
  #anchor = 0;

  constructor(
    private readonly table: string,
    specs: S[],
    private readonly prefs: PrefsService,
    /** Fixed track before the columns (the checkbox / chevron gutter). */
    private readonly leading = '',
    /** Fixed track after them (the row actions). */
    private readonly trailing = '',
  ) {
    this.columns = specs.map((spec) => {
      const min = Math.max(headerMinWidth(spec.label), spec.min ?? 0);
      return { ...spec, min, width: Math.max(spec.width ?? min, min), grow: spec.grow ?? false };
    });

    this.$template = computed(() => {
      const stored = this.prefs.columnWidthsFor(this.table);
      const drag = this.#$drag();
      const tracks = this.columns.map((column) => {
        const width = drag?.key === column.key ? drag.width : stored[column.key];
        if (width === undefined) {
          return column.grow ? `minmax(${column.min}px, 1fr)` : `${column.width}px`;
        }
        return `${clamp(width, column.min)}px`;
      });
      return [this.leading, ...tracks, this.trailing].filter(Boolean).join(' ');
    });
  }

  /** Live width of a column, for the handle's `aria-valuenow`. */
  widthOf(key: S['key']): number {
    const column = this.columns.find((item) => item.key === key);
    if (!column) {
      return 0;
    }
    const drag = this.#$drag();
    const width = drag?.key === key ? drag.width : this.prefs.columnWidthsFor(this.table)[key];
    return Math.round(width === undefined ? column.width : clamp(width, column.min));
  }

  onResizeStart(event: PointerEvent, key: S['key']): void {
    const cell = (event.target as HTMLElement).closest('.head-cell');
    if (!cell) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.#anchor = cell.getBoundingClientRect().left;
    const column = this.columns.find((item) => item.key === key);
    this.#$drag.set({ key, width: cell.getBoundingClientRect().width || (column?.width ?? 0) });
    document.body.classList.add('is-resizing');
    try {
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // No capture (synthetic pointers): the drag ends when the pointer leaves the handle.
    }
  }

  onResizeMove(event: PointerEvent): void {
    const drag = this.#$drag();
    if (!drag) {
      return;
    }
    const column = this.columns.find((item) => item.key === drag.key);
    this.#$drag.set({
      key: drag.key,
      width: clamp(event.clientX - this.#anchor, column?.min ?? 0),
    });
  }

  /** Persisted on release only: prefs write to `localStorage` on every change. */
  onResizeEnd(): void {
    const drag = this.#$drag();
    document.body.classList.remove('is-resizing');
    if (!drag) {
      return;
    }
    this.#$drag.set(null);
    this.prefs.setColumnWidth(this.table, drag.key, Math.round(drag.width));
  }

  onResizeKeydown(event: KeyboardEvent, key: S['key']): void {
    const step =
      event.key === 'ArrowRight' ? KEYBOARD_STEP : event.key === 'ArrowLeft' ? -KEYBOARD_STEP : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const column = this.columns.find((item) => item.key === key);
    this.prefs.setColumnWidth(this.table, key, clamp(this.widthOf(key) + step, column?.min ?? 0));
  }

  /** Double-click: back to the computed default (the `grow` column back to soaking up the rest). */
  reset(event: Event, key: S['key']): void {
    event.preventDefault();
    event.stopPropagation();
    this.#$drag.set(null);
    document.body.classList.remove('is-resizing');
    this.prefs.clearColumnWidth(this.table, key);
  }
}

function clamp(width: number, min: number): number {
  return Math.min(Math.max(width, min), MAX_WIDTH);
}
