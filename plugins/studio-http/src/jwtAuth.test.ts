import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, exportSPKI, generateKeyPair, type CryptoKey, type JWTPayload } from 'jose';

import {
  KyselyClientStore,
  StudioClients,
  clientMigrations,
  createStudioStorage,
  type ClientDatabase,
} from '@pinpawo/studio';

import { createStudioHttpPlugin, type StudioHttpPluginContext, type StudioHttpRoutesHook } from './studioHttpPlugin';
import { createJwtVerifier } from './jwtIssuers';

const AUTH_TOKEN = 'test-token-with-at-least-16-characters';

async function sign(key: CryptoKey, alg: string, claims: JWTPayload, options: { exp?: string | false } = {}) {
  let jwt = new SignJWT(claims).setProtectedHeader({ alg, kid: 'k1' }).setIssuedAt();
  if (options.exp !== false) jwt = jwt.setExpirationTime(options.exp ?? '5m');
  return jwt.sign(key);
}

test('HTTP Plugin accepts JWTs from configured issuers as auto-registered client principals', async (t) => {
  const acme = await generateKeyPair('RS256', { extractable: true });
  const partner = await generateKeyPair('ES256', { extractable: true });
  const stranger = await generateKeyPair('RS256', { extractable: true });

  // The partner issuer publishes its keys as a JWKS.
  const jwks = createServer((_request, response) => {
    void exportJWK(partner.publicKey).then((jwk) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] }));
    });
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => jwks.close(() => resolve())));

  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const clients = new StudioClients(async () => new KyselyClientStore(await storage.open<ClientDatabase>('studio', clientMigrations)));
  let routes: StudioHttpRoutesHook | undefined;
  const context: StudioHttpPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    subscribe: () => () => undefined,
    listPets: () => [],
    clients,
    hooks: {
      expose: (_hookName, hook) => {
        routes = hook as StudioHttpRoutesHook;
        return () => { routes = undefined; };
      },
      contribute: () => () => undefined,
    },
  };
  const plugin = createStudioHttpPlugin({
    port: 0,
    authToken: AUTH_TOKEN,
    jwt: {
      issuers: [
        { issuer: 'https://id.acme.test', audience: 'pinpawo', publicKey: await exportSPKI(acme.publicKey), clientPrefix: 'acme' },
        {
          issuer: 'https://partner.test', audience: 'studio-1', clientPrefix: 'partner',
          jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port.toString()}/jwks`,
        },
      ],
    },
  });
  await plugin.start(context);
  t.after(() => plugin.stop());
  assert.ok(routes);
  routes.register({ method: 'GET', path: '/whoami', authorization: 'client', handle: ({ principal }) => ({ kind: 'json', body: principal }) });
  const port = plugin.address()!.port;
  const call = (path: string, token: string) => fetch(`http://127.0.0.1:${port.toString()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const status = async (token: string) => (await call('/whoami', token)).status;
  const acmeClaims = { iss: 'https://id.acme.test', aud: 'pinpawo', sub: 'alice', name: 'Alice Liu' };

  const alice = await sign(acme.privateKey, 'RS256', acmeClaims);
  assert.equal(await clients.get('acme.alice'), undefined);
  assert.deepEqual(await (await call('/whoami', alice)).json(), { clientId: 'acme.alice', scope: 'client' });
  assert.equal((await clients.get('acme.alice'))?.label, 'Alice Liu', 'registered on first use with the name claim');
  assert.equal(await status(await sign(acme.privateKey, 'RS256', acmeClaims)), 200, 'a later token reuses the client');
  for (const path of ['/pets', '/clients', '/dispatch/queues']) assert.equal((await call(path, alice)).status, 403, path);

  const partnerToken = await sign(partner.privateKey, 'ES256', { iss: 'https://partner.test', aud: 'studio-1', sub: 'svc-7' });
  assert.deepEqual(await (await call('/whoami', partnerToken)).json(), { clientId: 'partner.svc-7', scope: 'client' });
  assert.equal((await clients.get('partner.svc-7'))?.label, 'svc-7', 'sub is the label without a name claim');

  const refused: Array<[string, Promise<string>]> = [
    ['wrong audience', sign(acme.privateKey, 'RS256', { ...acmeClaims, aud: 'other' })],
    ['unknown issuer', sign(acme.privateKey, 'RS256', { ...acmeClaims, iss: 'https://evil.test' })],
    ['expired', sign(acme.privateKey, 'RS256', acmeClaims, { exp: '-1m' })],
    ['no exp', sign(acme.privateKey, 'RS256', acmeClaims, { exp: false })],
    ['not yet valid', new SignJWT(acmeClaims).setProtectedHeader({ alg: 'RS256' }).setExpirationTime('5m').setNotBefore('2m').sign(acme.privateKey)],
    ['no sub', sign(acme.privateKey, 'RS256', { iss: acmeClaims.iss, aud: acmeClaims.aud })],
    ['sub not usable as a client id', sign(acme.privateKey, 'RS256', { ...acmeClaims, sub: 'alice smith' })],
    ['other key', sign(stranger.privateKey, 'RS256', acmeClaims)],
    ['other issuer\'s key', sign(partner.privateKey, 'ES256', acmeClaims)],
    ['symmetric', new SignJWT(acmeClaims).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(new TextEncoder().encode(AUTH_TOKEN))],
    ['malformed', Promise.resolve('aaa.bbb.ccc')],
  ];
  for (const [reason, token] of refused) assert.equal(await status(await token), 401, reason);
  assert.equal(await status(`${alice}x`), 401, 'tampered signature');

  // Revoking the client locally refuses every later token for it.
  await clients.revoke('acme.alice');
  assert.equal(await status(await sign(acme.privateKey, 'RS256', acmeClaims)), 401);
  assert.equal(await status(partnerToken), 200);
});

test('JWT issuer configuration is checked when the Plugin is created', async () => {
  const { publicKey } = await generateKeyPair('RS256', { extractable: true });
  const pem = await exportSPKI(publicKey);
  const base = { issuer: 'https://id.test', audience: 'a', clientPrefix: 'acme', publicKey: pem };
  const create = (issuers: unknown) => createJwtVerifier({ issuers } as never);
  assert.throws(() => create([]), /non-empty array/);
  assert.throws(() => create([{ ...base, publicKey: undefined }]), /exactly one of jwksUrl or publicKey/);
  assert.throws(() => create([{ ...base, jwksUrl: 'https://id.test/jwks' }]), /exactly one of jwksUrl or publicKey/);
  assert.throws(() => create([{ ...base, publicKey: 'not a key' }]), /not a PEM public key/);
  assert.throws(() => create([{ ...base, clientPrefix: 'a.b' }]), /clientPrefix/);
  assert.throws(() => create([{ ...base, algorithms: ['HS256'] }]), /asymmetric/);
  assert.throws(() => create([{ ...base, publicKey: undefined, jwksUrl: 'http://id.test/jwks' }]), /https/);
  assert.throws(() => create([base, { ...base, clientPrefix: 'other' }]), /listed twice/);
  assert.throws(() => create([base, { ...base, issuer: 'https://two.test' }]), /used twice/);
  assert.throws(() => createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN, jwt: { issuers: [{ ...base, audience: ' ' }] } }), /audience/);
});
