import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../guards';
import { buildSubagentGuardStopNotice } from '../guardStop';
import {
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentGuard,
} from './types';

function buildSubagentIterationLimitNotice(attemptedIteration: number, maxIterations: number): string {
  return [
    `Subagent loop reached its iteration limit: attempted ${attemptedIteration}, limit ${maxIterations}.`,
    'Stop the loop and report the current progress instead of waiting for LangGraph recursionLimit.',
  ].join('\n');
}

export function createSubagentIterationLimitGuard(): SubagentGuard {
  return defineGuard({
    name: SUBAGENT_GUARD_NAME.ITERATION_LIMIT,
    positions: [SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION],
    rule: {
      check: ({ state }) => {
        const maxIterations = state.maxIterations;
        if (!maxIterations || !Number.isFinite(maxIterations) || maxIterations <= 0) {
          return guardPass();
        }
        return state.iterationCount >= maxIterations
          ? guardBlock('subagent_iteration_limit_reached', {
            iterationCount: state.iterationCount,
            maxIterations,
          })
          : guardPass();
      },
    },
    handler: {
      handle: ({ result, state }) => result.status === 'block'
        ? {
          messages: [
            buildSubagentGuardStopNotice('subagent_iteration_limit_reached', buildSubagentIterationLimitNotice(
              state.iterationCount,
              state.maxIterations ?? state.iterationCount,
            )),
          ],
        }
        : null,
    },
  });
}
