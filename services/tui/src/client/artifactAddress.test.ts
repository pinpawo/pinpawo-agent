import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactHttpAddress, createArtifactAddressCache } from './artifactAddress';

test('display address cache coalesces reads and refreshes expired addresses without changing stable references', async () => {
  const uri = 'artifact://workspace/session/id/report.txt';
  let now = 1_000;
  let reads = 0;
  let changed = 0;
  const cache = createArtifactAddressCache({
    now: () => now,
    onChanged: () => { changed += 1; },
    read: async () => ({ address: `https://objects.example/report?signature=${++reads}`, expiresAt: new Date(now + 100).toISOString() }),
  });
  assert.equal(cache.display(uri), uri);
  await Promise.all([cache.ensure([uri, uri]), cache.ensure([uri])]);
  assert.equal(reads, 1);
  assert.equal(changed, 1);
  assert.equal(cache.display(uri), 'https://objects.example/report?signature=1');
  now += 101;
  assert.equal(cache.display(uri), uri);
  await cache.ensure([uri]);
  assert.equal(reads, 2);
  assert.equal(cache.display(uri), 'https://objects.example/report?signature=2');
  assert.equal(artifactHttpAddress('https://example.com/pull/1', 3210), 'https://example.com/pull/1');
});

test('address failures stay stable through rerenders and can retry after reconnection', async () => {
  let reads = 0;
  const uri = 'artifact://workspace/session/id/missing.txt';
  const cache = createArtifactAddressCache({ read: async () => { reads += 1; return null; }, onChanged: () => assert.fail('No address changed.') });
  await cache.ensure([uri]);
  await cache.ensure([uri]);
  assert.equal(reads, 1);
  assert.equal(cache.display(uri), uri);
  cache.resetFailures();
  await cache.ensure([uri]);
  assert.equal(reads, 2);
});
