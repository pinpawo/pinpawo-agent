import type { AgentCapability, AgentToolkit, PetDocument } from '@pinpawo/pet-agent';
import type { StudioContextProvider } from '@pinpawo/studio-core';
import { createChannelPlugin } from '../../../plugins/channel/src/channelPlugin.ts';
import { channelMigrations, KyselyChannelStore, type ChannelDatabase } from '../../../plugins/channel/src/store/kysely/index.ts';
import { createStudioStorage } from '../../../packages/studio/src/storage/studioStorage.ts';
import { buildLocalChatAgentInput, type AgentChannelSetup } from '../../../services/host/src/agent/agentChannel.ts';
import { buildHostRuntimeConfig } from '../../../services/host/src/config/runtimeConfig.ts';
import { snapshotInvocationContext, withInvocationContext } from '../../../services/host/src/host/invocationSystemContext.ts';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles.ts';
import { createStudioWithPets } from '../../support/livePets.ts';

export const studioPetEvalChannelId = 'synthetic-pet-role-eval';
const occurredAt = '2026-01-01T00:00:00.000Z';

/**
 * Reuse the real scoped provider and Host assembly, rather than reconstructing
 * their prompt sections or invocation hint. Only the dispatch execution port is replaced: it
 * captures a setup without running a model, queue, checkpoint, or domain tool.
 * Resident admission/resume and the full execution chain have separate e2e tests.
 */
export async function assembleStudioPetInvocation(params: {
  role: string;
  pet: PetDocument;
  capabilities: AgentCapability[];
  toolkits: AgentToolkit[];
  defaultCapabilityName: string;
  announcement: string;
  request?: string;
}) {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  let studio: Awaited<ReturnType<typeof createStudioWithPets>> | undefined;
  let resolver!: StudioContextProvider;
  let captured: AgentChannelSetup | undefined;
  try {
    const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
    const channel = createChannelPlugin({ httpRoute: false, store });
    studio = await createStudioWithPets({
      studioId: 'synthetic-pet-role-eval', plugins: [channel],
      onPreparedContextResolver: value => { resolver = value; },
      pets: [{ registration: { petId: params.role, name: params.role }, dispatch: {
        getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
        dispatch: async input => {
          if (!input.scope || !input.session) throw new Error('Role eval requires a bound Channel invocation.');
          const invocationContext = snapshotInvocationContext(await resolver({
            petId: params.role, sessionId: input.session.id, scope: input.scope, request: input.request,
          }));
          const setup = buildLocalChatAgentInput({
            context: { pet: { id: params.role, name: params.role } }, userMessage: input.request,
            llmConfig: createTestModelProfiles().resolve(),
            hostConfig: {
              // A stable synthetic path; no files or session state are opened.
              runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-synthetic-role-eval'),
              toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
            },
            threadId: input.session.id, sessionStartedAt: occurredAt, timezone: 'Asia/Shanghai',
            petDocument: params.pet, defaultCapabilityName: params.defaultCapabilityName,
            capabilities: params.capabilities, toolkits: params.toolkits,
            capabilityArtifactStore: {
              writeArtifact: async () => { throw new Error('Decision eval cannot write artifacts.'); },
              readArtifact: async () => { throw new Error('Decision eval cannot read artifacts.'); },
              listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri,
            },
          });
          captured = withInvocationContext(setup, invocationContext);
        },
      } }],
    });
    // Seed a persisted fixture with stable IDs for repeatable model inputs.
    // The production provider still checks its real membership/session records.
    await store.transaction(async transaction => {
      await transaction.createChannel({ channelId: studioPetEvalChannelId,
        title: '示例笔记项目', description: '合成的项目协作案例。', prompt: params.announcement,
        createdBy: { kind: 'human', id: 'owner' }, createdAt: occurredAt, updatedAt: occurredAt,
      });
      for (const member of [{ kind: 'human' as const, id: 'owner' }, { kind: 'pet' as const, id: params.role }]) {
        await transaction.upsertMember({ ...member, channelId: studioPetEvalChannelId, joinedAt: occurredAt });
      }
    });
    const binding = await channel.service.reserveSession(studioPetEvalChannelId, params.role, () => `${params.role}:role-eval`);
    await studio.dispatch({ petId: params.role, request: params.request ?? 'Prepare the synthetic decision context.',
      session: { id: binding.sessionId, create: true }, scope: { namespace: 'channel', id: studioPetEvalChannelId },
    });
    if (!captured) throw new Error('Studio did not deliver the evaluation invocation.');
    return captured;
  } finally {
    try { await studio?.shutdown(); } finally { await storage.close(); }
  }
}
