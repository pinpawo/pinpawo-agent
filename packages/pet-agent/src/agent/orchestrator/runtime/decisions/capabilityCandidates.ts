import type { BaseMessage } from '@langchain/core/messages';
import type { CapabilitySearchDocument } from '../../capabilitySearch';
import { isContextCompactionMessage } from '../../contextCompaction';
import { mainConversationMessages } from '../../messageLanes';
import type { CompiledAgentRegistry } from '../../registry';
import { clipForPrompt } from '../../utils';

export function mainMessagesWithoutCompaction(messages: BaseMessage[]): BaseMessage[] {
  return mainConversationMessages(messages).filter((message) => !isContextCompactionMessage(message));
}

type CompiledCapability = CompiledAgentRegistry['capabilities'][number];

export function buildCompiledCapabilityDescription(
  compiled: CompiledCapability,
): string {
  const toolkitScope = compiled.toolkits.length > 0
    ? compiled.toolkits
        .map((toolkit) =>
          `${toolkit.name}（${clipForPrompt(toolkit.description, 240)}）`)
        .join('；')
    : '无（仅 instructions）';
  return clipForPrompt(
    `${compiled.capability.description} Toolkit scope：${toolkitScope}`,
    2_000,
  );
}

export function buildCompiledCapabilitySearchDocuments(
  compiledCapabilities: readonly CompiledCapability[],
): CapabilitySearchDocument[] {
  return compiledCapabilities.map((compiled) => ({
    name: compiled.capability.name,
    description: buildCompiledCapabilityDescription(compiled),
  }));
}
