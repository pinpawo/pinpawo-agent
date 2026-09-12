import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { buildLocalChatAgentInput } from '../agentChannel';
import type { loadAgentContext } from '../contextLoader';
import { createCapabilityDiagnosticReporter } from '../agentRegistryPreparation';
import {
  getLocalServerToolkitInventory,
  type ChatSetupDeps,
} from '../serverTypes';

/**
 * What assembling an execution needs from the session it runs in.
 *
 * Deliberately just three values: the thread to run against, the model that
 * thread selected, and when it started. Session resolves these; everything
 * else below comes from Host-held services. Assembly does not reach into the
 * session registry, and Session does not need to know what a graph looks
 * like.
 */
export type ChatSetupSession = {
  threadId: string;
  modelProfileId: string;
  startedAt: string;
};

export type BuildChatSetupOptions = {
  deps: ChatSetupDeps;
  context: Awaited<ReturnType<typeof loadAgentContext>>;
  session: ChatSetupSession;
  checkpointer: BaseCheckpointSaver;
  reportCapabilityDiagnostics: ReturnType<typeof createCapabilityDiagnosticReporter>;
};

/**
 * Build one execution's input from a resolved session identity plus the
 * Host's services.
 */
export function buildChatSetup(options: BuildChatSetupOptions) {
  const { deps, session } = options;
  const llmConfig = deps.modelProfiles.resolve(session.modelProfileId);
  // Compatibility is enforced where the transcript is readable: model
  // selection checks the checkpoint, and image attachments are refused at
  // admission. Building the graph is synchronous, so it does not re-check
  // against a stored copy that could disagree with the transcript.
  const toolkitInventory = getLocalServerToolkitInventory(deps);
  return buildLocalChatAgentInput({
    context: options.context,
    userMessage: '',
    llmConfig,
    hostConfig: deps,
    toolkits: [...toolkitInventory.effectiveToolkits],
    toolkitInventoryEntries: toolkitInventory.entries,
    toolkitRuntimeManager: deps.toolkitRuntimeManager,
    reportCapabilityDiagnostics: options.reportCapabilityDiagnostics,
    capabilities: deps.capabilityCatalog.getSnapshot().capabilities,
    ...(deps.defaultCapabilityName !== undefined
      ? { defaultCapabilityName: deps.defaultCapabilityName }
      : {}),
    ...(deps.petDocument ? { petDocument: deps.petDocument } : {}),
    threadId: session.threadId,
    interfaceKind: 'tui',
    checkpoint: options.checkpointer,
    capabilityArtifactStore: deps.capabilityArtifactStore,
    sessionStartedAt: session.startedAt,
  });
}
