import {
  CAPABILITIES,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  errorResult,
  parseBrowserCancel,
  parseBrowserCommand,
  successResult,
} from './protocol.js';
import {
  assertSnapshotApprovedOrigin,
  buildAccessibilitySnapshot,
  buildSnapshotExpression,
  originOf,
} from './snapshot.js';
import {
  HUMANIZED_TYPE_CHARACTER_LIMIT,
  buildExtractExpression,
  buildResolveTargetExpression,
  chunkTrustedInsertText,
  createSerialExecutor,
  normalizeElementTarget,
  normalizeHumanization,
  randomDelayMs,
} from './interaction.js';
import {
  createTargetStack,
  isNavigableWebTab,
  isWebTab,
  selectNavigationTarget,
  shouldTrackPopup,
} from './targetLifecycle.js';
import { createBrowserStateTracker } from './browserState.js';
import { calculateReconnectDelay } from './reconnect.js';

const CDP_VERSION = '1.3';
const ALLOWED_CDP_COMMANDS = new Set([
  'Accessibility.getFullAXTree',
  'DOM.getBoxModel',
  'DOM.scrollIntoViewIfNeeded',
  'Page.getNavigationHistory',
  'Page.captureScreenshot',
  'Input.insertText',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Runtime.evaluate',
]);
const SESSION_KEY = 'pinpawoBrowserTarget';
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const STABLE_CONNECTION_RESET_MS = 10_000;
const connectionId = crypto.randomUUID();
let port = null;
let reconnectTimer = null;
let stableConnectionTimer = null;
let reconnectAttempt = 0;
let attachedTabId = null;
let userBoundOrigin = null;
const enqueueExtensionWork = createSerialExecutor();
const targets = createTargetStack();
const browserState = createBrowserStateTracker();
const recentPopupByOpener = new Map();
const queuedCommandRequestIds = new Set();
const cancelledCommandRequestIds = new Set();
let activeCommandRequestId = null;
// Commands run through enqueueExtensionWork. Retain the command identity as
// well, so a future change to command concurrency cannot let one cleanup erase
// a newer interaction's popup record.
let popupTracking = null;

class ExtensionError extends Error {
  constructor(code, message, retryable = false, details) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

async function restoreTarget() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const candidate = stored[SESSION_KEY];
  if (!candidate || !Number.isInteger(candidate.tabId)) return;
  try {
    const tab = await chrome.tabs.get(candidate.tabId);
    if (!isWebTab(tab)) {
      await chrome.storage.local.remove(SESSION_KEY);
      return;
    }
    targets.bind(candidate, { resetHistory: true });
  } catch {
    await chrome.storage.local.remove(SESSION_KEY);
  }
}

async function saveTarget(nextTarget, options = {}) {
  const target = targets.bind(nextTarget, options);
  if (Object.hasOwn(options, 'userBoundOrigin')) {
    userBoundOrigin = options.userBoundOrigin;
  } else if (target?.binding !== 'user') {
    userBoundOrigin = null;
  }
  if (target) await chrome.storage.local.set({ [SESSION_KEY]: target });
  else await chrome.storage.local.remove(SESSION_KEY);
  publishBrowserStateChange();
}

function registerMessage() {
  const target = targets.current();
  const state = browserState.snapshot(target, attachedTabId, userBoundOrigin);
  return {
    type: 'browser.register',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    extensionId: chrome.runtime.id,
    capabilities: CAPABILITIES,
    ...(target ? { activeTab: { tabId: target.tabId, binding: target.binding } } : {}),
    state,
  };
}

function sendRegister() {
  if (port) port.postMessage(registerMessage());
}

function publishBrowserStateChange() {
  browserState.advance();
  sendRegister();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = calculateReconnectDelay(
    reconnectAttempt,
    RECONNECT_DELAY_MS,
    MAX_RECONNECT_DELAY_MS,
  );
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, delay);
}

