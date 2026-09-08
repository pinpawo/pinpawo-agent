import type { PetConfig } from './petConfig';

/**
 * Chat runs exactly one Pet. Multi-Pet identity belongs to Studio (#638), which
 * reads its Pets from the same `pets/` directory this default stands in for.
 *
 * The Chat Host uses this when no Pet configuration file exists, so an install
 * that never writes one behaves exactly as it did when the identity was two
 * hardcoded constants.
 */
export const DEFAULT_CHAT_PET: PetConfig = Object.freeze({
  petId: 'local-only',
  name: 'Local Agent',
});
