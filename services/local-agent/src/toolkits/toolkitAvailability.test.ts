import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import type {
  AgentToolkit,
} from '@pinpawo/pet-agent';
import { z } from 'zod';
import { resolveToolkitAvailability } from './toolkitAvailability';

const testTool = tool(
  async () => 'test result',
  {
    name: 'test_tool',
    description: 'Test tool.',
    schema: z.object({}),
  },
);

function toolkit(
  description: string,
  availability: AgentToolkit['availability'],
): AgentToolkit {
  return {
    name: 'same_name',
    description,
    tools: [{ tool: testTool }],
    availability,
  };
}

test('Toolkit availability cache is scoped to the Toolkit instance', async () => {
  let replacementChecks = 0;
  const first = toolkit(
    'First generation.',
    () => ({ available: false, reason: 'first offline' }),
  );
  const replacement = toolkit(
    'Replacement generation.',
    () => {
      replacementChecks += 1;
      return { available: true };
    },
  );

  assert.deepEqual((await resolveToolkitAvailability(first)).availability, {
    available: false,
    reason: 'first offline',
  });
  assert.deepEqual((await resolveToolkitAvailability(replacement)).availability, {
    available: true,
  });
  assert.equal(replacementChecks, 1);
});