function scheduleStableConnectionReset(nextPort) {
  if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
  stableConnectionTimer = setTimeout(() => {
    stableConnectionTimer = null;
    if (port === nextPort) reconnectAttempt = 0;
  }, STABLE_CONNECTION_RESET_MS);
}

function connectNativeHost() {
  if (port) return;
  try {
    const nextPort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port = nextPort;
    nextPort.onMessage.addListener((message) => {
      if (message?.type === 'browser.cancel') {
        handleCancel(message);
        return;
      }
      if (message?.type === 'browser.command' && typeof message.requestId === 'string') {
        queuedCommandRequestIds.add(message.requestId);
      }
      void enqueueExtensionWork(() => handleCommand(message));
    });
    nextPort.onDisconnect.addListener(() => {
      if (port !== nextPort) return;
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = null;
      const message = chrome.runtime.lastError?.message;
      if (message) console.warn(`[pinpawo-extension] native host disconnected: ${message}`);
      port = null;
      scheduleReconnect();
    });
    sendRegister();
    scheduleStableConnectionReset(nextPort);
  } catch {
    port = null;
    scheduleReconnect();
  }
}

async function cdp(tabId, method, params = {}) {
  if (!ALLOWED_CDP_COMMANDS.has(method)) {
    throw new ExtensionError('cdp_command_blocked', `CDP command is not allowlisted: ${method}`);
  }
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

async function attach(tabId) {
  if (attachedTabId === tabId) return;
  if (attachedTabId !== null) await detach();
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    attachedTabId = tabId;
    publishBrowserStateChange();
    port?.postMessage({
      type: 'browser.event',
      protocolVersion: PROTOCOL_VERSION,
      connectionId,
      event: 'debugger.attached',
      tabId,
    });
  } catch (error) {
    throw new ExtensionError(
      'debugger_attach_failed',
      `Chrome debugger permission was not granted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function activateTarget(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  } catch (error) {
    throw new ExtensionError(
      'target_activation_failed',
      `Unable to activate the browser target: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

async function detach() {
  if (attachedTabId === null) return { detached: false };
  const tabId = attachedTabId;
  attachedTabId = null;
  await chrome.debugger.detach({ tabId }).catch(() => {});
  publishBrowserStateChange();
  port?.postMessage({
    type: 'browser.event',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    event: 'debugger.detached',
    tabId,
  });
  return { detached: true, tabId };
}

async function ensureTarget() {
  const target = targets.current();
  if (target) {
    try {
      const tab = await chrome.tabs.get(target.tabId);
      if (isWebTab(tab)) return target;
    } catch {
      // The target was closed. Clear it below.
    }
    await saveTarget(null, { resetHistory: true });
  }
  throw new ExtensionError(
    'browser_not_open',
    'No readable browser target is available. Use browser_open first.',
    true,
  );
}

async function waitForNavigableTab(tabId, deadlineAt) {
  while (Date.now() < Date.parse(deadlineAt)) {
    ensureCommandAlive(deadlineAt);
    const tab = await chrome.tabs.get(tabId);
    if (isNavigableWebTab(tab)) {
      return tab;
    }
    await delay(100, deadlineAt);
  }
  throw new ExtensionError(
    'navigation_timeout',
    'Navigation did not finish at a readable web page before the command deadline',
    true,
  );
}

async function prepareNavigationTarget(url, deadlineAt) {
  const existing = targets.current();
  let existingTab = null;
  if (existing) {
    try {
      existingTab = await chrome.tabs.get(existing.tabId);
    } catch {
      await saveTarget(null, { resetHistory: true });
    }
  }
  if (
    selectNavigationTarget(existing) === 'reuse_agent_tab'
    && isWebTab(existingTab)
  ) {
    await chrome.tabs.update(existing.tabId, { url, active: true });
    await waitForNavigableTab(existing.tabId, deadlineAt);
    await saveTarget(
      { tabId: existing.tabId, binding: 'agent' },
      { resetHistory: true },
    );
    return targets.current();
  }

  if (existing?.binding === 'agent' && existingTab) {
    await saveTarget(null, { resetHistory: true });
    await chrome.tabs.remove(existing.tabId).catch(() => {});
  }

  // A tab explicitly bound by the user remains their page. browser_open gets a
  // separate agent-owned tab instead of navigating the user's bound tab away.
  const tab = await chrome.tabs.create({ url, active: true });
  if (!Number.isInteger(tab.id)) {
    throw new ExtensionError('target_create_failed', 'Chrome did not return a tab id');
  }
  await waitForNavigableTab(tab.id, deadlineAt);
  await saveTarget({ tabId: tab.id, binding: 'agent' }, { resetHistory: true });
  return targets.current();
}

async function rollbackPopupSwitch(tabId) {
  await detach();
  const removed = targets.remove(tabId);
  if (!removed.closedCurrent) return removed.current;
  await saveTarget(removed.current);
  if (removed.current) await attach(removed.current.tabId);
  return removed.current;
}

async function switchToPopup(tabId, parentTarget, deadlineAt) {
  if (targets.current()?.tabId !== parentTarget.tabId) return targets.current();
  try {
    await chrome.tabs.get(tabId);
  } catch {
    return targets.current();
  }
  await detach();
  try {
    await saveTarget(
      { tabId, binding: parentTarget.binding },
      { rememberCurrent: true },
    );
    await waitForTab(tabId, deadlineAt);
    await activateTarget(tabId);
    await attach(tabId);
    return targets.current();
  } catch (error) {
    try {
      await rollbackPopupSwitch(tabId);
    } catch (rollbackError) {
      console.warn(
        '[pinpawo-extension] failed to restore popup parent:',
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      );
    }
    throw error;
  }
}

async function handleRemovedTarget(tabId) {
  const removed = targets.remove(tabId);
  if (!removed.closedCurrent) return removed.current;
  if (attachedTabId === tabId) attachedTabId = null;
  await saveTarget(removed.current);
  if (removed.current) {
    await activateTarget(removed.current.tabId);
    await attach(removed.current.tabId);
    return removed.current;
  }
  port?.postMessage({
    type: 'browser.event',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    event: 'target.closed',
    tabId,
  });
  return null;
}

async function requireLiveResultTarget(candidate) {
  if (!candidate) {
    throw new ExtensionError('target_closed', 'The active browser target was closed', true);
  }
  try {
    await chrome.tabs.get(candidate.tabId);
    return candidate;
  } catch {
    const fallback = await handleRemovedTarget(candidate.tabId);
    if (fallback) return fallback;
    throw new ExtensionError('target_closed', 'The active browser target was closed', true);
  }
}

async function followPopupAfterAction(parentTarget, tracking, deadlineAt) {
  const waitDeadline = Math.min(Date.now() + 300, Date.parse(deadlineAt));
  while (Date.now() <= waitDeadline) {
    ensureCommandAlive(deadlineAt);
    const popup = recentPopupByOpener.get(parentTarget.tabId);
    if (popup?.tracking === tracking) {
      recentPopupByOpener.delete(parentTarget.tabId);
      return await switchToPopup(popup.tabId, parentTarget, deadlineAt);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return targets.current();
}

function startPopupTracking(parentTabId) {
  recentPopupByOpener.delete(parentTabId);
  const tracking = Object.freeze({
    requestId: activeCommandRequestId,
    parentTabId,
  });
  popupTracking = tracking;
  return tracking;
}

function stopPopupTracking(tracking) {
  if (popupTracking === tracking) {
    popupTracking = null;
  }
  if (recentPopupByOpener.get(tracking.parentTabId)?.tracking === tracking) {
    recentPopupByOpener.delete(tracking.parentTabId);
  }
}

async function currentUrl(tabId) {
  const history = await cdp(tabId, 'Page.getNavigationHistory');
  const entry = history.entries?.[history.currentIndex];
  if (!entry || typeof entry.url !== 'string') {
    throw new ExtensionError('target_url_unavailable', 'Unable to read the active tab URL', true);
  }
  return entry.url;
}

function originChangedError(tabId, approvedOrigin, actualOrigin) {
  const manualActionRequired = targets.current()?.tabId === tabId
    && targets.history().length > 0;
  return new ExtensionError(
    'origin_changed',
    manualActionRequired
      ? 'Cross-origin popup access is blocked. Ask the user to complete it manually, then retry after it closes or returns to the approved origin.'
      : `The tab navigated outside the approved origin (${approvedOrigin}). Use browser_open with an approved URL before reading it.`,
    false,
    {
      approvedOrigin,
      ...(typeof actualOrigin === 'string' ? { actualOrigin } : {}),
      ...(manualActionRequired ? {
        manualActionRequired: true,
        recovery: 'complete_popup_manually',
      } : {}),
    },
  );
}

async function assertApprovedOrigin(tabId, approvedOrigin) {
  if (typeof approvedOrigin !== 'string' || !approvedOrigin) {
    throw new ExtensionError('origin_approval_missing', 'No approved origin was supplied');
  }
  const url = await currentUrl(tabId);
  const actualOrigin = originOf(url);
  if (actualOrigin !== approvedOrigin) {
    throw originChangedError(tabId, approvedOrigin, actualOrigin);
  }
  return url;
}

function validateSnapshotOrigin(snapshot, approvedOrigin, tabId) {
  try {
    return assertSnapshotApprovedOrigin(snapshot, approvedOrigin);
  } catch {
    let actualOrigin;
    try {
      actualOrigin = originOf(snapshot?.url);
    } catch {}
    throw originChangedError(tabId, approvedOrigin, actualOrigin);
  }
}

async function waitForTab(tabId, deadlineAt) {
  while (Date.now() < Date.parse(deadlineAt)) {
    ensureCommandAlive(deadlineAt);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await delay(100, deadlineAt);
  }
  throw new ExtensionError('navigation_timeout', 'Navigation did not finish before the command deadline', true);
}

async function readSnapshot(tabId, approvedOrigin) {
  await assertApprovedOrigin(tabId, approvedOrigin);
  let snapshot;
  try {
    const evaluation = await cdp(tabId, 'Runtime.evaluate', {
      expression: buildSnapshotExpression(),
      returnByValue: true,
      awaitPromise: true,
    });
    if (evaluation.exceptionDetails || !evaluation.result?.value) {
      throw new Error(evaluation.exceptionDetails?.text || 'Runtime.evaluate returned no value');
    }
    snapshot = evaluation.result.value;
  } catch (runtimeError) {
    const fallbackUrl = await assertApprovedOrigin(tabId, approvedOrigin);
    try {
      const tree = await cdp(tabId, 'Accessibility.getFullAXTree');
      snapshot = buildAccessibilitySnapshot(tree.nodes || [], fallbackUrl);
    } catch (accessibilityError) {
      throw new ExtensionError(
        'snapshot_unavailable',
        `Runtime and accessibility snapshot failed: ${runtimeError}; ${accessibilityError}`,
        true,
      );
    }
  }
  validateSnapshotOrigin(snapshot, approvedOrigin, tabId);
  await assertApprovedOrigin(tabId, approvedOrigin);
  return snapshot;
}

async function readInteractionResult(tabId, approvedOrigin) {
  try {
    return await readSnapshot(tabId, approvedOrigin);
  } catch (error) {
    if (error instanceof ExtensionError && error.code === 'origin_changed') {
      throw new ExtensionError(
        error.code,
        error.message,
        error.retryable,
        { ...error.details, interactionDispatched: true },
      );
    }
    throw error;
  }
}

async function evaluateValue(tabId, expression) {
  const evaluation = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (evaluation.exceptionDetails || !evaluation.result || !('value' in evaluation.result)) {
    throw new ExtensionError(
      'runtime_evaluation_failed',
      evaluation.exceptionDetails?.text || 'Runtime.evaluate returned no value',
      true,
    );
  }
  return evaluation.result.value;
}

function requirePageResult(value) {
  if (!value || typeof value !== 'object' || value.ok !== true) {
    throw new ExtensionError(
      typeof value?.code === 'string' ? value.code : 'page_operation_failed',
      typeof value?.message === 'string' ? value.message : 'The page operation failed',
      value?.code === 'element_not_found',
    );
  }
  return value;
}

function ensureCommandAlive(deadlineAt) {
  if (activeCommandRequestId && cancelledCommandRequestIds.has(activeCommandRequestId)) {
    throw new ExtensionError('browser_command_cancelled', 'Browser command was cancelled.', true);
  }
  if (Date.now() > Date.parse(deadlineAt)) {
    throw new ExtensionError('command_expired', 'Browser command expired during execution', true);
  }
}

async function delay(ms, deadlineAt) {
  ensureCommandAlive(deadlineAt);
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  ensureCommandAlive(deadlineAt);
}

async function resolveTarget(tabId, target) {
  const normalized = normalizeElementTarget(target);
  const accessibilityRef = normalized.ref
    ? /^ax:(\d+):([a-z]+)$/.exec(normalized.ref)
    : null;
  if (accessibilityRef) {
    const backendNodeId = Number(accessibilityRef[1]);
    await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const model = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId });
    const quad = model.model?.border;
    if (!Array.isArray(quad) || quad.length !== 8) {
      throw new ExtensionError('element_not_visible', 'The accessibility element has no visible box');
    }
    return {
      ok: true,
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
      tag: accessibilityRef[2],
      editable: ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(accessibilityRef[2]),
    };
  }
  return requirePageResult(await evaluateValue(tabId, buildResolveTargetExpression(normalized)));
}

async function resolveTargetForAction(tabId, target, deadlineAt, approvedOrigin) {
  const normalized = normalizeElementTarget(target);
  const retryDeadline = Math.min(Date.now() + 1_000, Date.parse(deadlineAt));
  while (true) {
    ensureCommandAlive(deadlineAt);
    await assertApprovedOrigin(tabId, approvedOrigin);
    try {
      return await resolveTarget(tabId, normalized);
    } catch (error) {
      const retryableSelectorState = normalized.selector
        && error instanceof ExtensionError
        && ['element_not_found', 'element_not_visible'].includes(error.code);
      if (!retryableSelectorState || Date.now() >= retryDeadline) throw error;
      await delay(100, deadlineAt);
    }
  }
}

async function dispatchClick(tabId, target, humanization, deadlineAt, approvedOrigin) {
  await activateTarget(tabId);
  const point = await resolveTargetForAction(
    tabId,
    target,
    deadlineAt,
    approvedOrigin,
  );
  await delay(randomDelayMs(humanization.preDelayMinMs, humanization.preDelayMaxMs), deadlineAt);
  await assertApprovedOrigin(tabId, approvedOrigin);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  });
  await delay(randomDelayMs(humanization.hoverMinMs, humanization.hoverMaxMs), deadlineAt);
  await assertApprovedOrigin(tabId, approvedOrigin);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await delay(randomDelayMs(25, 70), deadlineAt);
  await assertApprovedOrigin(tabId, approvedOrigin);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  return point;
}

async function dispatchKey(tabId, key, params = {}, approvedOrigin) {
  const { text, ...keyParams } = params;
  await assertApprovedOrigin(tabId, approvedOrigin);
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    ...keyParams,
  });
  if (typeof text === 'string') {
    await assertApprovedOrigin(tabId, approvedOrigin);
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'char',
      key,
      text,
      ...keyParams,
    });
  }
  await assertApprovedOrigin(tabId, approvedOrigin);
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: keyParams.code,
  });
}

