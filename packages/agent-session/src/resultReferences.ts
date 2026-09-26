import type { AgentResultReference } from './domain';

export function parseResultReferences(value: unknown): AgentResultReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id
      || typeof item.title !== 'string' || typeof item.text !== 'string' || !item.text.trim()
      || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, title: item.title, text: item.text }];
  });
}
