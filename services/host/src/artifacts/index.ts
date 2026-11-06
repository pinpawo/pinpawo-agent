import { basename, dirname } from 'node:path';
import type { ArtifactStore } from '@pinpawo-toolkit/artifacts';
import type { HostRuntimeConfig } from '../config/runtimeConfig';
import { loadStoredConfig, type StoredConfig } from '../storage';
import { createLocalArtifactStore } from './localStore';
import { createCosArtifactStore, type CosArtifactConfig } from './cosStore';

export { createLocalArtifactStore } from './localStore';
export { createCosArtifactStore } from './cosStore';
export { readArtifactSource, writeArtifactDownload } from './files';
export type { ArtifactStore } from '@pinpawo-toolkit/artifacts';
export type ArtifactStorageConfig = { adapter: 'local' } | Omit<CosArtifactConfig, 'secretId' | 'secretKey'> & {
  secretId?: string; secretKey?: string;
};

export function createHostArtifactStore(
  runtimeConfig: HostRuntimeConfig,
  stored: Pick<StoredConfig, 'artifacts'> = loadStoredConfig(),
  env: Record<string, string | undefined> = process.env,
): ArtifactStore {
  const adapter = env.PINPAWO_ARTIFACT_STORE ?? stored.artifacts?.adapter ?? 'local';
  const workspaceId = runtimeConfig.workspace?.id ?? basename(runtimeConfig.sessionRoot);
  if (adapter === 'local') {
    return createLocalArtifactStore({ workspacesDir: dirname(runtimeConfig.sessionRoot), workspaceId });
  }
  if (adapter !== 'cos') throw new Error('Artifact store must be local or cos.');
  const configured = stored.artifacts?.adapter === 'cos' ? stored.artifacts : undefined;
  const bucket = env.PINPAWO_COS_BUCKET ?? configured?.bucket;
  const region = env.PINPAWO_COS_REGION ?? configured?.region;
  const secretId = env.PINPAWO_COS_SECRET_ID ?? configured?.secretId;
  const secretKey = env.PINPAWO_COS_SECRET_KEY ?? configured?.secretKey;
  if (!bucket || !region || !secretId || !secretKey) {
    throw new Error('COS artifacts require bucket, region, secretId and secretKey in global config or environment.');
  }
  return createCosArtifactStore({ adapter, workspaceId, bucket, region, secretId, secretKey,
    prefix: env.PINPAWO_COS_PREFIX ?? configured?.prefix });
}
