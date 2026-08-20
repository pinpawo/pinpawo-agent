/**
 * Pet identity for the local host.
 *
 * Selecting among account-backed pets was removed with the hosted-app relay:
 * there is no backend to enumerate them. The host runs one local pet; a Studio
 * plugin owns multi-pet identity (#638).
 */
export const LOCAL_ACTOR_ID = 'local-only';
export const LOCAL_ACTOR_NAME = 'Local Agent';
