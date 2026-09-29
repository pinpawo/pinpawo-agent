import { realpathSync } from 'node:fs';
import { setConfig } from './config';
import { buildHostRuntimeConfig, buildWorkspaceRuntimeConfig, type HostRuntimeConfig } from './runtimeConfig';

export function applyRuntimeWorkdir(workdir?: string): HostRuntimeConfig {
  const initialRuntimeConfig = buildHostRuntimeConfig(workdir);
  const runtimeConfig = buildWorkspaceRuntimeConfig({
    workdir: realpathSync(initialRuntimeConfig.workdir),
  });
  process.chdir(runtimeConfig.workdir);
  setConfig({ workdir: runtimeConfig.workdir });
  return runtimeConfig;
}
