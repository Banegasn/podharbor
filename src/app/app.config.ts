import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';

import { KubeBackend, isTauriRuntime } from './core/kube-backend';
import { MockBackend } from './core/mock-backend.service';
import { TauriBackend } from './core/tauri.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Outside the Tauri window `invoke` does not exist: serve demo data so `pnpm dev` is usable.
    { provide: KubeBackend, useClass: isTauriRuntime() ? TauriBackend : MockBackend },
  ],
};