async function dispatchType(tabId, params, deadlineAt, approvedOrigin) {
  if (typeof params.text !== 'string') {
    throw new ExtensionError('invalid_type_text', 'Type text must be a string');
  }
  const humanization = normalizeHumanization(params.humanization);
  const point = await dispatchClick(
    tabId,
    params.target,
    humanization,
    deadlineAt,
    approvedOrigin,
  );
  if (!point.editable) {
    throw new ExtensionError('element_not_editable', 'The target element is not editable');
  }
  await assertApprovedOrigin(tabId, approvedOrigin);
  await dispatchKey(tabId, 'a', { code: 'KeyA', commands: ['SelectAll'] }, approvedOrigin);
  await dispatchKey(
    tabId,
    'Backspace',
    { code: 'Backspace', windowsVirtualKeyCode: 8 },
    approvedOrigin,
  );
  const characters = Array.from(params.text);
  if (characters.length <= HUMANIZED_TYPE_CHARACTER_LIMIT) {
    for (const character of characters) {
      ensureCommandAlive(deadlineAt);
      if (character === '\n') {
        await dispatchKey(
          tabId,
          'Enter',
          { code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 },
          approvedOrigin,
        );
      } else {
        await dispatchKey(tabId, character, { text: character }, approvedOrigin);
      }
      await delay(randomDelayMs(humanization.keyDelayMinMs, humanization.keyDelayMaxMs), deadlineAt);
    }
  } else {
    for (const chunk of chunkTrustedInsertText(params.text)) {
      ensureCommandAlive(deadlineAt);
      await assertApprovedOrigin(tabId, approvedOrigin);
      await cdp(tabId, 'Input.insertText', { text: chunk });
      await assertApprovedOrigin(tabId, approvedOrigin);
      await delay(randomDelayMs(humanization.keyDelayMinMs, humanization.keyDelayMaxMs), deadlineAt);
    }
  }
  if (params.submit === true) {
    await dispatchKey(
      tabId,
      'Enter',
      { code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 },
      approvedOrigin,
    );
  }
}

