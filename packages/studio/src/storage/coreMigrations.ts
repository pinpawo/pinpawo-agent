import { clientMigrations } from '../clients/store/kysely';
import { petMigrations } from '../pets/store/kysely';
import type { StudioMigrations } from './studioStorage';

/** Studio core's own tables: client identities and Pet instances, under one migration history (owner `studio`). */
export const studioCoreMigrations: StudioMigrations = { ...clientMigrations, ...petMigrations };
