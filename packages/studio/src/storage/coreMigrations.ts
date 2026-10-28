import { secretMigrations } from '../secrets/migrations';
import { clientMigrations } from '../clients/store/kysely';
import { petMigrations } from '../pets/store/kysely';
import type { StudioMigrations } from './studioStorage';

/** Studio core's own tables: client identities, Pet instances and encrypted Secrets, under one migration history (owner `studio`). */
export const studioCoreMigrations: StudioMigrations = { ...clientMigrations, ...petMigrations, ...secretMigrations };
