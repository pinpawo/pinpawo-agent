import type { AgentRuntimeEvent, PendingInterruptProjection } from '@pinpawo/agent-session';
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
import { readPetDispatchMessage, type PetDispatchPort, type ResidentPet } from './contracts';
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
    publishRuntimeEvent: publishActiveSessionEvent,
    publishSessionEvent,
    dispatchLifecycleListeners,
    publishDispatchLifecycle,
    activeHostRuns,
    activeRuns,
  } = context;

  const dispatch: PetDispatchPort = {
    getQueueSnapshot: () => coordinator.getQueueSnapshot(),
    onQueueChange: (listener) => coordinator.onQueueChange(listener),
    onDispatchLifecycle: (listener) => {
      dispatchLifecycleListeners.add(listener);
      return () => dispatchLifecycleListeners.delete(listener);
    },
    dispatch: async ({ request, dispatchId: suppliedDispatchId, scope: suppliedScope, session: suppliedSession }) => {
      const dispatchId = suppliedDispatchId?.trim() || randomUUID();
      const scope = suppliedScope ? copyPetInvocationScope(suppliedScope) : undefined;
      const petId = runtime.petId;
      // Resolve and persist before admission; neither queue time nor a TUI switch
      // may change the target. Legacy callers retain active-session behavior.
      const target = suppliedSession
        ? sessions.ensureDispatchSession(petId, suppliedSession.id, suppliedSession.create === true)
        : undefined;
      let pendingInterrupt: PendingInterruptProjection | undefined;
      const publishLifecycle: typeof publishDispatchLifecycle = (event) => publishDispatchLifecycle({
        ...event, ...(scope ? { scope: copyPetInvocationScope(scope) } : {}),
        ...(event.state === 'waiting' && pendingInterrupt ? { pendingInterrupt } : {}),
        ...(target ? { sessionId: target.id } : {}),
      });
      const publishRuntimeEvent = (event: AgentRuntimeEvent) => {
        if (event.type === 'interrupt.requested') pendingInterrupt = event.pendingInterrupt;
        // Dispatch observers follow the conversation whichever session is on screen.
        const message = readPetDispatchMessage(event);
        if (message) publishLifecycle({ dispatchId, request, requestId: event.requestId, state: 'message', message });
        // The run belongs to its target; a legacy dispatch runs in the active session.
        if (target) publishSessionEvent(target.id, event);
        else publishActiveSessionEvent(event);
      };
      const readTargetSetup = async () => sessions.buildSessionSetup(runtimeDeps.get(), await loadContext(petId), target!.id);
      // Whoever resumes this review continues the dispatch; see continueSuspendedDispatch.
      const suspend = (setup: AgentChannelSetup, pending: PendingInterruptProjection) => {
        const session = target ?? sessions.findSessionByThread(petId, setup.input.threadId);
        if (!session) throw new Error('A waiting dispatch has no session to resume from.');
        sessions.setPendingDispatch(session.id, {
          interruptId: pending.interruptId, dispatchId, request, ...(scope ? { scope } : {}),
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
              const pending = projectPendingInterrupt(settled);
              publishRuntimeEvent({
                type: 'interrupt.requested',
                requestId,
                pendingInterrupt: pending,
              });
              suspend(params.setup!, pending);
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
              if (!pendingInterrupt) throw new Error('A waiting dispatch has no pending interrupt.');
              suspend(setup, pendingInterrupt);
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
    },
  };

  return { dispatch, close: context.close };
}

/** Derive the Agent Session adapter independently from the same runtime. */
