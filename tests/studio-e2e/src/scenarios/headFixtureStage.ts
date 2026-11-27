/** Inspect structured contracts, never task wording, to identify a scripted Head stage. */
export function headFixtureStage(input: {
  tools?: unknown[];
  messages: Array<{ role: string; content?: unknown }>;
}): 'relevance' | 'dispatch' {
  const first = input.tools?.[0] as { function?: { name?: string } } | undefined;
  const name = first?.function?.name;
  if (name === 'pet_head_relevance') return 'relevance';
  if (name === 'pet_head_dispatch') return 'dispatch';
  for (const message of input.messages) {
    if (message.role !== 'system' || typeof message.content !== 'string') continue;
    for (const line of message.content.split('\n')) {
      try {
        const schema = JSON.parse(line);
        if (schema.type !== 'object') continue;
        if (schema.properties?.relevant) return 'relevance';
        if (schema.properties?.shouldDispatch && schema.properties?.reply) return 'dispatch';
      } catch { /* Policy prose is not a schema. */ }
    }
  }
  throw new Error('Unknown Head fixture schema');
}
