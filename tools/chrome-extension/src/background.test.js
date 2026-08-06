import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('MV3 service worker has no top-level await startup statement', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
    'utf8',
  );

  assert.doesNotMatch(source, /^await\s/m);
  assert.match(source, /void initialize\(\)\.catch/);
});

test('snapshot reads enforce snapshot URL and post-read committed origin checks', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
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
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
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
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
    'utf8',
  );

  assert.match(source, /onMessage\.addListener[\s\S]*?enqueueExtensionWork\(\(\) => handleCommand\(message\)\)/);
  assert.match(source, /action\.onClicked\.addListener[\s\S]*?enqueueExtensionWork/);
  assert.match(source, /tabs\.onCreated\.addListener[\s\S]*?enqueueExtensionWork/);
  assert.match(source, /tabs\.onRemoved\.addListener[\s\S]*?enqueueExtensionWork/);
});

test('cancellation bypasses the command queue and is observed at command safe points', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
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
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
    'utf8',
  );

  assert.match(source, /calculateReconnectDelay\(/);
  assert.match(source, /MAX_RECONNECT_DELAY_MS/);
  assert.match(source, /scheduleStableConnectionReset/);
  assert.match(source, /chrome\.runtime\.lastError\?\.message/);
});

test('explicit user tab binding reports only the origin approved by the action click', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
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
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
    'utf8',
  );

  assert.match(source, /followPopupAfterAction\(activeTarget, command\.deadlineAt\)/);
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
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
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
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
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
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
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

test('navigation commits a normal tab before attaching the debugger', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
    'utf8',
  );
  const navigate = source.match(
    /if \(command\.command === 'navigate'\) \{([\s\S]*?)\n  \}/,
  )?.[1] ?? '';

  assert.match(navigate, /prepareNavigationTarget/);
  assert.match(navigate, /await activateTarget\(activeTarget\.tabId\)/);
  assert.match(navigate, /await attach\(activeTarget\.tabId\)/);
  assert.doesNotMatch(source, /'Page\.navigate'/);
});
