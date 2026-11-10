import type { StudioPlugin } from '../studioContract';

/** Core-only fixture: validates known owners without depending on a concrete Plugin. */
export function withTestPetChannel(plugins: StudioPlugin[] = [], channelIds = ['one']): StudioPlugin[] {
  const petChannels = { requireChannel: async (channelId: string) => {
    if (!channelIds.includes(channelId)) throw new Error(`Unknown test Channel: ${channelId}`);
  } };
  return plugins.some(plugin => plugin.name === 'channel')
    ? plugins.map(plugin => plugin.name === 'channel' ? { ...plugin, petChannels } : plugin)
    : [...plugins, { name: 'channel', toolkits: [], petChannels, start() {} }];
}
