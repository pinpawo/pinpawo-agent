/**
 * Browser Runtime page lifecycle primitives.
 *
 * These are pure, unit-testable state machines and policies that the Browser
 * Runtime (and eventually the extension/CDP driver) uses to manage each browser
 * operation as a full lifecycle: request → commit → settle → readable|failed.
 */
export * from './navigation';
export * from './events';
export * from './targets';
export * from './waiter';
export * from './errorCodes';
export * from './controller';
export * from './openReadiness';
export * from './interactionSettle';
export * from './bridgeBinding';