function boundedScrollDelta(value, name) {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10_000) {
    throw new ExtensionError('invalid_scroll_delta', `${name} must be between -10000 and 10000`);
  }
  return value;
}

async function dispatchScroll(tabId, params, deadlineAt, approvedOrigin) {
  await activateTarget(tabId);
  const deltaX = boundedScrollDelta(params.deltaX, 'deltaX');
  const deltaY = boundedScrollDelta(params.deltaY, 'deltaY');
  if (deltaX === 0 && deltaY === 0) {
    throw new ExtensionError('invalid_scroll_delta', 'At least one scroll delta must be non-zero');
  }
  const point = params.target
    ? await resolveTargetForAction(
      tabId,
      params.target,
      deadlineAt,
      approvedOrigin,
    )
    : { x: 1, y: 1 };
  await assertApprovedOrigin(tabId, approvedOrigin);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
  });
  await delay(150, deadlineAt);
}

async function waitForPageCondition(tabId, params, deadlineAt, approvedOrigin) {
  const timeoutMs = params.timeoutMs ?? 3_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new ExtensionError('invalid_wait_timeout', 'timeoutMs must be between 1 and 30000');
  }
  const waitDeadline = Math.min(Date.now() + timeoutMs, Date.parse(deadlineAt));
  const state = params.state ?? 'visible';
  if (state !== 'visible' && state !== 'hidden') {
    throw new ExtensionError('invalid_wait_state', 'state must be visible or hidden');
  }
  if (!params.target) {
    await delay(Math.max(0, waitDeadline - Date.now()), deadlineAt);
    return;
  }
  const target = normalizeElementTarget(params.target);
  while (Date.now() < waitDeadline) {
    try {
      await assertApprovedOrigin(tabId, approvedOrigin);
      await resolveTarget(tabId, target);
      if (state === 'visible') return;
    } catch (error) {
      if (
        state === 'hidden'
        && error instanceof ExtensionError
        && [
          'element_not_found',
          'element_not_visible',
          'stale_element_reference',
        ].includes(error.code)
      ) return;
      if (
        !(error instanceof ExtensionError)
        || !['element_not_found', 'element_not_visible'].includes(error.code)
      ) throw error;
    }
    await delay(100, deadlineAt);
  }
  throw new ExtensionError(
    'wait_timeout',
    `The target did not become ${state} before timeout`,
    true,
    { state, timeoutMs },
  );
}

