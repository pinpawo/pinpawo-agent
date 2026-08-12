import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('MV3 service worker has no top-level await startup statement', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  assert.doesNotMatch(source, /^await\s/m);
  assert.match(source, /void initialize\(\)\.catch/);
});

test('snapshot reads enforce snapshot URL and post-read committed origin checks', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const readSnapshot = source.match(
    /async function readSnapshot\(tabId, approvedOrigin\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  assert.match(readSnapshot, /validateSnapshotOrigin\(snapshot, approvedOrigin, tabId\)/);
  assert.ok(
    (readSnapshot.match(/await assertApprovedOrigin\(tabId, approvedOrigin\)/g) ?? []).length >= 2,
    'readSnapshot must check the committed origin before and after snapshot collection',
  );
});

test('P1 interactions stay on the CDP allowlist and re-snapshot through the origin guard', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  for (const method of [
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText',
    'Page.captureScreenshot',
  ]) {
    assert.match(source, new RegExp(`'${method.replace('.', '\\.')}'`));
  }
  assert.match(source, /command\.command === 'click'[\s\S]*?dispatchClick[\s\S]*?readSnapshot/);
  assert.match(source, /command\.command === 'type'[\s\S]*?dispatchType[\s\S]*?readSnapshot/);
  assert.match(source, /command\.command === 'scroll'[\s\S]*?dispatchScroll[\s\S]*?readSnapshot/);
  assert.match(source, /async function captureScreenshot[\s\S]*?assertApprovedOrigin[\s\S]*?Page\.captureScreenshot[\s\S]*?assertApprovedOrigin/);
  assert.match(source, /const characters = Array\.from\(params\.text\)[\s\S]*?for \(const character of characters\)[\s\S]*?dispatchKey\([\s\S]*?approvedOrigin/);
  assert.match(source, /chunkTrustedInsertText\(params\.text\)[\s\S]*?assertApprovedOrigin\(tabId, approvedOrigin\)[\s\S]*?Input\.insertText[\s\S]*?assertApprovedOrigin\(tabId, approvedOrigin\)/);
});

test('commands and target changes share the extension-owned serial queue', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  assert.match(source, /onMessage\.addListener[\s\S]*?enqueueExtensionWork\(\(\) => handleCommand\(message\)\)/);
  assert.match(source, /action\.onClicked\.addListener[\s\S]*?enqueueExtensionWork/);
  assert.match(source, /tabs\.onCreated\.addListener[\s\S]*?enqueueExtensionWork/);
  assert.match(source, /tabs\.onRemoved\.addListener[\s\S]*?enqueueExtensionWork/);
});

test('cancellation bypasses the command queue and is observed at command safe points', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  const nativeMessageHandler = source.match(
    /nextPort\.onMessage\.addListener\(\(message\) => \{([\s\S]*?)\n    \}\);/,
  )?.[1] ?? '';
  assert.match(nativeMessageHandler, /message\?\.type === 'browser\.cancel'[\s\S]*?handleCancel\(message\)[\s\S]*?return/);
  assert.match(nativeMessageHandler, /enqueueExtensionWork\(\(\) => handleCommand\(message\)\)/);
  assert.match(source, /function ensureCommandAlive\(deadlineAt\) \{[\s\S]*?cancelledCommandRequestIds\.has\(activeCommandRequestId\)/);
  assert.match(source, /await delay\(100, deadlineAt\);/);
});

test('native host reconnect uses bounded backoff and reports Chrome disconnect errors', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  assert.match(source, /calculateReconnectDelay\(/);
  assert.match(source, /MAX_RECONNECT_DELAY_MS/);
  assert.match(source, /scheduleStableConnectionReset/);
  assert.match(source, /chrome\.runtime\.lastError\?\.message/);
});

test('explicit user tab binding reports only the origin approved by the action click', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const actionHandler = source.match(
    /chrome\.action\.onClicked\.addListener\(async \(tab\) => \{([\s\S]*?)\n\}\);/,
  )?.[1] ?? '';

  assert.match(actionHandler, /originOf\(tab\.url\)/);
  assert.match(actionHandler, /userBoundOrigin: approvedOrigin/);
  assert.doesNotMatch(actionHandler, /chrome\.storage\.local\.set\([^)]*userBoundOrigin/);
});

test('popup tabs are followed inside the extension target lifecycle', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  assert.match(source, /followPopupAfterAction\(activeTarget, tracking, command\.deadlineAt\)/);
  assert.match(source, /switchToPopup[\s\S]*?rememberCurrent: true[\s\S]*?waitForTab/);
  assert.match(source, /switchToPopup[\s\S]*?rollbackPopupSwitch/);
  assert.match(source, /tabs\.onCreated\.addListener[\s\S]*?shouldTrackPopup/);
  assert.doesNotMatch(source, /tabs\.onCreated\.addListener[\s\S]*?switchToPopup/);
  assert.match(source, /targets\.remove\(tabId\)[\s\S]*?saveTarget\(removed\.current\)/);
  assert.match(source, /originChangedError[\s\S]*?manualActionRequired: true[\s\S]*?complete_popup_manually/);
  assert.match(source, /readInteractionResult[\s\S]*?interactionDispatched: true/);
  assert.doesNotMatch(source, /approve the new URL before reading it/);
});

test('selector actions use a bounded extension-side retry without retrying stale refs', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const resolveTargetForAction = source.match(
    /async function resolveTargetForAction\([\s\S]*?\n\}/,
  )?.[0] ?? '';

  assert.match(resolveTargetForAction, /Date\.now\(\) \+ 1_000/);
  assert.match(resolveTargetForAction, /normalized\.selector/);
  assert.match(resolveTargetForAction, /element_not_found/);
  assert.doesNotMatch(resolveTargetForAction, /stale_element_reference/);
});

