import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createPlanRequestTool } from '../src/agent/orchestrator/runtime/nodes/entryAnswer.ts';
import { getDecisionEvalScenarios } from './decision-eval-scenarios.ts';

/**
 * A harness stub that declares a production tool is part of the measured
 * surface, not a convenience. When the two drift, the eval silently measures the
 * wrong thing and reports it as a model failure.
 *
 * This has happened: the plan_request stub kept z.object({}) and "takes no
 * arguments" for a full PR after production gained a required `goal`. The scorer
 * reads args.goal, so every correctly routed run scored zero — 9/18 on
 * entry_answer, entirely fabricated. Fixing the stub returned 17/18 on unchanged
 * code. See docs/reference/runtime/eval-contract.md §4.
 */

function toolSchemaShape(candidate: unknown): z.ZodRawShape {
  const schema = (candidate as { schema?: unknown }).schema;
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('Expected a zod object schema on the tool.');
  }
  return schema.shape as z.ZodRawShape;
}

function describeParameters(shape: z.ZodRawShape) {
  return Object.entries(shape)
    .map(([name, field]) => `${name}:${field.isOptional() ? 'optional' : 'required'}`)
    .sort();
}

test('the eval plan_request stub mirrors the production tool contract', () => {
  const production = createPlanRequestTool();

  // The scenario module owns the stub; reach it through a rendered scenario so
  // this test breaks if the stub is replaced rather than edited.
  const scenario = getDecisionEvalScenarios('entry_answer')
    .find(({ caseName }) => caseName === 'repository-task-enters-planner');
  assert.ok(scenario, 'expected a plan_request scenario to exist');

  let boundTools: unknown[] = [];
  const captureModel = {
    bindTools: (tools: unknown[]) => {
      boundTools = tools;
      return { invoke: async () => { throw new Error('stop'); } };
    },
  } as never;

  return scenario.run(captureModel).then(
    () => assert.fail('the capture model must not complete a run'),
    () => {
      const stub = boundTools.find((candidate) =>
        (candidate as { name?: string }).name === production.name);
      assert.ok(stub, `the eval must bind a tool named ${production.name}`);

      assert.deepEqual(
        describeParameters(toolSchemaShape(stub)),
        describeParameters(toolSchemaShape(production)),
        'stub and production plan_request must agree on parameters and optionality',
      );
    },
  );
});
