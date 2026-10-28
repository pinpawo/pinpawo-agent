import type { PetConfig } from './config/petConfig';

/**
 * Chat runs exactly one Pet, under its definition id: there is no instance
 * layer here. Pet instances belong to Studio (#1015), which creates them from
 * the definitions in the same `pets/` directory this default stands in for.
 *
 * The Chat Host uses this when no Pet configuration file exists, so an install
 * that never writes one behaves exactly as it did when the identity was two
 * hardcoded constants.
 */
export const DEFAULT_CHAT_PET: PetConfig = Object.freeze({
  definitionId: 'local-only',
  name: 'Local Agent',
});
