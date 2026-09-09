import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { DrawerResize } from './drawer-resize';

/**
 * The drag affordance on a drawer's left edge. Sits out of the drawer's grid flow, driven by the
 * `DrawerResize` its drawer owns — one definition of the handle for every drawer.
 */
@Component({
  selector: 'app-drawer-handle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize the drawer — double-click to reset',
    title: 'Drag to resize — double-click to reset',
    tabindex: '0',
    '[attr.aria-valuenow]': '$resize().$width()',
    '[attr.aria-valuemin]': '$resize().bounds.min',
    '(pointerdown)': '$resize().onResizeStart($event)',
    '(pointermove)': '$resize().onResizeMove($event)',
    '(pointerup)': '$resize().onResizeEnd()',
    '(pointercancel)': '$resize().onResizeEnd()',
    '(lostpointercapture)': '$resize().onResizeEnd()',
    '(dblclick)': '$resize().reset()',
    '(keydown)': '$resize().onResizeKeydown($event)',
  },
  styles: `
    :host {
      position: absolute;
      top: 0;
      bottom: 0;
      left: -3px;
      z-index: 1;
      width: 7px;
      cursor: col-resize;
      touch-action: none;
    }

    :host::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 3px;
      width: 1px;
      background: transparent;
      transition: background var(--transition);
    }

    :host(:hover)::after,
    :host(:focus-visible)::after {
      background: var(--accent);
    }

    :host(:focus-visible) {
      outline: none;
    }
  `,
})
export class DrawerHandleComponent {
  readonly $resize = input.required<DrawerResize>({ alias: 'resize' });
}
