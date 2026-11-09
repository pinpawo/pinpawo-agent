import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import { parseDeliverables } from '@pinpawo/agent-contracts';
import { randomUUID } from 'node:crypto';
import { copyPetInvocationScope, withPetInvocationContext } from './petInvocationContext';
import { snapshotInvocationContext, withInvocationContext } from './invocationSystemContext';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';

import type { AgentChannelSetup } from '../agent/agentChannel';
import { describeAgentError } from '../agent/errorDiagnostics';
import { projectPendingInterrupt } from '../conversation/pendingInterruptProjection';
import { readPetDispatchMessage, type PetDispatchPort, type ResidentPet } from './contracts';
import {
  readResidentPetRuntimeContext,
  type ResidentPetRuntime,
} from './runtimeContext';

/**
 * The dispatch surface: one-way input, observed rather than steered.
 *
 * A dispatch is another entry into the conversation's own turn pipeline. It
 * keeps only what is its own: admission into the Pet's queue, the session it
 * targets, its invocation context, and the lifecycle it reports to observers.
 * Running, cancelling and failing a turn are the pipeline's, so a dispatch
 * handles each exactly as a chat request does.
 */
export function createResidentPet(runtime: ResidentPetRuntime): ResidentPet {
  const context = readResidentPetRuntimeContext(runtime);
  const {
    coordinator,
    runtimeDeps,
    graphService,
    runAgentTurn,
    resolveInvocationContext,
    loadContext,
    sessions,
    localHandlers,
    hostPeer,
    openSessionPeer,
    dispatchLifecycleListeners,
    publishDispatchLifecycle,
  } = context;

  const dispatch: PetDispatchPort = {
    getQueueSnapshot: () => coordinator.getQueueSnapshot(),
    onQueueChange: (listener) => coordinator.onQueueChange(listener),
    onDispatchLifecycle: (listener) => {
      dispatchLifecycleListeners.add(listener);
      return () => dispatchLifecycleListeners.delete(listener);
    },
    dispatch: async ({ request, attachments, dispatchId: suppliedDispatchId, scope: suppliedScope, session: suppliedSession, delivery }) => {
      const artifactReferences = attachments === undefined ? [] : parseDeliverables(attachments);
      if (delivery !== undefined && delivery !== 'interrupt') throw new Error('Unsupported dispatch delivery.');
      if (delivery === 'interrupt' && (!suppliedSession?.id || !suppliedScope)) {
        throw new Error('Interrupt delivery requires an explicit session and scope.');
      }
      const dispatchId = suppliedDispatchId?.trim() || randomUUID();
      const scope = suppliedScope ? copyPetInvocationScope(suppliedScope) : undefined;
      const session = suppliedSession ? { ...suppliedSession } : undefined;
      const petId = runtime.petId;
      const resolved = scope && resolveInvocationContext
        ? await resolveInvocationContext(Object.freeze({ petId, ...(session ? { sessionId: session.id } : {}), scope: Object.freeze({ ...scope }), request }))
        : undefined;
      if (context.isClosing()) throw new Error('Resident Pet is closing.');
      const invocationContext = snapshotInvocationContext(resolved);
      // Resolve and persist before admission; neither queue time nor a TUI switch
      // may change the target. Legacy callers retain active-session behavior.
      const target = session
        ? sessions.ensureDispatchSession(petId, session.id, session.create === true)
        : undefined;
      let pendingInterrupt: PendingInterruptProjection | undefined;
      const publishLifecycle: typeof publishDispatchLifecycle = (event) => publishDispatchLifecycle({
        ...event, ...(scope ? { scope: copyPetInvocationScope(scope) } : {}),
        ...(event.state === 'waiting' && pendingInterrupt ? { pendingInterrupt } : {}),
        ...(target ? { sessionId: target.id } : {}),
      });
      const readTargetSetup = async () => sessions.buildSessionSetup(runtimeDeps.get(), await loadContext(petId), target!.id);
      const readSetup = async () => target
        ? readTargetSetup()
        : sessions.buildChatSetup(runtimeDeps.get(), await loadContext(petId));
      // Whoever resumes this review continues the dispatch; see continueSuspendedDispatch.
      const suspend = (setup: AgentChannelSetup, pending: PendingInterruptProjection) => {
        const session = target ?? sessions.findSessionByThread(petId, setup.input.threadId);
        if (!session) throw new Error('A waiting dispatch has no session to resume from.');
        sessions.setPendingDispatch(session.id, {
          interruptId: pending.interruptId, dispatchId, request, ...(scope ? { scope } : {}),
          ...invocationContext,
        });
      };

      coordinator.submitDispatch(() => AsyncLocalStorageProviderSingleton.runWithConfig(
        { callbacks: [] },
        async () => {
          // A Plugin can submit the next Pet while still inside the current Pet's
          // LangChain tool/event callback. This admitted dispatch is a new
          // one-way Agent root, not a child model run, so it must not inherit the
          // caller's callbacks/run id.
          const requestId = `host-${randomUUID()}`;
          // The run belongs to its target; a legacy dispatch runs in the active session.
          const opened = target ? openSessionPeer(target.id) : null;
          let turnSetup: AgentChannelSetup | null = null;
          let reply = '';
          publishLifecycle({ dispatchId, request, requestId, state: 'running' });
          try {
            const { outcome, error, pendingInterrupt: settledInterrupt } = await localHandlers.runHostTurn(opened?.peer ?? hostPeer, {
              requestId,
              message: request,
              ...(artifactReferences.length ? { artifactReferences } : {}),
              runAgentTurn: (turn) => withPetInvocationContext(
                { petId, dispatchId, scope, sessionId: target?.id },
                async () => {
                  turnSetup = turn.setup;
                  const result = await runAgentTurn({
                    ...turn,
                    setup: withInvocationContext(turn.setup, invocationContext),
                    emitEvent: (event) => {
                      if (event.type === 'interrupt.requested') pendingInterrupt = event.pendingInterrupt;
                      // Dispatch observers follow the conversation whichever session is on screen.
                      const message = readPetDispatchMessage(event);
                      if (message) publishLifecycle({ dispatchId, request, requestId, state: 'message', message });
                      turn.emitEvent(event);
                    },
                  });
                  if (result.status === 'completed') reply = result.reply;
                  return result;
                },
              ),
            }, target?.id);
            if (outcome === 'completed') {
              publishLifecycle({ dispatchId, request, requestId, state: 'completed', reply });
              return;
            }
            if (outcome === 'waiting') {
              // A cancellation that settled into a review hands that review back,
              // so ownership is saved from what the settlement already knew.
              if (settledInterrupt) pendingInterrupt = settledInterrupt;
              const setup = turnSetup ?? await readSetup();
              if (!pendingInterrupt) {
                const pending = (await graphService.readThreadState(setup)).pendingInterrupt;
                if (pending) pendingInterrupt = projectPendingInterrupt(pending);
              }
              if (!pendingInterrupt) throw new Error('A waiting dispatch has no pending interrupt.');
              suspend(setup, pendingInterrupt);
              publishLifecycle({ dispatchId, request, requestId, state: 'waiting' });
              return;
            }
            if (outcome === 'interrupted') {
              publishLifecycle({ dispatchId, request, requestId, state: 'interrupted' });
              return;
            }
            throw error ?? new Error('internal error');
          } catch (failure) {
            publishLifecycle({
              dispatchId,
              request,
              requestId,
              state: 'failed',
              error: failure instanceof Error ? failure.message : 'internal error',
              diagnostics: describeAgentError(failure),
            });
            throw failure;
          } finally {
            opened?.release();
          }
        },
        true,
      ), target ? async () => {
        // A vanished target is not held by a review. Admit it so the run fails
        // through its own failed lifecycle instead of parking forever.
        if (!sessions.getSession(petId, target.id)) return true;
        // Read failures propagate: the Coordinator keeps this work queued.
        return !(await graphService.readThreadState(await readTargetSetup())).pendingInterrupt;
      } : undefined, {
        dispatchId, enqueuedAt: new Date().toISOString(),
        ...(target ? { sessionId: target.id } : {}),
        ...(scope ? { scope: copyPetInvocationScope(scope) } : {}),
      });
      publishLifecycle({ dispatchId, request, state: 'queued' });
      if (delivery === 'interrupt') context.interruptDispatchForInput({ sessionId: target!.id, scope: scope! });
    },
  };

  return { dispatch, close: context.close };
}
