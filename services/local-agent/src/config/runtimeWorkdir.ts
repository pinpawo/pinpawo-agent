import { realpathSync } from 'node:fs';
import { setConfig } from './config';
import { buildLocalAgentRuntimeConfig, buildWorkspaceRuntimeConfig, type LocalAgentRuntimeConfig } from './runtimeConfig';

export function applyRuntimeWorkdir(workdir?: string): LocalAgentRuntimeConfig {
  const initialRuntimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const runtimeConfig = buildWorkspaceRuntimeConfig({
    workdir: realpathSync(initialRuntimeConfig.workdir),
  });
  process.chdir(runtimeConfig.workdir);
  setConfig({ workdir: runtimeConfig.workdir });
  return runtimeConfig;
}
