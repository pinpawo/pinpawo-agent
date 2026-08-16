import { createBrowserIntegration } from '@pinpawo-toolkit/browser';
import { getConfig } from './config';
import { loadStoredConfig } from './storage';

export const browserIntegration = createBrowserIntegration({
  enabled: () => loadStoredConfig().capabilities?.browser !== false,
  backend: () => getConfig().browserBackend,
});
