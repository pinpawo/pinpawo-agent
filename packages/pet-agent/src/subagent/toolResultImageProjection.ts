import {
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { createMiddleware, type AnyAgentMiddleware } from 'langchain';

export type ToolResultImageMode = 'native' | 'user_message';

type ToolImage = {
  url: string;
  mimeType: string;
  detail?: 'auto' | 'low' | 'high';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStandardImage(block: Record<string, unknown>): ToolImage | null {
  if (block.type !== 'image') return null;
  const mimeType = typeof block.mimeType === 'string'
    ? block.mimeType
    : typeof block.mime_type === 'string'
      ? block.mime_type
      : 'image/png';
  if (typeof block.url === 'string') {
    return { url: block.url, mimeType, detail: readDetail(block) };
  }
  if (typeof block.data !== 'string') return null;
  return {
    url: `data:${mimeType};base64,${block.data}`,
    mimeType,
    detail: readDetail(block),
  };
}

function readDetail(block: Record<string, unknown>): ToolImage['detail'] {
  if (block.detail === 'auto' || block.detail === 'low' || block.detail === 'high') {
    return block.detail;
  }
  const metadata = isRecord(block.metadata) ? block.metadata : null;
  return metadata?.detail === 'auto'
    || metadata?.detail === 'low'
    || metadata?.detail === 'high'
    ? metadata.detail
    : undefined;
}

function readToolImageContent(message: ToolMessage) {
  if (!Array.isArray(message.content)) return null;
  const text: string[] = [];
  const images: ToolImage[] = [];
  for (const item of message.content) {
    if (!isRecord(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      text.push(item.text);
      continue;
    }
    const image = readStandardImage(item);
    if (image) images.push(image);
  }
  return images.length > 0 ? { text, images } : null;
}

function responseMetadataWithoutStandardContent(message: ToolMessage) {
  const { output_version: _outputVersion, ...responseMetadata } = message.response_metadata;
  return responseMetadata;
}

function projectToolMessage(
  message: ToolMessage,
  mode: ToolResultImageMode,
): { message: ToolMessage; images: ToolImage[] } | null {
  const content = readToolImageContent(message);
  if (!content) return null;
  const fields = {
    artifact: message.artifact,
    additional_kwargs: message.additional_kwargs,
    id: message.id,
    metadata: message.metadata,
    name: message.name,
    response_metadata: responseMetadataWithoutStandardContent(message),
    status: message.status,
    tool_call_id: message.tool_call_id,
  };
  if (mode === 'native') {
    return {
      message: new ToolMessage({
        ...fields,
        content: [
          ...content.text.map((text) => ({ type: 'input_text', text })),
          ...content.images.map((image) => ({
            type: 'input_image',
            image_url: image.url,
            detail: image.detail ?? 'auto',
          })),
        ],
      }),
      images: [],
    };
  }
  return {
    message: new ToolMessage({
      ...fields,
      content: content.text.join('\n\n') || '[Image returned by tool]',
    }),
    images: content.images,
  };
}

function buildSyntheticImageMessage(images: ToolImage[]) {
  return new HumanMessage({
    contentBlocks: [
      { type: 'text', text: 'Attached media from tool result:' },
      ...images.map((image) => ({
        type: 'image' as const,
        url: image.url,
        mimeType: image.mimeType,
      })),
    ],
    additional_kwargs: {
      pinpawo_synthetic_tool_media: true,
    },
  });
}

export function projectToolResultImages(
  messages: readonly BaseMessage[],
  mode: ToolResultImageMode,
): BaseMessage[] {
  const result: BaseMessage[] = [];
  let pendingImages: ToolImage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (ToolMessage.isInstance(message)) {
      const projected = projectToolMessage(message, mode);
      result.push(projected?.message ?? message);
      if (mode === 'user_message' && projected) {
        pendingImages.push(...projected.images);
      }
      const next = messages[index + 1];
      if (!next || !ToolMessage.isInstance(next)) {
        if (pendingImages.length > 0) {
          result.push(buildSyntheticImageMessage(pendingImages));
          pendingImages = [];
        }
      }
      continue;
    }
    result.push(message);
  }
  return result;
}

export function createToolResultImageProjectionMiddleware(
  mode: ToolResultImageMode | undefined,
): AnyAgentMiddleware | null {
  if (!mode) return null;
  return createMiddleware({
    name: 'ToolResultImageProjection',
    wrapModelCall: (request, handler) => handler({
      ...request,
      messages: projectToolResultImages(request.messages, mode),
    }),
  });
}
