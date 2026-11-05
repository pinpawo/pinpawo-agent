import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import type { Kysely } from 'kysely';

import type { StudioPlugin, StudioPluginContext } from '@pinpawo/studio-core';
import { HttpRequestError } from '@pinpawo-plugin/studio-http';
import type {
  StudioHttpAuthenticatorsHook,
  StudioHttpRouteRequest,
  StudioHttpRouteResult,
  StudioHttpRoutesHook,
} from '@pinpawo-plugin/studio-http';

import {
  DEFAULT_USER_CAPABILITIES,
  normalizeCapabilities,
  parseStoredCapabilities,
  type StudioCapability,
} from './capabilities';
import { studioAuthOptions, USERNAME_PATTERN, type StudioAuthConfig } from './authOptions';
import { studioAuthMigrations } from './migrations';
import {
  CredentialConflictError,
  StudioAuthRepository,
  type StudioAuthDatabase,
  type StudioAuthUserRow,
} from './repository';

const PLUGIN_NAME = 'studio-auth';
const DEFAULT_SESSION_TTL_HOURS = 12;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const DEFAULT_MIN_PASSWORD_LENGTH = 12;
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MINUTES = 15;
/** Session tokens this Plugin mints: 32 random bytes, base64url encoded. */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
const SESSION_TOKEN_BYTES = 32;
const IDLE_TOUCH_INTERVAL_MS = 60_000;
/** This Studio never sends mail: the username is the identity, the email is internal. */
const INTERNAL_EMAIL_DOMAIN = 'studio-auth.invalid';
/**
 * A password nobody can sign in with. When the username does not exist the
 * Plugin still runs one scrypt verification against it, so "no such user" and
 * "wrong password" take the same time and cannot be told apart.
 */
const TIMING_EQUALIZER_PASSWORD = 'studio-auth-timing-equalizer';

export type CreateStudioAuthPluginOptions = {
  /** Contribute `/auth/*` and `/users*`; `false` keeps the Plugin table-only. */
  httpRoute?: false | { pluginName?: string };
  /** Absolute session lifetime. Defaults to 12 hours. */
  sessionTtlHours?: number;
  /** Reject a session unused for this long. Defaults to 30 minutes. */
  idleTimeoutMinutes?: number;
  /** Better Auth signing secret. Defaults to a per-process random value. */
  secret?: string;
  /** Use `X-Forwarded-For` as the audited client address. Defaults to `false`. */
  trustProxy?: boolean;
  minPasswordLength?: number;
  maxFailedAttempts?: number;
  lockoutMinutes?: number;
  /**
   * Internal seam, not part of the Plugin contract: awaited after a password
   * has been verified and before the session is minted, so a test can land a
   * password change inside that window.
   */
  internalBeforeSessionCreate?: () => Promise<void>;
  /**
   * Internal seam, not part of the Plugin contract: awaited after the current
   * password has been verified and the replacement hashed, but before the
   * credential is replaced in the database, so a test can land an
   * administrative reset inside that window.
   */
  internalBeforeCredentialReplace?: () => Promise<void>;
  /**
   * Internal seam, not part of the Plugin contract: awaited after an
   * administrative reset has read the credential version it will commit
   * against, so a test can land a second reset inside that window.
   */
  internalBeforeAdminReset?: () => Promise<void>;
};

export type StudioAuthPlugin = StudioPlugin & {
  start: (context: StudioPluginContext) => Promise<void>;
  stop: () => Promise<void>;
};

type RouteInput = {
  method: 'GET' | 'POST';
  path: string;
  authorization: 'studio' | 'route';
  handle: (request: StudioHttpRouteRequest) => Promise<StudioHttpRouteResult>;
};

