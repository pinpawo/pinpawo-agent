import { ToolMessage } from '@langchain/core/messages';
import type { SubagentResult } from '@pinpawo/pet-agent';
import type { ZodType } from 'zod';

function clipText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function markLatestToolArtifactAsResult(
  result: SubagentResult,
  params: {
    schema: ZodType;
    schemaName: string;
    title: string;
  },
): SubagentResult {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (!ToolMessage.isInstance(message) || message.artifact === undefined) continue;
    const parsed = params.schema.safeParse(message.artifact);
    if (!parsed.success) continue;
    const content = parsed.data;
    message.additional_kwargs = {
      ...message.additional_kwargs,
      pinpawo: {
        ...(message.additional_kwargs?.pinpawo && typeof message.additional_kwargs.pinpawo === 'object'
          ? message.additional_kwargs.pinpawo as Record<string, unknown>
          : {}),
        capabilityArtifacts: [
          {
            kind: 'result',
            mimeType: 'application/json',
            title: params.title,
            preview: clipText(JSON.stringify(content), 500),
            content,
            schema: {
              name: params.schemaName,
              version: 1,
            },
          },
        ],
      },
    };
    return result;
  }
  return result;
}