test('trusted input checks the approved origin before each browser event', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const dispatchClick = source.match(
    /async function dispatchClick\([\s\S]*?\n\}/,
  )?.[0] ?? '';
  const dispatchKey = source.match(
    /async function dispatchKey\([\s\S]*?\n\}/,
  )?.[0] ?? '';

  assert.ok(
    (dispatchClick.match(/assertApprovedOrigin\(tabId, approvedOrigin\)/g) ?? []).length >= 3,
    'click must re-check origin before move, press, and release',
  );
  assert.ok(
    (dispatchKey.match(/assertApprovedOrigin\(tabId, approvedOrigin\)/g) ?? []).length >= 3,
    'key input must re-check origin before down, char, and up',
  );
});

test('trusted pointer input activates the bound target inside the extension', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const dispatchClick = source.match(
    /async function dispatchClick\([\s\S]*?\n\}/,
  )?.[0] ?? '';
  const dispatchScroll = source.match(
    /async function dispatchScroll\([\s\S]*?\n\}/,
  )?.[0] ?? '';

  assert.match(dispatchClick, /await activateTarget\(tabId\)/);
  assert.match(dispatchScroll, /await activateTarget\(tabId\)/);
});

test('navigation attaches and enables lifecycle domains before dispatching the URL', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const navigate = source.match(
    /if \(command\.command === 'navigate'\) \{([\s\S]*?)\n  \}/,
  )?.[1] ?? '';

  const attachOffset = navigate.indexOf('await attach(activeTarget.tabId)');
  const updateOffset = navigate.indexOf('await chrome.tabs.update(activeTarget.tabId, { url, active: true })');

  assert.match(navigate, /prepareNavigationTarget\(\)/);
  assert.match(navigate, /await activateTarget\(activeTarget\.tabId\)/);
  assert.ok(attachOffset >= 0 && updateOffset > attachOffset, 'attach must happen before tabs.update(url)');
  assert.match(navigate, /return \{ ok: true, tabId: activeTarget\.tabId, url \}/);
  assert.match(source, /await cdp\(tabId, 'Page\.enable'\)/);
  assert.match(source, /await cdp\(tabId, 'Network\.enable'\)/);
  const prepareTarget = source.match(
    /async function prepareNavigationTarget\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  assert.doesNotMatch(prepareTarget, /chrome\.tabs\.update/);
  assert.doesNotMatch(source, /'Page\.navigate'/);
});

test('missing targets fail without fabricating an about:blank tab', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const ensureTarget = source.match(
    /async function ensureTarget\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  assert.match(ensureTarget, /'browser_not_open'/);
  assert.doesNotMatch(ensureTarget, /chrome\.tabs\.create/);
  assert.doesNotMatch(source, /url: 'about:blank'/);
});

test('target activation does not focus the user\'s Chrome window', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const activateTarget = source.match(
    /async function activateTarget\(tabId(?:: number)?\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  assert.match(activateTarget, /chrome\.tabs\.update\(tabId, \{ active: true \}\)/);
  assert.doesNotMatch(activateTarget, /chrome\.windows\.update/);
});

test('live DOM sampling does not read a frame URL from Page.loadEventFired', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const handler = source.match(
    /chrome\.debugger\.onEvent\.addListener\(\(source, method, params\) => \{([\s\S]*?)\n\}\);/,
  )?.[1] ?? '';
  const loadEventBranch = handler.match(
    /if \(method === 'Page\.loadEventFired'\) \{([\s\S]*?)\n  \}/,
  )?.[1] ?? '';

  assert.notEqual(loadEventBranch, '');
  // `Page.loadEventFired` carries only a `timestamp`; reading `params.frame.url`
  // always yields undefined, so the DOM sample never fires and the Runtime never
  // receives a textLength (navigation then hangs in `settling` until timeout).
  assert.doesNotMatch(loadEventBranch, /params[\s\S]*?frame/);
  assert.match(loadEventBranch, /liveTabUrl\(tabId\)/);
  assert.match(loadEventBranch, /emitLiveDomSample/);
});

test('tab-complete readiness resolves a real URL instead of posting an empty one', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const handler = source.match(
    /chrome\.tabs\.onUpdated\.addListener\(\(tabId, changeInfo\) => \{([\s\S]*?)\n\}\);/,
  )?.[1] ?? '';

  assert.match(handler, /liveTabUrl\(tabId\)/);
  assert.match(handler, /if \(!url\) return;/);
  // An empty URL makes the readiness events unusable downstream.
  assert.doesNotMatch(handler, /emitLiveDocumentReady\([^)]*''/);
  assert.doesNotMatch(handler, /emitLiveDomSample\([^)]*''/);
});

test('liveTabUrl falls back to the tab itself when the target has no URL', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const helper = source.match(
    /async function liveTabUrl\(tabId(?:: number)?\)(?:: Promise<string>)? \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  assert.match(helper, /targets\.current\(\)/);
  assert.match(helper, /chrome\.tabs\.get\(tabId\)/);
});

test('network activity reports the inflight count before the reported fact', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const emitter = source.match(
    /function emitLiveNetworkActivity\(tabId(?:: number)?, kind[^)]*\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  // networkActivityEvent applies its own +1/-1 delta, so the base must be the
  // count *before* the fact — otherwise the tally never returns to zero and the
  // page can never settle.
  assert.match(emitter, /kind === 'request'/);
  assert.match(emitter, /Math\.max\(0, inflightRequests - 1\)/);
  assert.match(emitter, /inflightRequests \+ 1/);
  // finish and fail must stay distinguishable for the delta translator.
  assert.match(source, /'Network\.loadingFinished' \? 'finish' : 'fail'/);
});
