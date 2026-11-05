/**
 * Capabilities a Studio principal may hold. They are additive on top of the
 * two existing scopes: a `studio`-scope token holds everything, while a
 * `client`-scope principal reaches exactly the routes whose capability it holds.
 */
export const STUDIO_CAPABILITIES = [
  'channel.read',
  'channel.write',
  'studio.view',
  'studio.dispatch',
  'studio.events',
  'pet.session',
  'studio.manage',
] as const;

export type StudioCapability = (typeof STUDIO_CAPABILITIES)[number];

/**
 * What a freshly created user may do: read and write Channels, and read the
 * Studio projections. Anything that runs work (`studio.dispatch`,
 * `pet.session`) or changes the Studio (`studio.manage`) stays an explicit grant.
 *
 * `channel.write` is wider than it looks: posting a message that mentions a
 * Pet member (`mentions: [{ participantId: 'pet:<id>' }]`) runs that Pet
 * through `ChannelPlugin.dispatchPet()` → `host().dispatch()`. `studio.dispatch`
 * only gates the direct HTTP `POST /dispatch` route, so a user with
 * `channel.write` can start work from inside a Channel without holding it.
 * That split is deliberate: Channel authority is membership plus an
 * unrevoked client, and layering a second rule on the dispatch entry would
 * make the same `@pet` depend on two different grants. See
 * `docs/design/studio/user-auth.md` §3.5.1.
 */
export const DEFAULT_USER_CAPABILITIES: readonly StudioCapability[] = [
  'channel.read',
  'channel.write',
  'studio.view',
];

const KNOWN = new Set<string>(STUDIO_CAPABILITIES);

/** Store order-stable, de-duplicated capabilities; unknown names are rejected. */
export function normalizeCapabilities(value: unknown): StudioCapability[] {
  if (!Array.isArray(value)) throw new Error('Capabilities must be an array of capability names.');
  const seen = new Set<StudioCapability>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !KNOWN.has(entry)) {
      throw new Error(`Unknown Studio capability: ${String(entry)}.`);
    }
    seen.add(entry as StudioCapability);
  }
  return STUDIO_CAPABILITIES.filter((capability) => seen.has(capability));
}

export function parseStoredCapabilities(value: string | null | undefined): StudioCapability[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return normalizeCapabilities(parsed);
  } catch {
    return [];
  }
}
