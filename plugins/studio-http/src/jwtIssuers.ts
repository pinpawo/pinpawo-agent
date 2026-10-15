import { createPublicKey, type KeyObject } from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * A system whose JWTs this Studio accepts. A valid token's `sub` becomes the
 * Studio client `<clientPrefix>.<sub>`, registered on first use; revoking that
 * client locally still refuses its tokens.
 */
export type StudioHttpJwtIssuer = {
  /** Exact `iss` claim. */
  issuer: string;
  /** Required `aud` claim. */
  audience: string;
  /** JWKS endpoint (https, or http on loopback). Set this or publicKey. */
  jwksUrl?: string;
  /** SPKI PEM public key. Set this or jwksUrl. */
  publicKey?: string;
  /** Names this issuer's clients: letters, digits, "_" or "-", no dots. */
  clientPrefix: string;
  /** Defaults to RS256 and ES256. */
  algorithms?: readonly string[];
};

export type StudioHttpJwtOptions = { issuers: readonly StudioHttpJwtIssuer[] };

/** The client a verified token speaks for. */
export type JwtIdentity = { clientId: string; label: string };

const DEFAULT_ALGORITHMS = ['RS256', 'ES256'] as const;
const ALLOWED_ALGORITHMS = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']);
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// Same rule as Studio client ids.
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A three-part compact token; client keys (`pps_…`) never have this shape. */
export function looksLikeJwt(token: string): boolean {
  return COMPACT_JWT.test(token);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Studio HTTP Plugin jwt ${label} must be a non-empty string.`);
  return value.trim();
}

function jwksUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Studio HTTP Plugin jwt jwksUrl must be a URL.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Studio HTTP Plugin jwt jwksUrl must use https (http only on loopback).');
  }
  return url;
}

type Verifier = {
  issuer: string;
  audience: string;
  clientPrefix: string;
  algorithms: string[];
  key: KeyObject | JWTVerifyGetKey;
};

function readIssuer(input: StudioHttpJwtIssuer): Verifier {
  const issuer = nonEmpty(input.issuer, 'issuer');
  const audience = nonEmpty(input.audience, 'audience');
  const clientPrefix = nonEmpty(input.clientPrefix, 'clientPrefix');
  if (!PREFIX.test(clientPrefix)) {
    throw new Error(`Studio HTTP Plugin jwt clientPrefix "${clientPrefix}" must be 1-32 letters, digits, "_" or "-".`);
  }
  const algorithms = [...(input.algorithms ?? DEFAULT_ALGORITHMS)];
  if (algorithms.length === 0 || algorithms.some((algorithm) => !ALLOWED_ALGORITHMS.has(algorithm))) {
    throw new Error(`Studio HTTP Plugin jwt algorithms for "${issuer}" must be asymmetric JWS algorithms.`);
  }
  if ((input.jwksUrl === undefined) === (input.publicKey === undefined)) {
    throw new Error(`Studio HTTP Plugin jwt issuer "${issuer}" needs exactly one of jwksUrl or publicKey.`);
  }
  let key: KeyObject | JWTVerifyGetKey;
  if (input.jwksUrl !== undefined) {
    key = createRemoteJWKSet(jwksUrl(nonEmpty(input.jwksUrl, 'jwksUrl')));
  } else {
    try {
      key = createPublicKey(nonEmpty(input.publicKey, 'publicKey'));
    } catch {
      throw new Error(`Studio HTTP Plugin jwt publicKey for "${issuer}" is not a PEM public key.`);
    }
  }
  return { issuer, audience, clientPrefix, algorithms, key };
}

/**
 * Verify tokens from the configured issuers: signature, `iss`, `aud`, `exp`
 * (required) and `nbf`. Resolves undefined for any token it does not accept.
 */
export function createJwtVerifier(options: StudioHttpJwtOptions): (token: string) => Promise<JwtIdentity | undefined> {
  if (!Array.isArray(options.issuers) || options.issuers.length === 0) {
    throw new Error('Studio HTTP Plugin jwt issuers must be a non-empty array.');
  }
  const verifiers = new Map<string, Verifier>();
  const prefixes = new Set<string>();
  for (const input of options.issuers) {
    const verifier = readIssuer(input);
    if (verifiers.has(verifier.issuer)) throw new Error(`Studio HTTP Plugin jwt issuer "${verifier.issuer}" is listed twice.`);
    if (prefixes.has(verifier.clientPrefix)) throw new Error(`Studio HTTP Plugin jwt clientPrefix "${verifier.clientPrefix}" is used twice.`);
    verifiers.set(verifier.issuer, verifier);
    prefixes.add(verifier.clientPrefix);
  }

  return async (token) => {
    let issuer: unknown;
    try {
      issuer = decodeJwt(token).iss;
    } catch {
      return undefined;
    }
    const verifier = typeof issuer === 'string' ? verifiers.get(issuer) : undefined;
    if (!verifier) return undefined;
    try {
      const { payload } = await jwtVerify(token, verifier.key as JWTVerifyGetKey, {
        issuer: verifier.issuer,
        audience: verifier.audience,
        algorithms: verifier.algorithms,
        requiredClaims: ['exp', 'sub'],
      });
      const clientId = `${verifier.clientPrefix}.${payload.sub!}`;
      if (!CLIENT_ID.test(clientId)) return undefined;
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      return { clientId, label: name && name.length <= 160 ? name : payload.sub! };
    } catch {
      return undefined;
    }
  };
}
