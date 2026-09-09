import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { ColumnSizing } from './column-sizing';

/**
 * The drag affordance on a header cell's right edge. Lives inside a `.head-cell` (positioned) and
 * drives its table's `ColumnSizing` — one definition of the handle for every resizable table.
 */
@Component({
  selector: 'app-column-handle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    role: 'separator',
    'aria-orientation': 'vertical',
    tabindex: '0',
    title: 'Drag to resize — double-click to reset',
    '[attr.aria-label]': "'Resize the ' + $label() + ' column — double-click to reset'",
    '[attr.aria-valuenow]': '$sizing().widthOf($column())',
    '(pointerdown)': '$sizing().onResizeStart($event, $column())',
    '(pointermove)': '$sizing().onResizeMove($event)',
    '(pointerup)': '$sizing().onResizeEnd()',
    '(pointercancel)': '$sizing().onResizeEnd()',
    '(lostpointercapture)': '$sizing().onResizeEnd()',
    '(dblclick)': '$sizing().reset($event, $column())',
    '(keydown)': '$sizing().onResizeKeydown($event, $column())',
    '(click)': '$event.stopPropagation()',
  },
  styles: `
    /* Inside its own cell, never straddling the edge: grid items paint atomically, so anything
       hanging over the next column would be covered by that column's own header button. */
    :host {
      position: absolute;
      top: 0;
      bottom: 0;
      right: 0;
      z-index: 3;
      width: 10px;
      cursor: col-resize;
      touch-action: none;
    }

    :host::after {
      content: '';
      position: absolute;
      top: 20%;
      bottom: 20%;
      right: 0;
      width: 1px;
      background: var(--border);
      transition: background var(--transition);
    }

    :host(:hover)::after,
    :host(:focus-visible)::after {
      top: 0;
      bottom: 0;
      background: var(--accent);
    }

    :host(:focus-visible) {
      outline: none;
    }
  `,
})
export class ColumnHandleComponent {
  readonly $sizing = input.required<ColumnSizing>({ alias: 'sizing' });
  readonly $column = input.required<string>({ alias: 'column' });
  readonly $label = input.required<string>({ alias: 'label' });
}
