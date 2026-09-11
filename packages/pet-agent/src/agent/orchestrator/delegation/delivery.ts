import type { DelegationMessageScope } from '../../messages';

/** Execution evidence, independent of provider messages and task acceptance. */
export type DelegationDelivery = {
  readonly id: string;
  readonly scope: DelegationMessageScope & { readonly traceId: string };
  readonly task: string;
  readonly text: string;
};
