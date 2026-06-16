import { ToolMessage } from '@langchain/core/messages';
import type {
  CapabilityArtifactStore,
  CapabilityMiddlewareContext,
  SubagentResult,
} from '@pinpawo/pet-agent';
import type { ZodType } from 'zod';

function clipText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

/**
 * Deterministically persist a capability's structured result as a JSON result
 * artifact, in code, from an `afterRun` middleware.
 *
 * This replaces the previous "instruct the model to call capability_artifact_write"
 * approach, which silently produced no result when the model skipped the call or
 * the loop stopped early (see issue #137). The real result already lives on the
 * latest schema-valid `ToolMessage.artifact` (tools using
 * `responseFormat: 'content_and_artifact'`); we find it and write it through the
 * capability's own store, then record the ref via the pet-agent sink so it
 * reaches `state.capabilityArtifacts`.
 *
 * The store is supplied by the capability (a host concern, reached by closure),
 * the sink by pet-agent (`ctx.recordCapabilityArtifact`). No-op when either is
 * missing, when threadId is absent, or when no tool artifact matches the schema
 * — the caller stays safe in tests and degraded runtimes.
 */
export async function recordLatestToolResultArtifact(
  result: SubagentResult,
  ctx: CapabilityMiddlewareContext,
  params: {
    store?: CapabilityArtifactStore;
    schema: ZodType;
    title: string;
    schemaName: string;
  },
): Promise<SubagentResult> {
  if (!params.store || !ctx.recordCapabilityArtifact || !ctx.threadId) {
    return result;
  }

  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (!ToolMessage.isInstance(message) || message.artifact === undefined) continue;
    const parsed = params.schema.safeParse(message.artifact);
    if (!parsed.success) continue;

    const content = parsed.data;
    const ref = await params.store.writeArtifact({
      threadId: ctx.threadId,
      capabilityId: ctx.capabilityId,
      delegationId: ctx.delegationId,
      turnId: ctx.turnId,
      artifact: {
        kind: 'result',
        mimeType: 'application/json',
        title: params.title,
        preview: clipText(JSON.stringify(content), 500),
        content,
        schema: { name: params.schemaName, version: 1 },
      },
    });
    await ctx.recordCapabilityArtifact(ref);
    return result;
  }

  return result;
}
