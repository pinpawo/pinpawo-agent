import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { atomicWriteHostFile } from './atomicFile';
import type { StoredConfig } from '../storage';

/** Existing configuration domain; no credential copies or new configuration file. */
export interface HostConfigurationPort {
  readConfiguration(): StoredConfig;
  replaceConfiguration(config: StoredConfig): void;
}
export const HOST_CONFIGURATION_PATH = resolve(homedir(), '.pinpawo', 'config.json');
export function createFileHostConfiguration(filePath: string): HostConfigurationPort {
  return {
    readConfiguration: () => {
      if (!existsSync(filePath)) return {};
      const value = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Host configuration.');
      return value as StoredConfig;
    },
    replaceConfiguration: config => {
      atomicWriteHostFile(filePath, JSON.stringify(config, null, 2));
    },
  };
}
export const hostConfiguration = createFileHostConfiguration(HOST_CONFIGURATION_PATH);
