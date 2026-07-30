import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import {
  type BaseMessage,
  mapStoredMessageToChatMessage,
} from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import {
  ChatOpenAI,
  type ChatOpenAICallOptions,
  type ChatOpenAIFields,
} from '@langchain/openai';
import type { ModelInputModality } from './modelProfiles';
import {
  LOCAL_IMAGE_REFERENCE_SCHEME,
  LocalChatImageStore,
} from './localImageAttachments';

export type LocalImageModelInputOptions = {
  imageStore?: LocalChatImageStore;
  supportedInputModalities: readonly ModelInputModality[];
  admitInputModalities?: (
    required: readonly ModelInputModality[],
  ) => void | Promise<void>;
};

export function readRequiredInputModalities(
  messages: readonly BaseMessage[],
): ModelInputModality[] {
  for (const message of messages) {
    if (
      Array.isArray(message.content)
      && message.content.some((block) => readImageUrl(block) !== null)
    ) {
      return ['text', 'image'];
    }
  }
  return ['text'];
}

export async function prepareLocalImageModelMessages(
  messages: readonly BaseMessage[],
  options: LocalImageModelInputOptions,
): Promise<BaseMessage[]> {
  const required = readRequiredInputModalities(messages);
  if (
    required.includes('image')
    && !options.supportedInputModalities.includes('image')
  ) {
    throw new Error(
      'The selected model profile cannot invoke image input for this session.',
    );
  }
  await options.admitInputModalities?.(required);
  let changed = false;
  const prepared: BaseMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      prepared.push(message);
      continue;
    }
    let messageChanged = false;
    const content = [];
    for (const block of message.content) {
      const imageUrl = readImageUrl(block);
      if (!imageUrl?.startsWith(LOCAL_IMAGE_REFERENCE_SCHEME)) {
        content.push(block);
        continue;
      }
      if (!options.imageStore) {
        throw new Error(
          'Local image input cannot be rehydrated without a host image store.',
        );
      }
      const image = await options.imageStore.read(imageUrl);
      const dataUrl = `data:${image.mimeType};base64,${
        image.bytes.toString('base64')
      }`;
      if (
        typeof block === 'object'
        && block !== null
        && 'type' in block
        && block.type === 'image'
      ) {
        content.push({
          ...block,
          url: dataUrl,
        });
      } else {
        content.push({
          ...block,
          image_url: {
            ...(typeof block === 'object'
              && block !== null
              && 'image_url' in block
              && typeof block.image_url === 'object'
              && block.image_url !== null
              ? block.image_url
              : {}),
            url: dataUrl,
          },
        });
      }
      messageChanged = true;
    }
    if (!messageChanged) {
      prepared.push(message);
      continue;
    }
    changed = true;
    const stored = message.toDict();
    (stored.data as { content: unknown }).content = content;
    prepared.push(mapStoredMessageToChatMessage(stored));
  }
  return changed ? prepared : [...messages];
}

export class LocalImageChatOpenAI<
  CallOptions extends ChatOpenAICallOptions = ChatOpenAICallOptions,
> extends ChatOpenAI<CallOptions> {
  private readonly localImageInput: LocalImageModelInputOptions;

  constructor(
    fields: ChatOpenAIFields,
    localImageInput: LocalImageModelInputOptions,
  ) {
    super(fields);
    this.localImageInput = localImageInput;
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return super._generate(
      await prepareLocalImageModelMessages(messages, this.localImageInput),
      options,
      runManager,
    );
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* super._streamResponseChunks(
      await prepareLocalImageModelMessages(messages, this.localImageInput),
      options,
      runManager,
    );
  }

  override async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatModelStreamEvent> {
    yield* super._streamChatModelEvents(
      await prepareLocalImageModelMessages(messages, this.localImageInput),
      options,
      runManager,
    );
  }
}

function readImageUrl(value: unknown): string | null {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return null;
  }
  if ((value as { type?: unknown }).type === 'image') {
    const url = (value as { url?: unknown }).url;
    return typeof url === 'string' ? url : '';
  }
  if ((value as { type?: unknown }).type !== 'image_url') return null;
  const imageUrl = (value as { image_url?: unknown }).image_url;
  if (typeof imageUrl === 'string') return imageUrl;
  if (
    imageUrl
    && typeof imageUrl === 'object'
    && !Array.isArray(imageUrl)
    && typeof (imageUrl as { url?: unknown }).url === 'string'
  ) {
    return (imageUrl as { url: string }).url;
  }
  return null;
}
