/** Studio's own tables in the Studio database. */
export type ClientDatabase = {
  studio_clients: {
    client_id: string;
    label: string;
    created_at: string;
    revoked_at: string | null;
  };
  studio_client_keys: {
    key_hash: string;
    client_id: string;
    created_at: string;
    revoked_at: string | null;
  };
};
