import type { BaseMessage } from '@langchain/core/messages';

/**
 * Marks a message as model-facing media that must not reach a summarization
 * prompt. Tools that return images keep them in graph state so later turns can
 * still inspect them, but LangChain's summarization renders messages with
 * `getBufferString`, which would inline a base64 payload as plain text.
 */
const TRANSIENT_MODEL_MEDIA_KEY = 'pinpawoTransientModelMedia';

export function markTransientModelMedia<TMessage extends BaseMessage>(
  message: TMessage,
): TMessage {
  message.additional_kwargs = {
    ...message.additional_kwargs,
    [TRANSIENT_MODEL_MEDIA_KEY]: true,
  };
  return message;
}

export function isTransientModelMedia(message: BaseMessage) {
  return message.additional_kwargs?.[TRANSIENT_MODEL_MEDIA_KEY] === true;
}
