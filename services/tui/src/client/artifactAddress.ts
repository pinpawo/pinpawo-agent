/** Authenticated download endpoint; it is not a browser-openable display address. */
export function artifactHttpAddress(uri: string, port: number): string {
  if (!uri.startsWith('artifact://')) return uri;
  return `http://127.0.0.1:${port}/agent-session/artifacts?${new URLSearchParams({ uri })}`;
}

export type ArtifactDisplayAddress = { address: string; expiresAt?: string };

/** Terminal-only cache. Failed reads wait for a new connection, never a render retry. */
export function createArtifactAddressCache(options: {
  read: (uri: string) => Promise<ArtifactDisplayAddress | null>;
  onChanged: () => void;
  /** Only an embedded stdio child is known to share the TUI's filesystem. */
  sharedFilesystem?: boolean;
  now?: () => number;
}) {
  const addresses = new Map<string, ArtifactDisplayAddress>();
  const pending = new Map<string, Promise<void>>();
  const failed = new Set<string>();
  const now = options.now ?? Date.now;
  const valid = (value: ArtifactDisplayAddress) => !value.expiresAt || Date.parse(value.expiresAt) > now();
  return {
    display(uri: string): string {
      const value = addresses.get(uri);
      if (value && valid(value) && (options.sharedFilesystem || /^https?:\/\//.test(value.address))) return value.address;
      return uri.startsWith('artifact://') && !options.sharedFilesystem ? `/download ${uri}` : uri;
    },
    resetFailures() { failed.clear(); },
    async ensure(uris: readonly string[]): Promise<void> {
      await Promise.all([...new Set(uris)].map((uri) => {
        if (!uri.startsWith('artifact://') || failed.has(uri)) return;
        const value = addresses.get(uri);
        if (value && valid(value)) return;
        const reading = pending.get(uri);
        if (reading) return reading;
        const promise = options.read(uri).catch(() => null).then((result) => {
          if (!result || !valid(result)) { failed.add(uri); return; }
          addresses.set(uri, result);
          options.onChanged();
        }).finally(() => { pending.delete(uri); });
        pending.set(uri, promise);
        return promise;
      }));
    },
  };
}
