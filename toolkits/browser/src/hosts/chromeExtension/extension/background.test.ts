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
    /async function readSnapshot\(tabId, approvedOrigin, params = \{\}\) \{([\s\S]*?)\n\}/,
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
  assert.doesNotMatch(ensureTarget, /about:blank/);
});

test('browser_open creates a debuggable blank tab, not the chrome:// New Tab page', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );
  const prepareNavigationTarget = source.match(
    /async function prepareNavigationTarget\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  // The debugger attaches before the URL is dispatched; Chrome rejects
  // attaching to chrome://newtab, which a URL-less tabs.create opens.
  assert.match(
    prepareNavigationTarget,
    /chrome\.tabs\.create\(\{ url: 'about:blank', active: true \}\)/,
  );
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

test('accessibility refs are bound to the document they were read from (#869)', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  assert.match(source, /'Page\.getFrameTree'/);
  // The loader is read before the tree it labels.
  assert.match(
    source,
    /async function readAccessibilitySnapshot[\s\S]*?const loaderId = await mainFrameLoaderId\(tabId\);[\s\S]*?const tree = await cdp\(tabId, 'Accessibility\.getFullAXTree'\);/,
  );
  // Every ax: ref is checked against the current loader before its node is touched.
  assert.match(source, /isAccessibilityRef\(normalized\.ref\)[\s\S]*?resolveAccessibilityTarget/);
  assert.match(
    source,
    /async function resolveAccessibilityTarget[\s\S]*?ref\.loaderKey !== accessibilityLoaderKey\(await mainFrameLoaderId\(tabId\)\)[\s\S]*?staleAccessibilityRef[\s\S]*?DOM\.scrollIntoViewIfNeeded/,
  );
});

test('snapshots come from the accessibility tree, with the DOM snapshot as fallback (#873)', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  assert.match(
    source,
    /async function readSnapshot[\s\S]*?readAccessibilitySnapshot\(tabId, url, options\)[\s\S]*?catch \(accessibilityError\)[\s\S]*?readDomSnapshot\(tabId\)/,
  );
  // Sensitive inputs are looked up after the tree, so every input it holds exists.
  assert.match(
    source,
    /'Accessibility\.getFullAXTree'\);[\s\S]*?const sensitiveNodeIds = await sensitiveInputNodeIds\(tabId\);[\s\S]*?buildAccessibilityTreeSnapshot\(tree\.nodes \|\| \[\], url, \{\s*loaderId,\s*sensitiveNodeIds,/,
  );
  // An input that cannot be mapped withholds every value rather than none.
  assert.match(
    source,
    /async function sensitiveInputNodeIds[\s\S]*?if \(!Number\.isInteger\(node\?\.backendNodeId\)\) return null;[\s\S]*?catch \{\s*return null;[\s\S]*?Runtime\.releaseObjectGroup/,
  );
  for (const method of ['DOM.describeNode', 'Runtime.getProperties', 'Runtime.releaseObjectGroup']) {
    assert.match(source, new RegExp(`'${method.replace('.', '\\.')}'`));
  }
});

test('element and full-page screenshots clip in document coordinates within the size limit (#873)', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  assert.match(source, /'Page\.getLayoutMetrics'/);
  // The target is resolved (and scrolled into view) before the scroll offset is read.
  assert.match(
    source,
    /async function screenshotClip[\s\S]*?resolveTarget\(tabId, params\.target\)[\s\S]*?Page\.getLayoutMetrics[\s\S]*?viewport\.pageX[\s\S]*?viewport\.pageY/,
  );
  assert.match(source, /MAX_SCREENSHOT_CSS_HEIGHT/);
  // Scales are CSS output ratios divided by devicePixelRatio: clip.scale multiplies it.
  assert.match(
    source,
    /async function screenshotScales[\s\S]*?devicePixelRatio[\s\S]*?scope === 'fullPage' \? \[1, 0\.5, 0\.25\][\s\S]*?cssScale \/ devicePixelRatio/,
  );
  assert.match(source, /for \(const scale of await screenshotScales\(tabId, scope\)\)/);
  assert.match(
    source,
    /async function captureScreenshot[\s\S]*?assertApprovedOrigin[\s\S]*?clip: \{ \.\.\.region\.clip, scale \}, captureBeyondViewport: true[\s\S]*?assertApprovedOrigin[\s\S]*?scope,/,
  );
  assert.match(source, /captureScreenshot\(activeTarget\.tabId, approvedOrigin, command\.params\)/);
});

test('snapshot options scope the tree without falling back to a different snapshot (#873 3b)', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.ts'),
    'utf8',
  );

  assert.match(source, /readSnapshot\(activeTarget\.tabId, approvedOrigin, command\.params\)/);
  // The scope target is resolved in the document the loader names, before the tree is read.
  assert.match(
    source,
    /async function readAccessibilitySnapshot[\s\S]*?mainFrameLoaderId[\s\S]*?snapshotTargetNodeId\(tabId, options\.target, loaderId\)[\s\S]*?Accessibility\.getFullAXTree/,
  );
  assert.match(
    source,
    /async function snapshotTargetNodeId[\s\S]*?ref\.loaderKey !== accessibilityLoaderKey\(loaderId\)[\s\S]*?buildTargetElementExpression[\s\S]*?DOM\.describeNode[\s\S]*?Runtime\.releaseObjectGroup/,
  );
  // A scoped request never silently becomes a whole-page DOM snapshot.
  assert.match(source, /if \(scoped\) throw accessibilityError;[\s\S]*?readDomSnapshot\(tabId\)/);
  assert.match(source, /applied: \{/);
});