async function readExtract(tabId, params, approvedOrigin) {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50_000;
  await assertApprovedOrigin(tabId, approvedOrigin);
  const result = requirePageResult(await evaluateValue(
    tabId,
    buildExtractExpression(params.selector, offset, limit),
  ));
  validateSnapshotOrigin(result, approvedOrigin, tabId);
  await assertApprovedOrigin(tabId, approvedOrigin);
  const { ok: _ok, ...raw } = result;
  return raw;
}

async function captureScreenshot(tabId, approvedOrigin) {
  await assertApprovedOrigin(tabId, approvedOrigin);
  for (const quality of [75, 55, 35]) {
    const result = await cdp(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality,
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    });
    if (typeof result.data !== 'string') {
      throw new ExtensionError('screenshot_unavailable', 'Chrome returned no screenshot data', true);
    }
    const estimatedBytes = Math.floor(result.data.length * 3 / 4);
    if (estimatedBytes <= 700_000) {
      await assertApprovedOrigin(tabId, approvedOrigin);
      return { mimeType: 'image/jpeg', data: result.data };
    }
  }
  throw new ExtensionError(
    'screenshot_too_large',
    'The viewport screenshot exceeds the Native Messaging safety limit',
    true,
  );
}

async function executeCommand(command) {
  activeCommandRequestId = command.requestId;
  try {
    return await executeCommandBody(command);
  } finally {
    activeCommandRequestId = null;
  }
}

