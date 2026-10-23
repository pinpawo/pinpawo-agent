import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RegistryPackage = {
  manifest: { name: string; version: string } & Record<string, unknown>;
  filename: string;
  path: string;
  integrity: string;
  shasum: string;
};

/** Serve unpublished workspace tarballs; external dependencies use the real registry. */
export async function startPackageRegistry(packages: RegistryPackage[]) {
  const requested = new Set<string>();
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
  const byFilename = new Map(packages.map((entry) => [entry.filename, entry]));
  let origin = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname.slice(1));
    if (pathname.startsWith('_tarballs/')) {
      const entry = byFilename.get(pathname.slice('_tarballs/'.length));
      if (!entry) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/octet-stream');
      createReadStream(entry.path).on('error', () => response.destroy()).pipe(response);
      return;
    }
    const entry = byName.get(pathname);
    if (entry) {
      requested.add(pathname);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        name: pathname,
        'dist-tags': { latest: entry.manifest.version },
        versions: {
          [entry.manifest.version]: {
            ...entry.manifest,
            dist: {
              tarball: `${origin}/_tarballs/${entry.filename}`,
              integrity: entry.integrity,
              shasum: entry.shasum,
            },
          },
        },
      }));
      return;
    }
    if (/^(?:@pinpawo(?:-plugin|-toolkit)?\/|pinpawo$)/.test(pathname)) {
      // Never hide a missing fixture by fetching an older published workspace package.
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `Missing workspace fixture: ${pathname}` }));
      return;
    }
    response.writeHead(302, {
      location: `https://registry.npmjs.org${url.pathname}${url.search}`,
    }).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    requested,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
