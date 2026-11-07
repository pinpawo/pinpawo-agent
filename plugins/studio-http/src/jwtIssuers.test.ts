import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';

import { createJwtVerifier } from './jwtIssuers';

test('JWT issuers cannot claim the Studio login identity namespace', async () => {
  const { publicKey } = await generateKeyPair('ES256', { extractable: true });
  const issuer = {
    issuer: 'https://id.test', audience: 'studio',
    publicKey: await exportSPKI(publicKey), algorithms: ['ES256'],
  };
  for (const clientPrefix of ['user', ' user ']) {
    assert.throws(
      () => createJwtVerifier({ issuers: [{ ...issuer, clientPrefix }] }),
      /clientPrefix "user" is reserved/,
    );
  }
});

test('noncolliding JWT namespaces preserve their existing client identities', async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const issuer = {
    issuer: 'https://id.test', audience: 'studio',
    publicKey: await exportSPKI(publicKey), algorithms: ['ES256'],
  };
  // Client ids are case-sensitive. Prefixes resembling "user" do not collide,
  // nor does a subject containing "user." inside another issuer's namespace.
  for (const clientPrefix of ['acme', 'User', 'users', 'user-service', 'user_service']) {
    const verify = createJwtVerifier({ issuers: [{ ...issuer, clientPrefix }] });
    for (const subject of ['ada', 'user.ada']) {
      const token = await new SignJWT({ name: 'Ada' })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(issuer.issuer)
        .setAudience(issuer.audience)
        .setSubject(subject)
        .setExpirationTime('5m')
        .sign(privateKey);
      assert.deepEqual(await verify(token), { clientId: `${clientPrefix}.${subject}`, label: 'Ada' });
    }
  }
});
