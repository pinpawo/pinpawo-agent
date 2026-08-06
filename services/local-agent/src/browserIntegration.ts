import { createBrowserIntegration } from '@pinpawo-toolkit/browser';
import { getConfig } from './config';
import { loadStoredConfig } from './storage';
import { getLocalToolsWorkdir } from './toolkits/local/pathUtils';

export const browserIntegration = createBrowserIntegration({
  enabled: () => loadStoredConfig().capabilities?.browser !== false,
  backend: () => getConfig().browserBackend,
  workdir: getLocalToolsWorkdir,
});