async function executeCommandBody(command) {
  ensureCommandAlive(command.deadlineAt);
  if (command.command === 'detach') return await detach();

  const approvedOrigin = command.params.approvedOrigin;
  if (command.command === 'navigate') {
    const url = command.params.url;
    if (typeof url !== 'string' || originOf(url) !== approvedOrigin) {
      throw new ExtensionError('origin_approval_mismatch', 'Navigation URL does not match its approved origin');
    }
    const activeTarget = await prepareNavigationTarget(url, command.deadlineAt);
    if (!activeTarget) {
      throw new ExtensionError('target_create_failed', 'Chrome did not provide a navigation target');
    }
    await activateTarget(activeTarget.tabId);
    await attach(activeTarget.tabId);
    port?.postMessage({
      type: 'browser.event',
      protocolVersion: PROTOCOL_VERSION,
      connectionId,
      event: 'tab.navigated',
      tabId: activeTarget.tabId,
      url,
    });
    return await readSnapshot(activeTarget.tabId, approvedOrigin);
  }

  const activeTarget = await ensureTarget();
  await attach(activeTarget.tabId);
  if (command.command === 'snapshot') {
    return await readSnapshot(activeTarget.tabId, approvedOrigin);
  }
  if (command.command === 'extract') {
    return await readExtract(activeTarget.tabId, command.params, approvedOrigin);
  }
  if (command.command === 'screenshot') {
    return await captureScreenshot(activeTarget.tabId, approvedOrigin);
  }
  if (command.command === 'click') {
    await assertApprovedOrigin(activeTarget.tabId, approvedOrigin);
    const tracking = startPopupTracking(activeTarget.tabId);
    try {
      await dispatchClick(
        activeTarget.tabId,
        command.params.target,
        normalizeHumanization(command.params.humanization),
        command.deadlineAt,
        approvedOrigin,
      );
      await delay(150, command.deadlineAt);
      const followedTarget = await followPopupAfterAction(activeTarget, tracking, command.deadlineAt);
      const resultTarget = await requireLiveResultTarget(followedTarget ?? activeTarget);
      return await readInteractionResult(resultTarget.tabId, approvedOrigin);
    } finally {
      stopPopupTracking(tracking);
    }
  }
  if (command.command === 'type') {
    await assertApprovedOrigin(activeTarget.tabId, approvedOrigin);
    const tracking = startPopupTracking(activeTarget.tabId);
    try {
      await dispatchType(activeTarget.tabId, command.params, command.deadlineAt, approvedOrigin);
      await delay(100, command.deadlineAt);
      const followedTarget = await followPopupAfterAction(activeTarget, tracking, command.deadlineAt);
      const resultTarget = await requireLiveResultTarget(followedTarget ?? activeTarget);
      return await readInteractionResult(resultTarget.tabId, approvedOrigin);
    } finally {
      stopPopupTracking(tracking);
    }
  }
  if (command.command === 'scroll') {
    await assertApprovedOrigin(activeTarget.tabId, approvedOrigin);
    await dispatchScroll(
      activeTarget.tabId,
      command.params,
      command.deadlineAt,
      approvedOrigin,
    );
    return await readSnapshot(activeTarget.tabId, approvedOrigin);
  }
  if (command.command === 'wait') {
    await assertApprovedOrigin(activeTarget.tabId, approvedOrigin);
    await waitForPageCondition(
      activeTarget.tabId,
      command.params,
      command.deadlineAt,
      approvedOrigin,
    );
    return await readSnapshot(activeTarget.tabId, approvedOrigin);
  }

  throw new ExtensionError('unsupported_command', `Unsupported browser command: ${command.command}`);
}

