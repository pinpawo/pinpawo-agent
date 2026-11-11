import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import type { StudioHttpPluginContext } from './studioHttpPlugin';

const LOCAL_TOKEN = 'logto-preset-local-token-for-test';

test('Logto example config verifies resource JWTs through the installed HTTP Plugin and retains local access', async (t) => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-logto-test-'));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  await mkdir(path.join(workdir, '.pinpawo'));
  await writeFile(path.join(workdir, '.pinpawo', 'local-server-token'), LOCAL_TOKEN);

  // Isolate the installed Plugin's local token path from the developer's real Host.
  // The token path is resolved at module initialization, before the environment is restored.
  const previousHome = process.env.HOME;
  process.env.HOME = workdir;
  let core: typeof import('@pinpawo/studio-core');
  let http: typeof import('./studioHttpPlugin');
  try {
    core = await import('@pinpawo/studio-core');
    http = await import('./studioHttpPlugin');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }

  const key = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(key.publicKey);
  const jwks = createServer((request, response) => {
    if (request.url !== '/oidc/jwks') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: 'logto-test-key', alg: 'RS256', use: 'sig' }] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => jwks.close((error) => error ? reject(error) : resolve())));

  const example = JSON.parse(await readFile(new URL('../../../infra/logto/studio-http.example.json', import.meta.url), 'utf8')) as {
    id: string;
    options: { port: number; jwt: { issuers: Array<{ issuer: string; jwksUrl: string; audience: string; clientPrefix: string }> } };
  };
  assert.equal(example.id, '@pinpawo-plugin/studio-http');
  assert.equal(example.options.jwt.issuers.length, 1);
  const issuer = example.options.jwt.issuers[0]!;
  const exampleEndpoint = new URL(issuer.issuer).origin;
  const testEndpoint = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  // Change only the endpoint to the ephemeral JWKS server; keep the example's
  // paths, audience, prefix and installed Plugin config shape intact.
  issuer.issuer = issuer.issuer.replace(exampleEndpoint, testEndpoint);
  issuer.jwksUrl = issuer.jwksUrl.replace(exampleEndpoint, testEndpoint);
  example.options.port = 0;

  const storage = core.createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const clients = new core.StudioClients(async () => new core.KyselyClientStore(await storage.open('studio', core.clientMigrations)));
  const context: StudioHttpPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    subscribe: () => () => undefined,
    listPets: () => [],
    clients,
    hooks: { expose: () => () => undefined, contribute: () => () => undefined },
  };
  const plugin = http.createStudioPlugin(example.options, { workdir });
  await plugin.start(context);
  t.after(() => plugin.stop());
  const base = `http://127.0.0.1:${plugin.address()!.port}`;
  const call = (token: string, route = '/me') => fetch(base + route, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const sign = (audience: string) => new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'logto-test-key' })
    .setIssuer(issuer.issuer)
    .setAudience(audience)
    .setSubject('user123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);

  const resourceToken = await sign(issuer.audience);
  assert.deepEqual(await (await call(resourceToken)).json(), { clientId: `${issuer.clientPrefix}.user123`, scope: 'client' });
  assert.equal((await call(resourceToken, '/clients')).status, 403);
  assert.equal((await call(await sign('https://wrong.example/api'))).status, 401);
  assert.deepEqual(await (await call(LOCAL_TOKEN)).json(), { clientId: 'local', scope: 'studio' });
  assert.equal((await call(LOCAL_TOKEN, '/clients')).status, 200);
});
