import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostPersistence } from './hostPersistence';
import { createResidentPetHost } from '../residentPetHost';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import { createTestModelProfiles } from '../testing/modelProfiles';
import { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';
import { FileSaver } from '../fileSaver';

test('Host does not queue or execute if durable invocation admission fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-failure-'));
  let fail = false, executed = 0;
  const persistence = createHostPersistence({ defaultModelProfileId: 'test-profile', commit: state => {
    if (fail && Object.keys(state.invocations).length) throw new Error('admission disk failure');
  } });
  const config = buildHostRuntimeConfig(root);
  const host = await createResidentPetHost({ petId: 'pet', petName: 'Pet', runtimeConfig: config,
    modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer: new FileSaver(config.checkpointPath),
    sessionStatePath: config.tuiSessionPath, persistence,
    capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); }, listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
    graphService: { readThreadState: async () => ({ messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null }) } as never,
    runAgentTurn: async () => { executed++; return { status: 'completed', reply: 'done' }; },
  });
  try {
    fail = true;
    await assert.rejects(host.resident.dispatch.dispatch({ dispatchId: 'rejected', request: 'never run' }), /admission disk failure/);
    assert.equal(persistence.invocations.read('rejected'), null);
    assert.equal(host.resident.dispatch.getQueueSnapshot().queuedDispatches, 0);
    assert.equal(executed, 0);
    fail = false;
    await host.resident.dispatch.dispatch({ dispatchId: 'accepted', request: 'run once', idempotencyKey: 'same' });
    await host.resident.dispatch.dispatch({ dispatchId: 'retry', request: 'run once', idempotencyKey: 'same' });
    for (let attempt = 0; attempt < 100 && (Number(executed) !== 1 || host.resident.dispatch.getQueueSnapshot().state !== 'open'); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(executed, 1);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