function handleCancel(value) {
  try {
    const cancellation = parseBrowserCancel(value);
    if (
      cancellation.connectionId === connectionId
      && queuedCommandRequestIds.has(cancellation.requestId)
    ) {
      cancelledCommandRequestIds.add(cancellation.requestId);
    }
  } catch {
    // Malformed cancellation cannot change browser state.
  }
}

async function handleCommand(value) {
  const requestId = typeof value?.requestId === 'string' ? value.requestId : null;
  let command;
  try {
    command = parseBrowserCommand(value);
    if (command.connectionId !== connectionId) return;
    const result = await executeCommand(command);
    if (cancelledCommandRequestIds.has(command.requestId)) {
      throw new ExtensionError('browser_command_cancelled', 'Browser command was cancelled.', true);
    }
    port?.postMessage(successResult(command, result));
  } catch (error) {
    if (command) port?.postMessage(errorResult(command, error));
  } finally {
    if (requestId) {
      queuedCommandRequestIds.delete(requestId);
      cancelledCommandRequestIds.delete(requestId);
    }
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id)) return;
  let approvedOrigin = null;
  try {
    approvedOrigin = typeof tab.url === 'string' ? originOf(tab.url) : null;
  } catch {
    // The binding remains visible, but only an http(s) user gesture can
    // authorize browser reads or interactions.
  }
  await enqueueExtensionWork(async () => {
    await detach();
    await saveTarget(
      { tabId: tab.id, binding: 'user' },
      { resetHistory: true, userBoundOrigin: approvedOrigin },
    );
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab.id) || !shouldTrackPopup(
    popupTracking?.parentTabId,
    targets.current(),
    tab.openerTabId,
  )) return;
  recentPopupByOpener.set(tab.openerTabId, { tabId: tab.id, tracking: popupTracking });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await enqueueExtensionWork(async () => {
    recentPopupByOpener.delete(tabId);
    await handleRemovedTarget(tabId);
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== attachedTabId) return;
  attachedTabId = null;
  publishBrowserStateChange();
  port?.postMessage({
    type: 'browser.event',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    event: 'debugger.detached',
    tabId: source.tabId,
    reason,
  });
});

async function initialize() {
  await restoreTarget();
  connectNativeHost();
}

void initialize().catch((error) => {
  console.error(
    '[pinpawo-extension] initialization failed:',
    error instanceof Error ? error.message : String(error),
  );
  connectNativeHost();
});
