import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import { randomUUID } from 'node:crypto';
import { copyPetInvocationScope, withPetInvocationContext } from './petInvocationContext';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';

import type { AgentChannelSetup } from '../agent/agentChannel';
import { projectPendingInterrupt } from '../conversation/pendingInterruptProjection';
import {
  configureInflightOperationRegistry,
  createInflightOperationRun,
  finishInflightOperations,
  overlayInflightDelegationOperations,
} from '../inflightOperationRun';
import { emitLocalServerToolOperationEvent } from '../serverOperationEvents';
import { createOperationRegistryForAgentSetup } from '../runtimeOperationRegistry';
import type { ActiveRun } from '../agent/activeRunRegister';
import type { PetDispatchPort, ResidentPet } from './contracts';
import {
  readResidentPetRuntimeContext,
  type ResidentPetRuntime,
} from './runtimeContext';

/**
 * The dispatch surface: one-way input, observed rather than steered.
 *
 * A dispatch run is not a conversation turn. It has no interactive client to
 * answer, so it publishes its progress to whoever is observing. Cancellation
 * preserves an already-pending native review, just as a Chat run does.
 */

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function createResidentPet(runtime: ResidentPetRuntime): ResidentPet {
  const context = readResidentPetRuntimeContext(runtime);
  const {
    coordinator,
    runtimeDeps,
    graphService,
    runAgentTurn,
    loadContext,
    sessions,
    invocations,
    publishRuntimeEvent: publishActiveSessionEvent,
    dispatchLifecycleListeners,
    publishDispatchLifecycle,
    activeHostRuns,
    activeRuns,
  } = context;

  const dispatch: PetDispatchPort = {
    persistentAdmissions: true,
    replayDispatchLifecycle: () => invocations.replay(runtime.petId),
    getQueueSnapshot: () => coordinator.getQueueSnapshot(),
    onQueueChange: (listener) => coordinator.onQueueChange(listener),
    onDispatchLifecycle: (listener) => {
      dispatchLifecycleListeners.add(listener);
      return () => dispatchLifecycleListeners.delete(listener);
    },
    dispatch: async ({ request, dispatchId: suppliedDispatchId, scope: suppliedScope, session: suppliedSession, idempotencyKey, fingerprint: suppliedFingerprint }) => {
      if (context.isClosing()) throw new Error('Resident Pet Host is closing.');
      let dispatchId = suppliedDispatchId?.trim() || randomUUID();
      const scope = suppliedScope ? copyPetInvocationScope(suppliedScope) : undefined;
      const petId = runtime.petId;
      // Resolve and persist before admission; neither queue time nor a TUI switch
      // may change the target. Legacy callers retain active-session behavior.
      // A retry keeps its first admitted target even if the active TUI changed.
      const prior = sessions.persistence.invocations.read(dispatchId) ?? (idempotencyKey ? sessions.persistence.invocations.findAdmission(idempotencyKey) : null);
      const explicitTarget = !!suppliedSession || !!scope;
      let target = suppliedSession
        ? sessions.ensureDispatchSession(petId, suppliedSession.id, suppliedSession.create === true)
        : prior ? sessions.getSession(petId, prior.sessionId) : sessions.getActiveSession(petId);
      if (!target) throw new Error('Admitted dispatch session no longer exists.');
      const fingerprint = suppliedFingerprint ?? JSON.stringify([petId, request, suppliedSession?.id ?? null, scope ?? null]);
      const admission = sessions.persistence.invocations.admit({ dispatchId, petId, sessionId: target.id,
        threadId: target.threadId, request, fingerprint, ...(scope ? { scope } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) });
      dispatchId = admission.record.dispatchId;
      if (!admission.created) return { dispatchId };
      let pendingInterrupt: PendingInterruptProjection | undefined;
      const publishRuntimeEvent: typeof publishActiveSessionEvent = (event) => {
        if (event.type === 'interrupt.requested') pendingInterrupt = event.pendingInterrupt;
        if (!target || sessions.getActiveSessionId(petId) === target.id) publishActiveSessionEvent(event);
      };
      const publishLifecycle: typeof publishDispatchLifecycle = (event) => invocations.observe({
        ...event, ...(scope ? { scope: copyPetInvocationScope(scope) } : {}),
        ...(event.state === 'waiting' && pendingInterrupt ? { pendingInterrupt } : {}),
        ...(target ? { sessionId: target.id } : {}),
      });
      const readTargetSetup = async () => sessions.buildSessionSetup(runtimeDeps.get(), await loadContext(petId), target!.id);

      coordinator.submitDispatch(() => AsyncLocalStorageProviderSingleton.runWithConfig(
        { callbacks: [] },
        async () => {
          // A Plugin can submit the next Pet while still inside the current Pet's
          // LangChain tool/event callback. This admitted dispatch is a new
          // one-way Agent root, not a child model run, so it must not inherit the
          // caller's callbacks/run id.
          const requestId = `host-${randomUUID()}`;
          const run = createInflightOperationRun(requestId);
          let activeRun: ActiveRun | null = null;
          let abortedSetup: AgentChannelSetup | null = null;
          /**
           * Cancellation creates no synthetic interrupt. Report a native
           * review only if it was already pending.
           */
          const settleInterruptedDispatch = async (params: {
            setup: AgentChannelSetup | null;
            announce?: boolean;
          }) => {
            finishInflightOperations(run, 'interrupted', publishRuntimeEvent);
            // A settlement that fails leaves the thread in an unknown state,
            // so it takes the dispatch's failure path instead of being
            // reported as a clean interruption.
            const settled = params.setup
              ? await graphService.settleAbortedRun(params.setup)
              : null;
            if (settled) {
              publishRuntimeEvent({
                type: 'interrupt.requested',
                requestId,
                pendingInterrupt: projectPendingInterrupt(settled),
              });
              publishLifecycle({ dispatchId, request, requestId, state: 'waiting' });
              return;
            }
            if (params.announce !== false) {
              publishRuntimeEvent({
                type: 'run.interrupted',
                requestId,
                message: 'Run interrupted.',
              });
            }
            publishLifecycle({ dispatchId, request, requestId, state: 'interrupted' });
          };
          try {
            if (!explicitTarget) {
              const active = sessions.getActiveSession(petId);
              if (active.id !== target!.id) {
                const record = sessions.persistence.invocations.read(dispatchId)!;
                sessions.persistence.invocations.bindLegacyQueuedSession(dispatchId, record.revision, active.id);
                target = active;
              }
            }
            const context = await loadContext(runtimeDeps.get().petId);
            const setup = target ? sessions.buildSessionSetup(runtimeDeps.get(), context, target.id)
              : sessions.buildChatSetup(runtimeDeps.get(), context);
            abortedSetup = setup;
            configureInflightOperationRegistry(
              run,
              createOperationRegistryForAgentSetup(setup),
            );
            setup.input.signal = run.controller.signal;
            activeHostRuns.set(requestId, run.controller);
            activeRun = activeRuns.begin(requestId, target?.id);
            publishLifecycle({ dispatchId, request, requestId, state: 'running' });
            publishRuntimeEvent({
              type: 'run.started',
              requestId,
              initiator: 'host',
              input: { role: 'user', text: request },
            });
            const result = await withPetInvocationContext({ petId, dispatchId, scope, sessionId: target?.id }, () => runAgentTurn({
              request: { kind: 'user_message', requestId, message: request },
              sessionId: target!.id,
              setup,
              graphService,
              isCurrent: () => !run.controller.signal.aborted,
              emitEvent: publishRuntimeEvent,
              emitToolEvent: (payload) => {
                emitLocalServerToolOperationEvent({
                  run,
                  payload,
                  emit: publishRuntimeEvent,
                });
              },
              acceptDelegationOperations: (operations) => {
                overlayInflightDelegationOperations(run, operations);
              },
            }));
            if (result.status === 'waiting') {
              if (!pendingInterrupt) {
                const pending = (await graphService.readThreadState(setup)).pendingInterrupt;
                if (pending) pendingInterrupt = projectPendingInterrupt(pending);
              }
              finishInflightOperations(run, 'interrupted', publishRuntimeEvent);
              publishLifecycle({ dispatchId, request, requestId, state: 'waiting' });
              return;
            }
            if (result.status === 'interrupted') {
              await settleInterruptedDispatch({ setup });
              return;
            }
            finishInflightOperations(run, 'completed', publishRuntimeEvent);
            publishLifecycle({ dispatchId, request, requestId, state: 'completed', reply: result.reply });
          } catch (error) {
            let failure = error;
            if (run.controller.signal.aborted || isAbortError(error)) {
              try {
                await settleInterruptedDispatch({
                  setup: abortedSetup,
                  announce: activeRun !== null,
                });
                return;
              } catch (settleError) {
                console.error(
                  '[resident-pet] failed to settle an aborted dispatch:',
                  settleError instanceof Error
                    ? (settleError.stack ?? settleError.message)
                    : settleError,
                );
                failure = settleError;
              }
            }
            finishInflightOperations(run, 'failed', publishRuntimeEvent, failure);
            const message = failure instanceof Error ? failure.message : 'internal error';
            if (activeRun) {
              publishRuntimeEvent({
                type: 'error',
                requestId,
                message,
              });
            }
            publishLifecycle({
              dispatchId,
              request,
              requestId,
              state: 'failed',
              error: message,
            });
            throw failure;
          } finally {
            if (activeHostRuns.get(requestId) === run.controller) {
              activeHostRuns.delete(requestId);
            }
            if (activeRun) activeRuns.finish(activeRun);
          }
        },
        true,
      ), explicitTarget ? async () => {
        // A vanished target is not held by a review. Admit it so the run fails
        // through its own failed lifecycle instead of parking forever.
        if (!sessions.getSession(petId, target!.id)) return true;
        // Read failures propagate: the Coordinator keeps this work queued.
        return !(await graphService.readThreadState(await readTargetSetup())).pendingInterrupt;
      } : undefined, {
        dispatchId, enqueuedAt: new Date().toISOString(),
        ...(target ? { sessionId: target.id } : {}),
        ...(scope ? { scope: copyPetInvocationScope(scope) } : {}),
      });
      publishLifecycle({ dispatchId, request, state: 'queued' });
      return { dispatchId };
    },
  };

  return { dispatch, close: context.close };
}

/** Derive the Agent Session adapter independently from the same runtime. */
