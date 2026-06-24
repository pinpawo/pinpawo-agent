import { realpathSync } from 'node:fs';
import { config } from './config';
import { buildLocalAgentRuntimeConfig, type LocalAgentRuntimeConfig } from './runtimeConfig';
import { setLocalToolsWorkdir } from './toolkits/local/pathUtils';

export function applyRuntimeWorkdir(workdir?: string): LocalAgentRuntimeConfig {
  const initialRuntimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const runtimeConfig = buildLocalAgentRuntimeConfig(realpathSync(initialRuntimeConfig.workdir));
  process.chdir(runtimeConfig.workdir);
  config.workdir = runtimeConfig.workdir;
  setLocalToolsWorkdir(runtimeConfig.workdir);
  return runtimeConfig;
}
