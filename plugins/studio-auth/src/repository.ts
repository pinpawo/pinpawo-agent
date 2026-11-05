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
  /**
   * Bumped every time the password changes. A session carries the version it
   * was minted under, so a login that raced a password change cannot leave a
   * working session behind.
   */
  credential_version: number | null;
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
  /** The user's `credential_version` at the moment this session was minted. */
  credential_version: number | null;
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

  /**
   * The hash to verify and the version it belongs to, read as one consistent
   * pair: verifying a hash against a newer version would let a stale password
   * mint a session that looks current.
   */
  async credentialSnapshot(userId: string): Promise<{ hash?: string; version: number }> {
    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('studio_auth_user')
        .select(['credential_version'])
        .where('id', '=', userId)
        .executeTakeFirst();
      const account = await trx
        .selectFrom('studio_auth_account')
        .select(['password'])
        .where('user_id', '=', userId)
        .where('provider_id', '=', CREDENTIAL_PROVIDER_ID)
        .executeTakeFirst();
      return { hash: account?.password ?? undefined, version: user?.credential_version ?? 0 };
    });
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

  async credentialVersion(userId: string): Promise<number> {
    const row = await this.db
      .selectFrom('studio_auth_user')
      .select(['credential_version'])
      .where('id', '=', userId)
      .executeTakeFirst();
    return row?.credential_version ?? 0;
  }

  /**
   * Mint a session only if the credential version this login verified against
   * is still the current one. The check and the insert share one transaction,
   * so a password change that lands while a password is being verified cannot
   * leave a session minted from the old credential.
   */
  async createSession(row: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
    credentialVersion: number;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('studio_auth_user')
        .select(['credential_version'])
        .where('id', '=', row.userId)
        .executeTakeFirst();
      if ((user?.credential_version ?? 0) !== row.credentialVersion) return false;

      await trx
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
          credential_version: row.credentialVersion,
        })
        .execute();
      return true;
    });
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

  /**
   * Replace the password and revoke everything issued under the old one, in a
   * single transaction. The version bump is what makes a concurrent login
   * notice that the credential it verified is stale.
   *
   * `keepSessionId` is for the self-service change: the session that performed
   * the change survives, re-stamped with the new version, while every other
   * session of that user is revoked.
   */
  async replaceCredential(
    userId: string,
    hash: string,
    options: { keepSessionId?: string } = {},
  ): Promise<{ version: number; revoked: number }> {
    return this.db.transaction().execute(async (trx) => {
      const now = new Date().toISOString();
      await trx
        .updateTable('studio_auth_user')
        .set((expression) => ({
          credential_version: expression(
            expression.fn.coalesce('credential_version', expression.val(0)),
            '+',
            1,
          ),
          updated_at: now,
        }))
        .where('id', '=', userId)
        .execute();

      const user = await trx
        .selectFrom('studio_auth_user')
        .select(['credential_version'])
        .where('id', '=', userId)
        .executeTakeFirst();
      const version = user?.credential_version ?? 0;

      const updated = await trx
        .updateTable('studio_auth_account')
        .set({ password: hash, updated_at: now })
        .where('user_id', '=', userId)
        .where('provider_id', '=', CREDENTIAL_PROVIDER_ID)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) === 0) {
        throw new Error('This user has no password credential to update.');
      }

      // Inside the same transaction: the revocation and the version bump must
      // not be observable apart.
      const deleted = options.keepSessionId
        ? await trx
          .deleteFrom('studio_auth_session')
          .where('user_id', '=', userId)
          .where('id', '!=', options.keepSessionId)
          .execute()
        : await trx
          .deleteFrom('studio_auth_session')
          .where('user_id', '=', userId)
          .execute();
      const revoked = Number(deleted[0]?.numDeletedRows ?? 0);
      if (options.keepSessionId) {
        await trx
          .updateTable('studio_auth_session')
          .set({ credential_version: version, updated_at: now })
          .where('id', '=', options.keepSessionId)
          .execute();
      }
      return { version, revoked };
    });
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
