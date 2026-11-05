export {
  clientIdForUsername,
  createStudioAuthPlugin,
  createStudioPlugin,
} from './studioAuthPlugin';
export type { CreateStudioAuthPluginOptions, StudioAuthPlugin } from './studioAuthPlugin';
export {
  DEFAULT_USER_CAPABILITIES,
  STUDIO_CAPABILITIES,
  normalizeCapabilities,
  parseStoredCapabilities,
} from './capabilities';
export type { StudioCapability } from './capabilities';
export { AUTH_TABLES, USERNAME_PATTERN, studioAuthOptions } from './authOptions';
export type { StudioAuthConfig } from './authOptions';
export { studioAuthMigrations } from './migrations';
export { StudioAuthRepository } from './repository';
export type {
  StudioAuthAuditRow,
  StudioAuthDatabase,
  StudioAuthSessionRow,
  StudioAuthUserRow,
} from './repository';
