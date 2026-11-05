import type { Kysely } from 'kysely';

import type { StudioCapability } from './capabilities';

export type StudioAuthUserRow = {
  id: string;
  name: string;
  email: string;
  email_verified: number | boolean;
  image: string | null;
  created_at: string;
  updated_at: string;
  username: string | null;
  /** Better Auth's username plugin keys this column by its field name. */
  displayUsername: string | null;
  client_id: string | null;
  capabilities: string | null;
  failed_attempts: number | null;
  locked_until: string | null;
  disabled_at: string | null;
};

/**
 * A login session. `token` holds the SHA-256 of the bearer token, never the
 * token itself: the database alone is not enough to impersonate a user.
 */
export type StudioAuthSessionRow = {
  id: string;
  expires_at: string;
  token: string;
  created_at: string;
  updated_at: string;
  ip_address: string | null;
  user_agent: string | null;
  user_id: string;
};

export type StudioAuthAccountRow = {
  id: string;
  account_id: string;
  provider_id: string;
  user_id: string;
  password: string | null;
  created_at: string;
  updated_at: string;
};

export type StudioAuthAuditRow = {
  occurred_at: string;
  action: string;
  result: 'ok' | 'denied' | 'error';
  user_id?: string | null;
  username?: string | null;
  client_id?: string | null;
  reason?: string | null;
  remote_addr?: string | null;
  user_agent?: string | null;
};

export type StudioAuthDatabase = {
  studio_auth_user: StudioAuthUserRow;
  studio_auth_session: StudioAuthSessionRow;
  studio_auth_account: StudioAuthAccountRow;
  studio_auth_audit: StudioAuthAuditRow;
};

/** The provider id Better Auth writes for a username/password credential. */
const CREDENTIAL_PROVIDER_ID = 'credential';

/**
 * Row-level access to this Plugin's tables. Rules (locking policy, capability
 * defaults, identity mapping) stay in the Plugin; this is storage only.
 */
export class StudioAuthRepository {
  constructor(private readonly db: Kysely<StudioAuthDatabase>) {}

  async findUserByUsername(username: string): Promise<StudioAuthUserRow | undefined> {
    return this.db
      .selectFrom('studio_auth_user')
      .selectAll()
      .where('username', '=', username)
      .executeTakeFirst();
  }

  async findUserById(userId: string): Promise<StudioAuthUserRow | undefined> {
    return this.db
      .selectFrom('studio_auth_user')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
  }

  async listUsers(): Promise<StudioAuthUserRow[]> {
    return this.db
      .selectFrom('studio_auth_user')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute();
  }

  async setIdentity(
    userId: string,
    input: { clientId: string; capabilities: readonly StudioCapability[] },
  ): Promise<void> {
    await this.db
      .updateTable('studio_auth_user')
      .set({
        client_id: input.clientId,
        capabilities: JSON.stringify(input.capabilities),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', userId)
      .execute();
  }

  async setDisableState(userId: string, disabledAt: string | null): Promise<void> {
    await this.db
      .updateTable('studio_auth_user')
      .set({ disabled_at: disabledAt, updated_at: new Date().toISOString() })
      .where('id', '=', userId)
      .execute();
  }

  /** The password hash Better Auth stored for this user, if any. */
  async credentialHash(userId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('studio_auth_account')
      .select(['password'])
      .where('user_id', '=', userId)
      .where('provider_id', '=', CREDENTIAL_PROVIDER_ID)
      .executeTakeFirst();
    return row?.password ?? undefined;
  }

  async setCredentialHash(userId: string, hash: string): Promise<void> {
    const result = await this.db
      .updateTable('studio_auth_account')
      .set({ password: hash, updated_at: new Date().toISOString() })
      .where('user_id', '=', userId)
      .where('provider_id', '=', CREDENTIAL_PROVIDER_ID)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) {
      throw new Error('This user has no password credential to update.');
    }
  }

  /**
   * Count one failed login and lock the account once the threshold is reached.
   * The increment is a single UPDATE so parallel attempts cannot overwrite each
   * other and slip under the limit.
   */
  async recordFailedAttempt(
    userId: string,
    policy: { maxAttempts: number; lockMinutes: number },
  ): Promise<string | null> {
    const now = new Date();
    await this.db
      .updateTable('studio_auth_user')
      .set((expression) => ({
        failed_attempts: expression(
          expression.fn.coalesce('failed_attempts', expression.val(0)),
          '+',
          1,
        ),
        updated_at: now.toISOString(),
      }))
      .where('id', '=', userId)
      .execute();

    const row = await this.findUserById(userId);
    if ((row?.failed_attempts ?? 0) < policy.maxAttempts) return null;

    const lockedUntil = new Date(now.getTime() + policy.lockMinutes * 60_000).toISOString();
    await this.db
      .updateTable('studio_auth_user')
      .set({ failed_attempts: 0, locked_until: lockedUntil, updated_at: now.toISOString() })
      .where('id', '=', userId)
      .execute();
    return lockedUntil;
  }

  async clearFailedAttempts(userId: string): Promise<void> {
    await this.db
      .updateTable('studio_auth_user')
      .set({ failed_attempts: 0, locked_until: null })
      .where('id', '=', userId)
      .execute();
  }

  async createSession(row: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto('studio_auth_session')
      .values({
        id: row.id,
        token: row.tokenHash,
        user_id: row.userId,
        created_at: now,
        // `updated_at` doubles as `last_used_at` for the idle timeout.
        updated_at: now,
        expires_at: row.expiresAt,
        ip_address: row.ipAddress ?? null,
        user_agent: row.userAgent ?? null,
      })
      .execute();
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StudioAuthSessionRow | undefined> {
    return this.db
      .selectFrom('studio_auth_session')
      .selectAll()
      .where('token', '=', tokenHash)
      .executeTakeFirst();
  }

  async deleteSessionsOfUser(userId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('studio_auth_session')
      .where('user_id', '=', userId)
      .execute();
    return Number(result[0]?.numDeletedRows ?? 0);
  }

  /** Signing out everywhere else: the session that made the change stays. */
  async deleteOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('studio_auth_session')
      .where('user_id', '=', userId)
      .where('id', '!=', keepSessionId)
      .execute();
    return Number(result[0]?.numDeletedRows ?? 0);
  }

  async deleteSessionById(sessionId: string): Promise<void> {
    await this.db
      .deleteFrom('studio_auth_session')
      .where('id', '=', sessionId)
      .execute();
  }

  /** Idle bookkeeping: the row is touched at most once a minute per session. */
  async touchSession(sessionId: string, now: Date): Promise<void> {
    await this.db
      .updateTable('studio_auth_session')
      .set({ updated_at: now.toISOString() })
      .where('id', '=', sessionId)
      .execute();
  }

  async audit(row: StudioAuthAuditRow): Promise<void> {
    await this.db.insertInto('studio_auth_audit').values(row).execute();
  }
}
