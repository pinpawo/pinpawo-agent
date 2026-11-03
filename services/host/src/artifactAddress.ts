import { parseArtifactUri } from '@pinpawo/agent-contracts';
import type { ArtifactStore } from '@pinpawo-toolkit/artifacts';
import { FileArtifactStore } from './artifactStore';

/** Display addresses belong to Host; temporary URLs never enter model messages. */
export async function resolveHostArtifactAddress(
  store: ArtifactStore,
  uri: string,
): Promise<{ address: string; expiresAt?: string }> {
  parseArtifactUri(uri);
  if (store instanceof FileArtifactStore) return { address: await store.resolvePath(uri) };
  const result = await store.fetch(uri);
  if ('url' in result) return { address: result.url, expiresAt: result.expiresAt };
  await result.body.cancel();
  throw new Error('This artifact adapter does not provide a display address.');
}
