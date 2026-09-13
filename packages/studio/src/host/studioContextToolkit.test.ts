import assert from 'node:assert/strict';
import test from 'node:test';
import { compileAgentRegistry, defineInstructionDocument } from '@pinpawo/pet-agent';
import { createStudioContextToolkit } from './studioContextToolkit';

test('Studio directory reads the current registry without exposing foreign tools or private state', async () => {
  let pets = [{ petId: 'planner', name: 'Planner', privateSession: 'not-public' }];
  const toolkit = createStudioContextToolkit(() => pets);
  const lookup = toolkit.tools[0]!.tool;
  assert.deepEqual(JSON.parse(await lookup.invoke({}) as string), { pets: [{ petId: 'planner', name: 'Planner' }] });
  pets = [{ petId: 'reviewer', name: 'Reviewer', privateSession: 'not-public' }];
  assert.deepEqual(JSON.parse(await lookup.invoke({}) as string), { pets: [{ petId: 'reviewer', name: 'Reviewer' }] });
  const registry = compileAgentRegistry({ toolkits: [toolkit], capabilities: [{
    name: 'planning', description: 'Plan work', uses: ['studio-context'],
    instructions: defineInstructionDocument({ content: 'Plan work with the available facts.' }),
  }] });
  assert.equal(registry.capabilities.length, 1);
  assert.deepEqual(toolkit.tools.map(({ tool }) => tool.name), ['studio_pet_list']);
});
