import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { atomicWriteHostFile, readOptionalHostFile } from './atomicFile';
import type { StoredConfig } from '../storage';

/** Existing configuration domain; no credential copies or new configuration file. */
export interface HostConfigurationPort {
  readConfiguration(): Promise<StoredConfig>;
  replaceConfiguration(config: StoredConfig): Promise<void>;
}
export const HOST_CONFIGURATION_PATH = resolve(homedir(), '.pinpawo', 'config.json');
export function createFileHostConfiguration(filePath: string): HostConfigurationPort {
  return {
    readConfiguration: async () => {
      const text = await readOptionalHostFile(filePath);
      if (text === null) return {};
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Host configuration.');
      return value as StoredConfig;
    },
    replaceConfiguration: async config => {
      await atomicWriteHostFile(filePath, JSON.stringify(config, null, 2));
    },
  };
}
export const hostConfiguration = createFileHostConfiguration(HOST_CONFIGURATION_PATH);
