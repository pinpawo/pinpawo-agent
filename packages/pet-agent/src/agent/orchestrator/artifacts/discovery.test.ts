import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  hasArtifactDiscoveryToolkit,
} from './discovery';

test('artifact discovery availability follows compiled Toolkit authorization', () => {
  assert.equal(
    hasArtifactDiscoveryToolkit([{ name: ARTIFACT_DISCOVERY_TOOLKIT_NAME }]),
    true,
  );
  assert.equal(hasArtifactDiscoveryToolkit([{ name: 'bash' }]), false);
});