type SignUpResult = { user: { id: string } };

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Studio auth ${name} must be a positive integer.`);
  }
  return value;
}

function json(status: number, body: unknown): StudioHttpRouteResult {
  return { kind: 'json', status, body };
}

function error(status: number, message: string): StudioHttpRouteResult {
  return { kind: 'json', status, body: { error: message } };
}

function readBearer(request: StudioHttpRouteRequest): string | null {
  const raw = request.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The stored form of a session token: what the database is allowed to know. */
function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A socket address in the form an operator can compare with other logs:
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) becomes plain IPv4, IPv6 zone ids
 * (`fe80::1%en0`) are dropped.
 */
function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const [withoutZone] = address.split('%');
  const value = withoutZone?.trim();
  if (!value) return undefined;
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

/**
 * The audited origin of a request. The socket address the HTTP Plugin hands
 * over is the default; a forwarding header only wins when the deployment says a
 * proxy it trusts sits in front of Studio (`trustProxy`).
 */
function readRemote(
  request: StudioHttpRouteRequest,
  trustProxy: boolean,
): { remote_addr?: string; user_agent?: string } {
  const agent = request.headers['user-agent'];
  const forwarded = trustProxy ? request.headers['x-forwarded-for'] : undefined;
  const rawForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const forwardedAddress = rawForwarded?.split(',')[0]?.trim();
  const address = normalizeAddress(forwardedAddress) ?? normalizeAddress(request.remoteAddress);
  return {
    ...(address ? { remote_addr: address } : {}),
    ...(typeof agent === 'string' ? { user_agent: agent.slice(0, 200) } : {}),
  };
}

function publicUser(row: StudioAuthUserRow) {
  return {
    userId: row.id,
    username: row.username ?? '',
    clientId: row.client_id ?? '',
    displayName: row.name,
    capabilities: parseStoredCapabilities(row.capabilities),
    createdAt: row.created_at,
    ...(row.disabled_at ? { disabledAt: row.disabled_at } : {}),
    ...(row.locked_until ? { lockedUntil: row.locked_until } : {}),
  };
}

/** The Studio client a user logs in as; `user.` is this Plugin's reserved prefix. */
export function clientIdForUsername(username: string): string {
  return `user.${username}`;
}

/**
 * Username/password login for Studio, built on Better Auth. Better Auth owns
 * the credential account: scrypt password hashing and verification. This
 * Plugin owns the session tokens (only their SHA-256 is stored), the identity
 * rules (a user is a Studio client with capabilities) and the audit trail.
 */
export function createStudioAuthPlugin(
  options: CreateStudioAuthPluginOptions = {},
): StudioAuthPlugin {
  const sessionTtlHours = positiveInteger(options.sessionTtlHours, DEFAULT_SESSION_TTL_HOURS, 'sessionTtlHours');
  const idleTimeoutMinutes = positiveInteger(options.idleTimeoutMinutes, DEFAULT_IDLE_TIMEOUT_MINUTES, 'idleTimeoutMinutes');
  const minPasswordLength = positiveInteger(options.minPasswordLength, DEFAULT_MIN_PASSWORD_LENGTH, 'minPasswordLength');
  const maxFailedAttempts = positiveInteger(options.maxFailedAttempts, DEFAULT_MAX_FAILED_ATTEMPTS, 'maxFailedAttempts');
  const lockoutMinutes = positiveInteger(options.lockoutMinutes, DEFAULT_LOCKOUT_MINUTES, 'lockoutMinutes');
  const trustProxy = options.trustProxy ?? false;
  const secret = options.secret ?? randomBytes(32).toString('base64url');
  if (secret.length < 32) throw new Error('Studio auth secret must contain at least 32 characters.');
  const beforeSessionCreate = options.internalBeforeSessionCreate;
  const beforeCredentialReplace = options.internalBeforeCredentialReplace;
  const beforeAdminReset = options.internalBeforeAdminReset;

  let studio: StudioPluginContext | undefined;
  let db: Kysely<StudioAuthDatabase> | undefined;
  let repository: StudioAuthRepository | undefined;
  let auth: ReturnType<typeof betterAuth> | undefined;
  let unregisterRoutes: (() => void) | undefined;
  let unregisterAuthenticator: (() => void) | undefined;
  let state: 'idle' | 'starting' | 'started' | 'stopped' = 'idle';
  let timingHash: Promise<string> | undefined;

  const config: StudioAuthConfig = {
    sessionTtlHours,
    idleTimeoutMinutes,
    secret,
    minPasswordLength,
    baseUrl: 'http://127.0.0.1:3211',
  };

  function repo(): StudioAuthRepository {
    if (!repository) throw new Error('Studio auth Plugin is not running.');
    return repository;
  }

  function requireStudio(): StudioPluginContext {
    if (!studio) throw new Error('Studio auth Plugin is not running.');
    return studio;
  }

  function authApi(): {
    signUpEmail: (input: {
      body: { email: string; password: string; name: string; username: string };
    }) => Promise<SignUpResult>;
  } {
    if (!auth) throw new Error('Studio auth Plugin is not running.');
    return auth.api as unknown as {
      signUpEmail: (input: {
        body: { email: string; password: string; name: string; username: string };
      }) => Promise<SignUpResult>;
    };
  }

  /** One wasted scrypt run so a missing user costs the same as a wrong password. */
  function verifyTimingEqualizer(password: string): Promise<boolean> {
    timingHash ??= hashPassword(TIMING_EQUALIZER_PASSWORD);
    return timingHash.then((hash) => verifyPassword({ hash, password }));
  }

  async function audit(
    action: string,
    result: 'ok' | 'denied' | 'error',
    input: {
      request?: StudioHttpRouteRequest;
      userId?: string | null;
      username?: string | null;
      clientId?: string | null;
      reason?: string;
    } = {},
  ): Promise<void> {
    try {
      await repo().audit({
        occurred_at: new Date().toISOString(),
        action,
        result,
        user_id: input.userId ?? null,
        username: input.username ?? null,
        client_id: input.clientId ?? null,
        reason: input.reason ?? null,
        ...(input.request ? readRemote(input.request, trustProxy) : {}),
      });
    } catch (cause) {
      // Auditing must never turn a working request into a failure.
      console.error('[studio-auth] audit write failed:', cause instanceof Error ? cause.message : cause);
    }
  }

  /** Mint a session: the caller gets the token, the database gets its hash. */
  async function createSession(
    userId: string,
    request: StudioHttpRouteRequest,
    credentialVersion: number,
  ): Promise<{ token: string; expiresAt: string } | undefined> {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + sessionTtlHours * 60 * 60_000).toISOString();
    const remote = readRemote(request, trustProxy);
    const minted = await repo().createSession({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      credentialVersion,
      ...(remote.remote_addr ? { ipAddress: remote.remote_addr } : {}),
      ...(remote.user_agent ? { userAgent: remote.user_agent } : {}),
    });
    if (!minted) return undefined;
    return { token, expiresAt };
  }

  /** Resolve a session token into the Studio principal it stands for. */
  async function verifySession(token: string): Promise<{
    principal: { clientId: string; scope: 'client'; capabilities: readonly StudioCapability[] };
    userId: string;
    sessionId: string;
    expiresAt: string;
  } | undefined> {
    if (!SESSION_TOKEN_PATTERN.test(token)) return undefined;
    const stored = await repo().findSessionByTokenHash(hashSessionToken(token));
    if (!stored) return undefined;

    const now = Date.now();
    const expiresAt = Date.parse(stored.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      await repo().deleteSessionById(stored.id);
      return undefined;
    }
    // `updated_at` is this session's last use: it drives the idle timeout.
    const lastUsed = Date.parse(stored.updated_at);
    if (Number.isFinite(lastUsed) && now - lastUsed > idleTimeoutMinutes * 60_000) {
      await repo().deleteSessionById(stored.id);
      return undefined;
    }
    if (!Number.isFinite(lastUsed) || now - lastUsed > IDLE_TOUCH_INTERVAL_MS) {
      await repo().touchSession(stored.id, new Date(now));
    }

    const row = await repo().findUserById(stored.user_id);
    if (!row || row.disabled_at) {
      // A disabled account must not keep a working session around.
      await repo().deleteSessionById(stored.id);
      return undefined;
    }
    // A session minted from a credential that has since been replaced is dead,
    // even if it slipped in after the revocation pass of the password change.
    if ((stored.credential_version ?? 0) !== (row.credential_version ?? 0)) {
      await repo().deleteSessionById(stored.id);
      return undefined;
    }
    const clientId = row.client_id ?? clientIdForUsername(row.username ?? '');
    const client = await requireStudio().clients.get(clientId);
    if (!client || client.revokedAt) return undefined;

    return {
      principal: {
        clientId,
        scope: 'client',
        capabilities: parseStoredCapabilities(row.capabilities),
      },
      userId: row.id,
      sessionId: stored.id,
      expiresAt: stored.expires_at,
    };
  }

  async function handleLogin(request: StudioHttpRouteRequest): Promise<StudioHttpRouteResult> {
    const body = readObject(await request.readJson());
    const username = readString(body.username)?.toLowerCase();
    const password = typeof body.password === 'string' ? body.password : undefined;
    if (!username || !password) return error(400, 'Expected username and password.');

    const row = await repo().findUserByUsername(username);
    if (row?.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 1000),
      );
      await audit('login', 'denied', { request, userId: row.id, username, reason: 'locked' });
      return json(429, { error: 'Too many attempts.', retryAfterSeconds });
    }

    // One consistent snapshot: the hash that is verified and the version it
    // belongs to. A password change after this read bumps the version, and the
    // session mint below notices (see StudioAuthRepository.createSession).
    const snapshot = row ? await repo().credentialSnapshot(row.id) : undefined;
    const storedHash = snapshot?.hash;
    const credentialVersion = snapshot?.version ?? 0;
    let passwordOk = false;
    try {
      passwordOk = storedHash
        ? await verifyPassword({ hash: storedHash, password })
        : await verifyTimingEqualizer(password);
    } catch (cause) {
      console.error('[studio-auth] password verification failed:', cause instanceof Error ? cause.message : cause);
      passwordOk = false;
    }

    // Disabled accounts, unknown usernames and wrong passwords answer the same
    // way, so a caller cannot use the login endpoint to enumerate accounts.
    if (!row || !passwordOk || row.disabled_at) {
      const reason = !row || !passwordOk ? 'invalid-credentials' : 'disabled';
      const lockedUntil = row && !row.disabled_at
        ? await repo().recordFailedAttempt(row.id, { maxAttempts: maxFailedAttempts, lockMinutes: lockoutMinutes })
        : null;
      await audit('login', 'denied', {
        request,
        userId: row?.id ?? null,
        username,
        reason: lockedUntil ? 'locked' : reason,
      });
      return error(401, 'Invalid username or password.');
    }

    const clientId = row.client_id ?? clientIdForUsername(username);
    let client = await requireStudio().clients.get(clientId);
    if (!client) client = await requireStudio().clients.ensure({ clientId, label: row.name });
    if (client.revokedAt) {
      await audit('login', 'denied', { request, userId: row.id, username, clientId, reason: 'client-revoked' });
      return error(403, 'This client has been revoked.');
    }

    const capabilities = row.capabilities
      ? parseStoredCapabilities(row.capabilities)
      : [...DEFAULT_USER_CAPABILITIES];
    if (!row.client_id || !row.capabilities) {
      await repo().setIdentity(row.id, { clientId, capabilities });
    }
    await repo().clearFailedAttempts(row.id);
    if (beforeSessionCreate) await beforeSessionCreate();
    const session = await createSession(row.id, request, credentialVersion);
    if (!session) {
      // The password changed while it was being verified: the credential that
      // was just checked is no longer the account's credential.
      await audit('login', 'denied', {
        request,
        userId: row.id,
        username,
        clientId,
        reason: 'credential-changed',
      });
      return error(401, 'Invalid username or password.');
    }
    await audit('login', 'ok', { request, userId: row.id, username, clientId });
    return json(200, {
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        userId: row.id,
        username,
        clientId,
        displayName: row.name,
        capabilities,
      },
    });
  }

  async function handleMe(request: StudioHttpRouteRequest): Promise<StudioHttpRouteResult> {
    const token = readBearer(request);
    if (!token) return error(401, 'Unauthorized.');
    const session = await verifySession(token);
    if (!session) return error(401, 'Unauthorized.');
    const row = await repo().findUserById(session.userId);
    if (!row) return error(401, 'Unauthorized.');
    return json(200, {
      userId: row.id,
      username: row.username ?? '',
      clientId: session.principal.clientId,
      displayName: row.name,
      capabilities: session.principal.capabilities,
      expiresAt: session.expiresAt,
    });
  }

  async function handleLogout(request: StudioHttpRouteRequest): Promise<StudioHttpRouteResult> {
    const token = readBearer(request);
    if (!token) return error(401, 'Unauthorized.');
    const session = await verifySession(token);
    if (!session) return error(401, 'Unauthorized.');
    await repo().deleteSessionById(session.sessionId);
    await audit('logout', 'ok', {
      request,
      userId: session.userId,
      clientId: session.principal.clientId,
    });
    return { kind: 'json', status: 204, body: null };
  }

  async function handleChangePassword(request: StudioHttpRouteRequest): Promise<StudioHttpRouteResult> {
    const token = readBearer(request);
    if (!token) return error(401, 'Unauthorized.');
    const session = await verifySession(token);
    if (!session) return error(401, 'Unauthorized.');
    const body = readObject(await request.readJson());
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : undefined;
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : undefined;
    if (!currentPassword || !newPassword) return error(400, 'Expected currentPassword and newPassword.');
    if (newPassword.length < minPasswordLength || newPassword.length > 256) {
      return error(400, `New password must be ${minPasswordLength.toString()}-256 characters.`);
    }
    // One consistent snapshot: the hash that is verified belongs to the version
    // this change will be committed against. Reading the version separately
    // would leave a window where an administrative reset lands between the
    // verified hash and the replacement.
    const snapshot = await repo().credentialSnapshot(session.userId);
    if (!snapshot.hash || !(await verifyPassword({ hash: snapshot.hash, password: currentPassword }))) {
      await audit('password.change', 'denied', {
        request,
        userId: session.userId,
        clientId: session.principal.clientId,
        reason: 'wrong-current-password',
      });
      return error(401, 'Current password is wrong.');
    }
    const newHash = await hashPassword(newPassword);
    if (beforeCredentialReplace) await beforeCredentialReplace();
    // One transaction: the new hash, the version bump and the revocation of the
    // other sessions land together. The session that made the change keeps
    // working (re-stamped with the new version), everything else dies. The
    // commit is conditional on the version this request verified against, so a
    // reset that landed meanwhile wins: an in-flight self-service change must
    // never overwrite the password an operator just set.
    let replaced: { revoked: number; keptSession: boolean };
    try {
      replaced = await repo().replaceCredential(session.userId, newHash, {
        keepSessionId: session.sessionId,
        expectedVersion: snapshot.version,
      });
    } catch (cause) {
      if (!(cause instanceof CredentialConflictError)) throw cause;
      await audit('password.change', 'denied', {
        request,
        userId: session.userId,
        clientId: session.principal.clientId,
        reason: 'credential-changed',
      });
      return error(409, 'Password was changed elsewhere. Sign in again and retry.');
    }
    const { revoked } = replaced;
    await audit('password.change', 'ok', {
      request,
      userId: session.userId,
      clientId: session.principal.clientId,
      reason: `revoked ${revoked.toString()} sessions`,
    });
    if (!replaced.keptSession) {
      // The session that made the change was revoked while it was in flight
      // (logout or disable elsewhere): say so instead of implying this device
      // is still signed in.
      return json(200, { revoked: true });
    }
    return { kind: 'json', status: 204, body: null };
  }

  async function handleListUsers(): Promise<StudioHttpRouteResult> {
    const rows = await repo().listUsers();
    return json(200, { users: rows.map(publicUser) });
  }

  async function handleCreateUser(request: StudioHttpRouteRequest): Promise<StudioHttpRouteResult> {
    const body = readObject(await request.readJson());
    const username = readString(body.username)?.toLowerCase();
    const password = typeof body.password === 'string' ? body.password : undefined;
    const displayName = readString(body.displayName) ?? username;
    if (!username || !password) return error(400, 'Expected username and password.');
    if (!USERNAME_PATTERN.test(username)) {
      return error(400, 'Username must be 1-58 letters, digits, ".", "_" or "-", starting with a letter or digit.');
    }
    if (password.length < minPasswordLength || password.length > 256) {
      return error(400, `Password must be ${minPasswordLength.toString()}-256 characters.`);
    }
    let capabilities: StudioCapability[];
    try {
      capabilities = body.capabilities === undefined
        ? [...DEFAULT_USER_CAPABILITIES]
        : normalizeCapabilities(body.capabilities);
    } catch (cause) {
      return error(400, cause instanceof Error ? cause.message : 'Invalid capabilities.');
    }
    if (await repo().findUserByUsername(username)) {
      return error(409, `User "${username}" already exists.`);
    }
    const clientId = clientIdForUsername(username);
    // Check the client first: a revoked identity must not gain a fresh user row.
    if ((await requireStudio().clients.get(clientId))?.revokedAt) {
      return error(409, `Studio client "${clientId}" has been revoked.`);
    }

    // The client row comes first: a user without one could never sign in. If
    // signUpEmail then fails, the leftover client carries no credential and
    // stays inert until someone retries with the same username.
    await requireStudio().clients.ensure({ clientId, label: displayName });
    let created: SignUpResult;
    try {
      created = await authApi().signUpEmail({
        body: {
          email: `${username}@${INTERNAL_EMAIL_DOMAIN}`,
          password,
          name: displayName ?? username,
          username,
        },
      });
    } catch (cause) {
      if (cause instanceof APIError && cause.statusCode >= 400 && cause.statusCode < 500) {
        // An invalid username is a bad request; a duplicate is a conflict. Both
        // rules above keep this Plugin and Better Auth in step, so this is a
        // backstop rather than the normal path.
        const status = /username/i.test(cause.message) ? 400 : 409;
        return error(status, cause.message);
      }
      throw cause;
    }
    // Better Auth never signs a new account in (autoSignIn: false); clear any
    // session a future default might create so no orphan token survives.
    await repo().deleteSessionsOfUser(created.user.id);
    await repo().setIdentity(created.user.id, { clientId, capabilities });
    await audit('user.create', 'ok', { request, userId: created.user.id, username, clientId });
    return json(201, { userId: created.user.id, username, clientId, capabilities });
  }

  async function handleSetPassword(request: StudioHttpRouteRequest): Promise<StudioHttpRouteResult> {
    const body = readObject(await request.readJson());
    const userId = readString(body.userId);
    const password = typeof body.password === 'string' ? body.password : undefined;
    if (!userId || !password) return error(400, 'Expected userId and password.');
    if (password.length < minPasswordLength || password.length > 256) {
      return error(400, `Password must be ${minPasswordLength.toString()}-256 characters.`);
    }
    const row = await repo().findUserById(userId);
    if (!row) return error(404, 'No such user.');
    // An administrative reset revokes every session, in the same transaction as
    // the new hash, so no session minted from the old password survives.
    //
    // It commits against the version read here instead of overwriting blindly:
    // two operators resetting the same account at once would otherwise let the
    // slower one silently undo the faster one. The version is read before the
    // hash is computed so the scrypt delay sits inside the window on purpose.
    const { version } = await repo().credentialSnapshot(userId);
    const newHash = await hashPassword(password);
    if (beforeAdminReset) await beforeAdminReset();
    let replaced: { revoked: number };
    try {
      replaced = await repo().replaceCredential(userId, newHash, { expectedVersion: version });
    } catch (cause) {
      if (!(cause instanceof CredentialConflictError)) throw cause;
      await audit('user.password', 'denied', {
        request,
        userId,
        username: row.username,
        clientId: row.client_id,
        reason: 'credential-changed',
      });
      return error(409, 'Password was changed elsewhere. Reload the user and retry.');
    }
    const { revoked } = replaced;
    await audit('user.password', 'ok', {
      request,
      userId,
      username: row.username,
      clientId: row.client_id,
      reason: `revoked ${revoked.toString()} sessions`,
    });
    return { kind: 'json', status: 204, body: null };
  }

  async function handleSetCapabilities(request: StudioHttpRouteRequest): Promise<StudioHttpRouteResult> {
    const body = readObject(await request.readJson());
    const userId = readString(body.userId);
    if (!userId) return error(400, 'Expected userId and capabilities.');
    let capabilities: StudioCapability[];
    try {
      capabilities = normalizeCapabilities(body.capabilities);
    } catch (cause) {
      return error(400, cause instanceof Error ? cause.message : 'Invalid capabilities.');
    }
    const row = await repo().findUserById(userId);
    if (!row) return error(404, 'No such user.');
    const clientId = row.client_id ?? clientIdForUsername(row.username ?? '');
    await repo().setIdentity(userId, { clientId, capabilities });
    await audit('user.capabilities', 'ok', {
      request,
      userId,
      username: row.username,
      clientId,
      reason: capabilities.join(','),
    });
    return json(200, { userId, capabilities });
  }

  async function handleDisable(request: StudioHttpRouteRequest): Promise<StudioHttpRouteResult> {
    const body = readObject(await request.readJson());
    const userId = readString(body.userId);
    if (!userId || typeof body.disabled !== 'boolean') return error(400, 'Expected userId and disabled.');
    const row = await repo().findUserById(userId);
    if (!row) return error(404, 'No such user.');
    if (row.client_id === 'local') return error(400, 'The local identity cannot be disabled.');
    if (body.disabled) {
      // Disabling bumps the credential version together with the session
      // revocation, so a self-service password change that verified the old
      // password moments ago can no longer commit against a disabled account.
      await repo().disableAccount(userId, new Date().toISOString());
    } else {
      await repo().setDisableState(userId, null);
    }
    await audit('user.disable', 'ok', {
      request,
      userId,
      username: row.username,
      clientId: row.client_id,
      reason: body.disabled ? 'disabled' : 'enabled',
    });
    return json(200, { userId, disabled: body.disabled });
  }

  const routes: RouteInput[] = [
    { method: 'POST', path: '/auth/login', authorization: 'route', handle: handleLogin },
    { method: 'POST', path: '/auth/logout', authorization: 'route', handle: handleLogout },
    { method: 'GET', path: '/auth/me', authorization: 'route', handle: handleMe },
    { method: 'POST', path: '/auth/password', authorization: 'route', handle: handleChangePassword },
    { method: 'GET', path: '/users', authorization: 'studio', handle: () => handleListUsers() },
    { method: 'POST', path: '/users', authorization: 'studio', handle: handleCreateUser },
    { method: 'POST', path: '/users/password', authorization: 'studio', handle: handleSetPassword },
    { method: 'POST', path: '/users/capabilities', authorization: 'studio', handle: handleSetCapabilities },
    { method: 'POST', path: '/users/disable', authorization: 'studio', handle: handleDisable },
  ];

  function release(): void {
    unregisterRoutes?.();
    unregisterRoutes = undefined;
    unregisterAuthenticator?.();
    unregisterAuthenticator = undefined;
    auth = undefined;
    repository = undefined;
    db = undefined;
    studio = undefined;
  }

  return {
    name: PLUGIN_NAME,
    toolkits: [],
    start: async (pluginContext) => {
      if (state !== 'idle') throw new Error('Studio auth Plugin can only be started once.');
      state = 'starting';
      try {
        studio = pluginContext;
        const dialect = pluginContext.storage.dialect;
        const database = await pluginContext.storage.open<StudioAuthDatabase>(
          studioAuthMigrations(dialect, config),
        );
        db = database;
        repository = new StudioAuthRepository(database);
        auth = betterAuth({
          ...(studioAuthOptions(config) as BetterAuthOptions),
          database: { db: database as unknown as Kysely<never>, type: dialect },
        }) as unknown as ReturnType<typeof betterAuth>;

        if (options.httpRoute !== false) {
          const pluginName = options.httpRoute?.pluginName ?? 'http';
          unregisterRoutes = pluginContext.hooks.contribute<StudioHttpRoutesHook>(
            pluginName,
            'routes',
            (hook) => {
              const removers = routes.map((route) => hook.register({
                method: route.method,
                path: route.path,
                authorization: route.authorization,
                handle: async (request) => {
                  try {
                    return await route.handle(request);
                  } catch (cause) {
                    if (cause instanceof APIError) return error(cause.statusCode, cause.message);
                  // A malformed request is the caller's mistake, not a server
                  // failure: keep the 400/415 the HTTP Plugin already decided.
                  if (cause instanceof HttpRequestError) return error(cause.status, cause.message);
                    console.error('[studio-auth] route failed:', cause instanceof Error ? cause.message : cause);
                    return error(500, 'Internal server error.');
                  }
                },
              }));
              return () => { for (const remove of removers) remove(); };
            },
          );
          unregisterAuthenticator = pluginContext.hooks.contribute<StudioHttpAuthenticatorsHook>(
            pluginName,
            'authenticators',
            (hook) => hook.register({
              verify: async (token) => (await verifySession(token))?.principal,
            }),
          );
        }
        state = 'started';
      } catch (cause) {
        // A failed start leaves nothing behind, so the Host can retry it.
        release();
        state = 'idle';
        throw cause;
      }
    },
    stop: async () => {
      if (state === 'stopped' || state === 'idle') return;
      state = 'stopped';
      release();
    },
  };
}

/** Installed-package entry used by the standalone Studio Plugin resolver. */
export function createStudioPlugin(
  options: Record<string, unknown> | undefined,
): StudioAuthPlugin {
  const input = options ?? {};
  const allowed = new Set([
    'httpRoute',
    'sessionTtlHours',
    'idleTimeoutMinutes',
    'secret',
    'trustProxy',
    'minPasswordLength',
    'maxFailedAttempts',
    'lockoutMinutes',
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Studio auth Plugin option "${unknown}" is not supported.`);
  for (const key of ['sessionTtlHours', 'idleTimeoutMinutes', 'minPasswordLength', 'maxFailedAttempts', 'lockoutMinutes']) {
    if (input[key] !== undefined && typeof input[key] !== 'number') {
      throw new Error(`Studio auth Plugin option "${key}" must be a number.`);
    }
  }
  if (input.secret !== undefined && typeof input.secret !== 'string') {
    throw new Error('Studio auth Plugin option "secret" must be a string.');
  }
  if (input.trustProxy !== undefined && typeof input.trustProxy !== 'boolean') {
    throw new Error('Studio auth Plugin option "trustProxy" must be a boolean.');
  }
  return createStudioAuthPlugin({
    ...(input.httpRoute === false
      ? { httpRoute: false as const }
      : input.httpRoute && typeof input.httpRoute === 'object'
        ? { httpRoute: input.httpRoute as { pluginName?: string } }
        : {}),
    ...(typeof input.sessionTtlHours === 'number' ? { sessionTtlHours: input.sessionTtlHours } : {}),
    ...(typeof input.idleTimeoutMinutes === 'number' ? { idleTimeoutMinutes: input.idleTimeoutMinutes } : {}),
    ...(typeof input.secret === 'string' ? { secret: input.secret } : {}),
    ...(typeof input.trustProxy === 'boolean' ? { trustProxy: input.trustProxy } : {}),
    ...(typeof input.minPasswordLength === 'number' ? { minPasswordLength: input.minPasswordLength } : {}),
    ...(typeof input.maxFailedAttempts === 'number' ? { maxFailedAttempts: input.maxFailedAttempts } : {}),
    ...(typeof input.lockoutMinutes === 'number' ? { lockoutMinutes: input.lockoutMinutes } : {}),
  });
}
