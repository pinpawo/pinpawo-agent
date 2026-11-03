import { basename, dirname } from 'node:path';
import type { ArtifactStore } from '@pinpawo-toolkit/artifacts';
import { FileArtifactStore } from './artifactStore';
import { CosArtifactStore } from './cosArtifactStore';
import { loadStoredConfig, type StoredConfig } from './storage';
import type { HostRuntimeConfig } from './config/runtimeConfig';

/** Host-owned adapter selection; credentials come only from global config or env. */
export function createHostArtifactStore(
  runtime: Pick<HostRuntimeConfig, 'sessionRoot'>,
  options: { stored?: Pick<StoredConfig, 'artifacts'>; env?: NodeJS.ProcessEnv } = {},
): ArtifactStore {
  const env = options.env ?? process.env;
  const configured = (options.stored ?? loadStoredConfig()).artifacts;
  const adapter = env.PINPAWO_ARTIFACTS_ADAPTER?.trim() || configured?.adapter || 'local';
  const workspaceId = basename(runtime.sessionRoot);
  if (adapter === 'local') return new FileArtifactStore(dirname(runtime.sessionRoot), workspaceId);
  if (adapter !== 'cos') throw new Error('Artifact adapter must be local or cos.');
  const value = (name: string, stored: unknown, required = false) => {
    if (stored !== undefined && typeof stored !== 'string') {
      throw new Error(`COS artifact config ${name.toLowerCase()} must be a string.`);
    }
    const selected = env[`PINPAWO_ARTIFACTS_COS_${name}`]?.trim() || stored?.trim();
    if (required && !selected) throw new Error(`COS artifacts require ${name.toLowerCase()}.`);
    return selected;
  };
  const cos = configured?.adapter === 'cos' ? configured : undefined;
  return new CosArtifactStore({
    workspaceId,
    bucket: value('BUCKET', cos?.bucket, true)!,
    region: value('REGION', cos?.region, true)!,
    secretId: value('SECRET_ID', cos?.secretId, true)!,
    secretKey: value('SECRET_KEY', cos?.secretKey, true)!,
    ...(value('PREFIX', cos?.prefix) ? { prefix: value('PREFIX', cos?.prefix) } : {}),
    ...(value('SECURITY_TOKEN', cos?.securityToken) ? { securityToken: value('SECURITY_TOKEN', cos?.securityToken) } : {}),
  });
}
