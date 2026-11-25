import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import { parseDeliverables } from '@pinpawo/agent-contracts';
import { randomUUID } from 'node:crypto';
import { copyPetInvocationScope, withPetInvocationContext } from './petInvocationContext';
import { snapshotInvocationContext, withInvocationContext } from './invocationSystemContext';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';

import type { AgentChannelSetup } from '../agent/agentChannel';
import { projectPendingInterrupt } from '../conversation/pendingInterruptProjection';
import { PetDispatchRefusedError, readPetDispatchMessage, type PetDispatchQueueEntry, type PetDispatchRequest, type ResidentPet } from './contracts';
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

  type Supersede = ResidentPet['dispatch']['supersede'];

  async function submit(
    { request, attachments, dispatchId: suppliedDispatchId, scope: suppliedScope, origin: suppliedOrigin, session: suppliedSession, delivery, signal }: PetDispatchRequest,
    replacement?: Parameters<Supersede>[1],
  ): ReturnType<Supersede> {
    signal?.throwIfAborted();
    const artifactReferences = attachments === undefined ? [] : parseDeliverables(attachments);
    if (replacement && (delivery !== undefined || !suppliedSession?.id || !suppliedScope)) {
      throw new Error('Supersede requires an explicit session and scope, without a delivery mode.');
    }
    if (delivery !== undefined && delivery !== 'interrupt' && delivery !== 'idle-only') throw new Error('Unsupported dispatch delivery.');
    if (delivery && (!suppliedSession?.id || !suppliedScope)) {
      throw new Error(delivery === 'interrupt'
        ? 'Interrupt delivery requires an explicit session and scope.'
        : 'Idle-only delivery requires an explicit session and scope.');
    }
    const dispatchId = suppliedDispatchId?.trim() || randomUUID();
    coordinator.assertDispatchIdAvailable(dispatchId);
    const scope = suppliedScope ? copyPetInvocationScope(suppliedScope) : undefined;
    const origin = suppliedOrigin ? copyPetInvocationScope(suppliedOrigin) : undefined;
    if (origin && (!scope || origin.namespace !== scope.namespace)) throw new Error('Dispatch origin requires a matching scope namespace.');
    const session = suppliedSession ? { ...suppliedSession } : undefined;
    const petId = runtime.petId;
    const resolved = scope && resolveInvocationContext
      ? await resolveInvocationContext(Object.freeze({ petId, ...(session ? { sessionId: session.id } : {}), scope: Object.freeze({ ...scope }), request }))
      : undefined;
    signal?.throwIfAborted();
    if (context.isClosing()) throw new Error('Resident Pet is closing.');
    coordinator.assertDispatchIdAvailable(dispatchId);
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

    signal?.throwIfAborted();
    let executingRequestId: string | undefined;
    let stopRequested = false;
    const stop = () => {
      if (stopRequested) return true;
      // Before the Host owns a request, prevent the selected entry from starting.
      stopRequested = true;
      if (executingRequestId && !localHandlers.interruptRun(executingRequestId)) stopRequested = false;
      return stopRequested;
    };
    const run = () => AsyncLocalStorageProviderSingleton.runWithConfig(
      { callbacks: [] },
      async () => {
        // A Plugin can submit the next Pet while still inside the current Pet's
        // LangChain tool/event callback. This admitted dispatch is a new
        // one-way Agent root, not a child model run, so it must not inherit the
        // caller's callbacks/run id.
        const requestId = `host-${randomUUID()}`;
        if (stopRequested) {
          publishLifecycle({ dispatchId, request, state: 'interrupted' });
          return;
        }
        // The run belongs to its target; a legacy dispatch runs in the active session.
        const opened = target ? openSessionPeer(target.id) : null;
        let turnSetup: AgentChannelSetup | null = null;
        let reply = '';
        publishLifecycle({ dispatchId, request, requestId, state: 'running' });
        try {
          if (stopRequested) {
            publishLifecycle({ dispatchId, request, requestId, state: 'interrupted' });
            return;
          }
          executingRequestId = requestId;
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
          });
          throw failure;
        } finally {
          opened?.release();
        }
      },
      true,
    );
    const observation = {
      dispatchId, enqueuedAt: new Date().toISOString(),
      ...(origin ? { origin } : {}),
      ...(target ? { sessionId: target.id } : {}),
      ...(scope ? { scope: copyPetInvocationScope(scope) } : {}),
    };
    const onAdmitted = () => publishLifecycle({ dispatchId, request, state: 'queued' });
    const isTargetReady = async () => !(await graphService.readThreadState(await readTargetSetup())).pendingInterrupt;
    const onSuperseded = () => publishLifecycle({ dispatchId, request, state: 'superseded' });
    if (delivery === 'idle-only') {
      const admitted = await coordinator.submitDispatchIfIdle(run, {
        signal, observation, onAdmitted, stop,
        ready: async () => !!sessions.getSession(petId, target!.id) && await isTargetReady(),
      });
      if (!admitted) throw new PetDispatchRefusedError();
      return { stop: 'not_requested' };
    }
    const ready = target ? async () => {
      // A vanished target is not held by a review. Admit it so the run fails
      // through its own failed lifecycle instead of parking forever.
      // Read failures propagate: the Coordinator keeps this work queued.
      return !sessions.getSession(petId, target.id) || await isTargetReady();
    } : undefined;
    if (replacement) {
      const matches = (item: PetDispatchQueueEntry) => item.sessionId === target!.id &&
        item.scope?.namespace === scope!.namespace && item.scope.id === scope!.id;
      coordinator.supersedeDispatch({
        run, ready, observation, stop, onSuperseded,
      }, replacement.pendingDispatchIds, matches);
      onAdmitted();
      if (replacement.stopDispatchId === undefined) return { stop: 'not_requested' };
      return { stop: coordinator.stopDispatch(replacement.stopDispatchId, matches) ? 'requested' : 'not_active' };
    }
    coordinator.submitDispatch(run, ready, observation, { stop, onSuperseded });
    onAdmitted();
    if (delivery === 'interrupt') context.interruptDispatchForInput({ sessionId: target!.id, scope: scope! });
    return { stop: 'not_requested' };
  }

  const dispatch: ResidentPet['dispatch'] = {
    getQueueSnapshot: () => coordinator.getQueueSnapshot(),
    onQueueChange: listener => coordinator.onQueueChange(listener),
    onDispatchLifecycle: listener => {
      dispatchLifecycleListeners.add(listener);
      return () => dispatchLifecycleListeners.delete(listener);
    },
    dispatch: async request => { await submit(request); },
    stop: dispatchId => coordinator.stopDispatch(dispatchId),
    supersede: (request, options) => submit(request, { ...options, pendingDispatchIds: [...options.pendingDispatchIds] }),
  };

  return { dispatch, close: context.close };
}
