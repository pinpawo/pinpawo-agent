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
  studio_auth_audit: StudioAuthAuditRow;
};

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

  /** Count one failed login and lock the account once the threshold is reached. */
  async recordFailedAttempt(
    userId: string,
    policy: { maxAttempts: number; lockMinutes: number },
  ): Promise<string | null> {
    const row = await this.findUserById(userId);
    const attempts = (row?.failed_attempts ?? 0) + 1;
    const lockedUntil = attempts >= policy.maxAttempts
      ? new Date(Date.now() + policy.lockMinutes * 60_000).toISOString()
      : null;
    await this.db
      .updateTable('studio_auth_user')
      .set({
        failed_attempts: lockedUntil ? 0 : attempts,
        locked_until: lockedUntil,
        updated_at: new Date().toISOString(),
      })
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

  async deleteSessionsOfUser(userId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('studio_auth_session')
      .where('user_id', '=', userId)
      .execute();
    return Number(result[0]?.numDeletedRows ?? 0);
  }

  /** Signing out everywhere else: the session that made the change stays. */
  async deleteOtherSessions(userId: string, keepToken: string): Promise<number> {
    const result = await this.db
      .deleteFrom('studio_auth_session')
      .where('user_id', '=', userId)
      .where('token', '!=', keepToken)
      .execute();
    return Number(result[0]?.numDeletedRows ?? 0);
  }

  async deleteSessionByToken(token: string): Promise<void> {
    await this.db
      .deleteFrom('studio_auth_session')
      .where('token', '=', token)
      .execute();
  }

  async findSessionByToken(token: string): Promise<StudioAuthSessionRow | undefined> {
    return this.db
      .selectFrom('studio_auth_session')
      .selectAll()
      .where('token', '=', token)
      .executeTakeFirst();
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
