import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../guards';
import {
  stopSubagentLoop,
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentGuard,
} from './types';

function buildSubagentIterationLimitNotice(iterationCount: number, maxIterations: number): string {
  return [
    `Subagent loop reached its iteration limit: ${iterationCount}/${maxIterations}.`,
    'Stop the loop and report the current progress instead of waiting for LangGraph recursionLimit.',
  ].join('\n');
}

export function createSubagentIterationLimitGuard(): SubagentGuard {
  return defineGuard({
    name: SUBAGENT_GUARD_NAME.ITERATION_LIMIT,
    positions: [SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION],
    rule: {
      check: ({ config }) => {
        const maxIterations = config.maxIterations;
        if (!maxIterations || !Number.isFinite(maxIterations) || maxIterations <= 0) {
          return guardPass();
        }
        return config.iterationCount >= maxIterations
          ? guardBlock('subagent_iteration_limit_reached', {
            iterationCount: config.iterationCount,
            maxIterations,
          })
          : guardPass();
      },
    },
    handler: {
      handle: ({ config, result }) => result.status === 'block'
        ? stopSubagentLoop(buildSubagentIterationLimitNotice(
          config.iterationCount,
          config.maxIterations ?? config.iterationCount,
        ))
        : null,
    },
  });
}
