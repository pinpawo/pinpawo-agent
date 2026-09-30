/**
 * Test fixtures for Hosts and evals. Production code never writes these
 * records directly; the Supervisor's delegate_capability tool does.
 */
export {
  createCapabilityExecutionMessage,
  createRejectedCapabilityExecutionMessage,
  type CapabilityExecutionRecord,
  type CapabilityExecutionResultRecord,
} from '../agent/orchestrator/executionMessages';
export { createDeliveryResult, readFixtureDelivery, withDeliveryCalls } from './capabilityDelivery';
