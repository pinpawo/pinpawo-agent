import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getAgentMessageMetadata, getAgentMessageRunId } from '../agent/messages';

/** Trusted Host opt-in for one optional response, never inferred from message text. */
export const optionalResponseSchema = z.object({
  source: z.string().trim().min(1).max(512),
  messageId: z.string().trim().min(1).max(256),
}).strict().readonly();
export type OptionalResponse = z.infer<typeof optionalResponseSchema>;
export const SILENT_RESPONSE_TOOL_NAME = 'finish_without_reply';

/** Only the runtime's validated control receipt, not model prose, is a silent outcome. */
export function isSilentResponseReceipt(message: BaseMessage | undefined, permission: OptionalResponse, runId: string): boolean {
  if (!message || !ToolMessage.isInstance(message) || message.name !== SILENT_RESPONSE_TOOL_NAME) return false;
  const metadata = getAgentMessageMetadata(message);
  const outcome = metadata.optionalResponse;
  return metadata.synthetic === true && !!runId && getAgentMessageRunId(message) === runId
    && !!outcome && typeof outcome === 'object'
    && (outcome as Record<string, unknown>).source === permission.source
    && (outcome as Record<string, unknown>).messageId === permission.messageId;
}
