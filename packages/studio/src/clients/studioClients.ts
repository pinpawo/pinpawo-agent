import { createHash, randomBytes } from 'node:crypto';
import type { ClientStore } from './store/clientStore';

/** Someone allowed to connect to this Studio: a person or a program acting for one. */
export type StudioClient = {
  clientId: string;
  label: string;
  createdAt: string;
  revokedAt?: string;
};

/** Thrown for a request that names an unknown client or breaks a client rule. */
export class StudioClientError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'exists' | 'not_found') {
    super(message);
    this.name = 'StudioClientError';
  }
}

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_PREFIX = 'pps_';

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function clientId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!CLIENT_ID.test(id)) {
    throw new StudioClientError('Client id must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.', 'invalid');
  }
  return id;
}

function clientLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > 160) throw new StudioClientError('Client label must be 1-160 characters.', 'invalid');
  return label;
}

/**
 * Studio client identities. A client connects with any of its keys until it is
 * revoked; only SHA-256 hashes of keys are stored, so a key is shown once,
 * when it is created.
 */
export class StudioClients {
  constructor(private readonly store: () => Promise<ClientStore>) {}

  /** The active client a key belongs to. */
  async authenticate(key: string): Promise<StudioClient | undefined> {
    if (!key.startsWith(KEY_PREFIX)) return undefined;
    const store = await this.store();
    const row = await store.getKey(hashKey(key));
    if (!row || row.revokedAt) return undefined;
    const client = await store.getClient(row.clientId);
    return client && !client.revokedAt ? client : undefined;
  }

  async get(id: string): Promise<StudioClient | undefined> {
    return (await this.store()).getClient(id);
  }

  async list(): Promise<StudioClient[]> {
    return (await this.store()).listClients();
  }

  /** Register a client with its first key. The key is returned only here. */
  async create(input: { clientId: unknown; label: unknown }): Promise<{ client: StudioClient; key: string }> {
    const client: StudioClient = { clientId: clientId(input.clientId), label: clientLabel(input.label), createdAt: new Date().toISOString() };
    const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    await (await this.store()).transaction(async (store) => {
      if (!(await store.createClient(client))) throw new StudioClientError(`Client "${client.clientId}" already exists.`, 'exists');
      await store.addKey({ keyHash: hashKey(key), clientId: client.clientId, createdAt: client.createdAt });
    });
    return { client, key };
  }

  /** Register a client that connects without a stored key (the local Host token), if it is not there yet. */
  async ensure(input: { clientId: unknown; label: unknown }): Promise<StudioClient> {
    const client: StudioClient = { clientId: clientId(input.clientId), label: clientLabel(input.label), createdAt: new Date().toISOString() };
    const store = await this.store();
    await store.createClient(client);
    return (await store.getClient(client.clientId))!;
  }

  /** Add another key to an active client, for rotation or a second device. */
  async addKey(id: unknown): Promise<{ clientId: string; key: string }> {
    const target = clientId(id);
    const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    await (await this.store()).transaction(async (store) => {
      const client = await store.getClient(target);
      if (!client || client.revokedAt) throw new StudioClientError(`No active client "${target}".`, 'not_found');
      await store.addKey({ keyHash: hashKey(key), clientId: target, createdAt: new Date().toISOString() });
    });
    return { clientId: target, key };
  }

  /** Stop the client from connecting with any of its keys. Its history stays. */
  async revoke(id: unknown): Promise<StudioClient> {
    const target = clientId(id);
    return (await this.store()).transaction(async (store) => {
      if (!(await store.getClient(target))) throw new StudioClientError(`No client "${target}".`, 'not_found');
      await store.revokeClient(target, new Date().toISOString());
      return (await store.getClient(target))!;
    });
  }
}
