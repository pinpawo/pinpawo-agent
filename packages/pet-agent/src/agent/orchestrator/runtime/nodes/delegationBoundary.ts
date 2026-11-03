import type { RunnableConfig } from '@langchain/core/runnables';
import type { OrchestratorStateType } from '../../state';
import { getInvokeOptions } from '../config';

/**
 * Run in a separate Root step so cancellation cannot discard the preceding
 * delegation result. The Host owns pending input and may abort this invocation;
 * its next fresh input follows the existing Entry / continue path.
 */
export async function delegationBoundary(_state: OrchestratorStateType, config?: RunnableConfig) {
  config?.signal?.throwIfAborted();
  await getInvokeOptions(config).onDelegationComplete?.();
  config?.signal?.throwIfAborted();
  return {};
}
