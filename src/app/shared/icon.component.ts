import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';

import { ICONS, IconName } from './icons';

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  template: `<svg [lucideIcon]="$icon()" [size]="$size()" [strokeWidth]="2"></svg>`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
  `,
})
export class IconComponent {
  readonly $name = input.required<IconName>({ alias: 'name' });
  readonly $size = input(16, { alias: 'size' });

  protected readonly $icon = computed(() => ICONS[this.$name()]);
}
