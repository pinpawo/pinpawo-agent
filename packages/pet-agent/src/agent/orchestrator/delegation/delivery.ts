import type { DelegationMessageScope } from '../../messages';

/** Execution evidence, independent of provider messages and task acceptance. */
export type DelegationDelivery = {
  readonly id: string;
  readonly scope: DelegationMessageScope & { readonly traceId: string };
  readonly task: string;
  readonly text: string;
};

export function mergeDelegationDeliveries(
  previous: readonly DelegationDelivery[],
  updates: readonly DelegationDelivery[],
): DelegationDelivery[] {
  const byId = new Map(previous.map((delivery) => [delivery.id, delivery]));
  for (const delivery of updates) byId.set(delivery.id, delivery);
  return [...byId.values()];
}
