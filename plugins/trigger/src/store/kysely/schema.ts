import type { Generated } from 'kysely';
import type { TriggerDeliveryEvent, TriggerDeliveryStatus } from '../triggerStore';

/** The Trigger's tables in the Studio database. */
export type TriggerDatabase = {
  trigger_deliveries: {
    delivery_id: string;
    trigger_id: string;
    idempotency_key: string;
    target_pet_id: string | null;
    request: string | null;
    status: TriggerDeliveryStatus;
    note: string | null;
    invocation_id: string | null;
    session_id: string | null;
    occurred_at: string;
    updated_at: string;
  };
  trigger_delivery_events: {
    sequence: Generated<number>;
    delivery_id: string;
    trigger_id: string;
    event_type: TriggerDeliveryEvent['eventType'];
    status: TriggerDeliveryStatus;
    note: string | null;
    occurred_at: string;
  };
};
