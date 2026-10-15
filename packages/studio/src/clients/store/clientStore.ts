export type ClientRow = {
  clientId: string;
  label: string;
  createdAt: string;
  /** Absent while the client may connect. */
  revokedAt?: string;
};

export type ClientKeyRow = {
  /** SHA-256 of the key, hex. The key itself is never stored. */
  keyHash: string;
  clientId: string;
  createdAt: string;
  revokedAt?: string;
};

/**
 * Studio client persistence. Data operations only; the rules (id format, key
 * generation, who may connect) belong to StudioClients above it.
 */
export interface ClientStore {
  /** Runs `work` atomically against the store it is given; nested calls join the outer transaction. */
  transaction<T>(work: (store: ClientStore) => Promise<T>): Promise<T>;
  /** Inserts the client; returns false when the id is already taken. */
  createClient(row: ClientRow): Promise<boolean>;
  getClient(clientId: string): Promise<ClientRow | undefined>;
  /** In creation order. */
  listClients(): Promise<ClientRow[]>;
  revokeClient(clientId: string, revokedAt: string): Promise<void>;
  addKey(row: ClientKeyRow): Promise<void>;
  getKey(keyHash: string): Promise<ClientKeyRow | undefined>;
}
