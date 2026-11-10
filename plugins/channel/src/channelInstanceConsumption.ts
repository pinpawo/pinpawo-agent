import { randomUUID } from 'node:crypto';
import type { ChannelConsumptionRow, ChannelStore } from './store/channelStore';

/**
 * Called from the authoritative instance registry before assembly/live admission,
 * outside its data transaction. Never infer ownership from raw membership rows.
 */
export function enrollChannelInstance(store: ChannelStore, instance: { channelId: string; petId: string }): Promise<ChannelConsumptionRow> {
  return store.transaction(async transaction => {
    // The same lock serializes append commits and this initial cutoff.
    if (!await transaction.lockChannel(instance.channelId)) throw new Error(`No owner Channel "${instance.channelId}".`);
    const existing = await transaction.getConsumption(instance.channelId, instance.petId);
    if (existing) {
      const activationId = randomUUID();
      await transaction.setConsumptionActivation(instance.channelId, instance.petId, activationId);
      return { ...existing, activationId };
    }
    const tail = await transaction.readMessages(instance.channelId, { limit: 1 });
    const baseline = { channelId: instance.channelId, petId: instance.petId, activationId: randomUUID(), afterSequence: tail.nextAfter };
    await transaction.enrollConsumption(baseline);
    return baseline;
  });
}

/** Invalidate outstanding batches without deleting or moving the instance cursor. */
export function revokeChannelInstance(store: ChannelStore, instance: { channelId: string; petId: string }): Promise<void> {
  return store.transaction(async transaction => {
    if (!await transaction.lockChannel(instance.channelId)) throw new Error(`No owner Channel "${instance.channelId}".`);
    await transaction.setConsumptionActivation(instance.channelId, instance.petId, randomUUID());
  });
}
