import type { BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { username } from 'better-auth/plugins/username';

/**
 * Table and column names this Plugin owns. Everything is prefixed with
 * `studio_auth_` so the tables can share the Studio database with other
 * Plugins without collisions.
 */
export const AUTH_TABLES = {
  user: 'studio_auth_user',
  session: 'studio_auth_session',
  account: 'studio_auth_account',
  verification: 'studio_auth_verification',
} as const;

/** Usernames are the login handle and become part of `user.<username>` client ids. */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,57}$/;

export type StudioAuthConfig = {
  /** Absolute session lifetime. Sessions never extend themselves. */
  sessionTtlHours: number;
  /** Reject a session that has not been used for this long. */
  idleTimeoutMinutes: number;
  /** Better Auth signing secret; only used for the (unused) cookie transport. */
  secret: string;
  minPasswordLength: number;
  /** Origin the Better Auth instance reports; it never listens on its own. */
  baseUrl: string;
};

/**
 * Better Auth owns the credentials (scrypt password hashing, session tokens,
 * credential accounts). Studio keeps the identity rules: username is the
 * login handle, `client_id`/`capabilities`/`disabled_at`/lockout counters are
 * additional user fields so one row carries everything a principal needs.
 */
export function studioAuthOptions(config: StudioAuthConfig): BetterAuthOptions {
  return {
    appName: 'PinPawo Studio',
    secret: config.secret,
    baseURL: config.baseUrl,
    telemetry: { enabled: false },
    // This instance is never exposed over HTTP itself: the Plugin answers
    // `/auth/*` and calls the API directly, so no browser origin applies.
    trustedOrigins: [config.baseUrl],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: config.minPasswordLength,
      maxPasswordLength: 256,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    session: {
      modelName: AUTH_TABLES.session,
      // No rolling refresh: `updateAge` equals the absolute lifetime, so a
      // session never outlives `sessionTtlHours` from its creation.
      expiresIn: config.sessionTtlHours * 60 * 60,
      updateAge: config.sessionTtlHours * 60 * 60,
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
      },
    },
    user: {
      modelName: AUTH_TABLES.user,
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      additionalFields: {
        clientId: {
          type: 'string',
          required: false,
          input: false,
          fieldName: 'client_id',
        },
        capabilities: {
          type: 'string',
          required: false,
          input: false,
          fieldName: 'capabilities',
        },
        failedAttempts: {
          type: 'number',
          required: false,
          input: false,
          defaultValue: 0,
          fieldName: 'failed_attempts',
        },
        lockedUntil: {
          type: 'string',
          required: false,
          input: false,
          fieldName: 'locked_until',
        },
        disabledAt: {
          type: 'string',
          required: false,
          input: false,
          fieldName: 'disabled_at',
        },
      },
    },
    account: {
      modelName: AUTH_TABLES.account,
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: AUTH_TABLES.verification,
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 58 }),
      // Lets `getSession({ headers })` accept `Authorization: Bearer <token>`,
      // which is the only credential transport this Plugin's routes use.
      bearer(),
    ],
    // Lockout is enforced per username by this Plugin so the rule is testable
    // and stored with the user row; Better Auth's IP rate limiter stays off.
    rateLimit: { enabled: false },
  };
}
