import {
  CAPABILITIES,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  errorResult,
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
  buildExtractExpression,
  buildResolveTargetExpression,
  normalizeElementTarget,
  normalizeHumanization,
  randomDelayMs,
} from './interaction.js';

const CDP_VERSION = '1.3';
const ALLOWED_CDP_COMMANDS = new Set([
  'Accessibility.getFullAXTree',
  'DOM.getBoxModel',
  'DOM.scrollIntoViewIfNeeded',
  'Page.getNavigationHistory',
  'Page.navigate',
  'Page.captureScreenshot',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Runtime.evaluate',
]);
const SESSION_KEY = 'pinpawoBrowserTarget';
const RECONNECT_DELAY_MS = 1_000;
const connectionId = crypto.randomUUID();
let port = null;
let reconnectTimer = null;
let target = null;
let attachedTabId = null;

class ExtensionError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

async function restoreTarget() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const candidate = stored[SESSION_KEY];
  if (!candidate || !Number.isInteger(candidate.tabId)) return;
  try {
    await chrome.tabs.get(candidate.tabId);
    target = candidate;
  } catch {
    await chrome.storage.local.remove(SESSION_KEY);
  }
}

async function saveTarget(nextTarget) {
  target = nextTarget;
  if (target) await chrome.storage.local.set({ [SESSION_KEY]: target });
  else await chrome.storage.local.remove(SESSION_KEY);
  sendRegister();
}

function registerMessage() {
  return {
    type: 'browser.register',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    extensionId: chrome.runtime.id,
    capabilities: CAPABILITIES,
    ...(target ? { activeTab: { tabId: target.tabId, ownership: target.ownership } } : {}),
  };
}

function sendRegister() {
  if (port) port.postMessage(registerMessage());
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, RECONNECT_DELAY_MS);
}

function connectNativeHost() {
  if (port) return;
  try {
    const nextPort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port = nextPort;
    nextPort.onMessage.addListener((message) => void handleCommand(message));
    nextPort.onDisconnect.addListener(() => {
      if (port !== nextPort) return;
      port = null;
      scheduleReconnect();
    });
    sendRegister();
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

async function detach() {
  if (attachedTabId === null) return { detached: false };
  const tabId = attachedTabId;
  attachedTabId = null;
  await chrome.debugger.detach({ tabId }).catch(() => {});
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
  if (target) {
    try {
      await chrome.tabs.get(target.tabId);
      return target;
    } catch {
      await saveTarget(null);
    }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (!Number.isInteger(tab.id)) {
    throw new ExtensionError('target_create_failed', 'Chrome did not return a tab id');
  }
  await saveTarget({ tabId: tab.id, ownership: 'agent' });
  return target;
}

async function currentUrl(tabId) {
  const history = await cdp(tabId, 'Page.getNavigationHistory');
  const entry = history.entries?.[history.currentIndex];
  if (!entry || typeof entry.url !== 'string') {
    throw new ExtensionError('target_url_unavailable', 'Unable to read the active tab URL', true);
  }
  return entry.url;
}

async function assertApprovedOrigin(tabId, approvedOrigin) {
  if (typeof approvedOrigin !== 'string' || !approvedOrigin) {
    throw new ExtensionError('origin_approval_missing', 'No approved origin was supplied');
  }
  const url = await currentUrl(tabId);
  if (originOf(url) !== approvedOrigin) {
    throw new ExtensionError(
      'origin_changed',
      `The tab navigated outside the approved origin (${approvedOrigin}); approve the new URL before reading it.`,
    );
  }
  return url;
}

function validateSnapshotOrigin(snapshot, approvedOrigin) {
  try {
    return assertSnapshotApprovedOrigin(snapshot, approvedOrigin);
  } catch {
    throw new ExtensionError(
      'origin_changed',
      `The snapshot did not come from the approved origin (${approvedOrigin}); approve the current URL before reading it.`,
    );
  }
}

async function waitForTab(tabId, deadlineAt) {
  while (Date.now() < Date.parse(deadlineAt)) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  validateSnapshotOrigin(snapshot, approvedOrigin);
  await assertApprovedOrigin(tabId, approvedOrigin);
  return snapshot;
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

async function dispatchClick(tabId, target, humanization, deadlineAt) {
  const point = await resolveTarget(tabId, normalizeElementTarget(target));
  await delay(randomDelayMs(humanization.preDelayMinMs, humanization.preDelayMaxMs), deadlineAt);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  });
  await delay(randomDelayMs(humanization.hoverMinMs, humanization.hoverMaxMs), deadlineAt);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await delay(randomDelayMs(25, 70), deadlineAt);
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

async function dispatchKey(tabId, key, params = {}) {
  const { text, ...keyParams } = params;
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    ...keyParams,
  });
  if (typeof text === 'string') {
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'char',
      key,
      text,
      ...keyParams,
    });
  }
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: keyParams.code,
  });
}

async function dispatchType(tabId, params, deadlineAt, approvedOrigin) {
  if (typeof params.text !== 'string' || params.text.length > 500) {
    throw new ExtensionError('invalid_type_text', 'Type text must be a string of at most 500 characters');
  }
  const humanization = normalizeHumanization(params.humanization);
  const point = await dispatchClick(tabId, params.target, humanization, deadlineAt);
  if (!point.editable) {
    throw new ExtensionError('element_not_editable', 'The target element is not editable');
  }
  await assertApprovedOrigin(tabId, approvedOrigin);
  await dispatchKey(tabId, 'a', { code: 'KeyA', commands: ['SelectAll'] });
  await dispatchKey(tabId, 'Backspace', { code: 'Backspace', windowsVirtualKeyCode: 8 });
  for (const character of Array.from(params.text)) {
    ensureCommandAlive(deadlineAt);
    await assertApprovedOrigin(tabId, approvedOrigin);
    if (character === '\n') {
      await dispatchKey(tabId, 'Enter', { code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    } else {
      await dispatchKey(tabId, character, { text: character });
    }
    await delay(randomDelayMs(humanization.keyDelayMinMs, humanization.keyDelayMaxMs), deadlineAt);
  }
  if (params.submit === true) {
    await assertApprovedOrigin(tabId, approvedOrigin);
    await dispatchKey(tabId, 'Enter', { code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  }
}

function boundedScrollDelta(value, name) {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10_000) {
    throw new ExtensionError('invalid_scroll_delta', `${name} must be between -10000 and 10000`);
  }
  return value;
}

async function dispatchScroll(tabId, params, deadlineAt) {
  const deltaX = boundedScrollDelta(params.deltaX, 'deltaX');
  const deltaY = boundedScrollDelta(params.deltaY, 'deltaY');
  if (deltaX === 0 && deltaY === 0) {
    throw new ExtensionError('invalid_scroll_delta', 'At least one scroll delta must be non-zero');
  }
  const point = params.target
    ? await resolveTarget(tabId, normalizeElementTarget(params.target))
    : { x: 1, y: 1 };
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
  });
  await delay(150, deadlineAt);
}

async function waitForPageCondition(tabId, params, deadlineAt) {
  const timeoutMs = params.timeoutMs ?? 3_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new ExtensionError('invalid_wait_timeout', 'timeoutMs must be between 1 and 30000');
  }
  const waitDeadline = Math.min(Date.now() + timeoutMs, Date.parse(deadlineAt));
  if (!params.target) {
    await delay(Math.max(0, waitDeadline - Date.now()), deadlineAt);
    return;
  }
  const target = normalizeElementTarget(params.target);
  while (Date.now() < waitDeadline) {
    try {
      await resolveTarget(tabId, target);
      return;
    } catch (error) {
      if (!(error instanceof ExtensionError) || error.code !== 'element_not_found') throw error;
    }
    await delay(100, deadlineAt);
  }
  throw new ExtensionError('wait_timeout', 'The target did not become visible before timeout', true);
}

async function readExtract(tabId, params, approvedOrigin) {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50_000;
  await assertApprovedOrigin(tabId, approvedOrigin);
  const result = requirePageResult(await evaluateValue(
    tabId,
    buildExtractExpression(params.selector, offset, limit),
  ));
  validateSnapshotOrigin(result, approvedOrigin);
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
  if (Date.now() > Date.parse(command.deadlineAt)) {
    throw new ExtensionError('command_expired', 'Browser command deadline has already passed', true);
  }
  if (command.command === 'detach') return await detach();

  const activeTarget = await ensureTarget();
  await attach(activeTarget.tabId);
  const approvedOrigin = command.params.approvedOrigin;
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
    await dispatchClick(
      activeTarget.tabId,
      command.params.target,
      normalizeHumanization(command.params.humanization),
      command.deadlineAt,
    );
    await delay(150, command.deadlineAt);
    return await readSnapshot(activeTarget.tabId, approvedOrigin);
  }
  if (command.command === 'type') {
    await assertApprovedOrigin(activeTarget.tabId, approvedOrigin);
    await dispatchType(activeTarget.tabId, command.params, command.deadlineAt, approvedOrigin);
    await delay(100, command.deadlineAt);
    return await readSnapshot(activeTarget.tabId, approvedOrigin);
  }
  if (command.command === 'scroll') {
    await assertApprovedOrigin(activeTarget.tabId, approvedOrigin);
    await dispatchScroll(activeTarget.tabId, command.params, command.deadlineAt);
    return await readSnapshot(activeTarget.tabId, approvedOrigin);
  }
  if (command.command === 'wait') {
    await assertApprovedOrigin(activeTarget.tabId, approvedOrigin);
    await waitForPageCondition(activeTarget.tabId, command.params, command.deadlineAt);
    return await readSnapshot(activeTarget.tabId, approvedOrigin);
  }

  const url = command.params.url;
  if (typeof url !== 'string' || originOf(url) !== approvedOrigin) {
    throw new ExtensionError('origin_approval_mismatch', 'Navigation URL does not match its approved origin');
  }
  const navigation = await cdp(activeTarget.tabId, 'Page.navigate', { url });
  if (navigation.errorText) {
    throw new ExtensionError('navigation_failed', navigation.errorText, true);
  }
  await waitForTab(activeTarget.tabId, command.deadlineAt);
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

async function handleCommand(value) {
  let command;
  try {
    command = parseBrowserCommand(value);
    if (command.connectionId !== connectionId) return;
    const result = await executeCommand(command);
    port?.postMessage(successResult(command, result));
  } catch (error) {
    if (command) port?.postMessage(errorResult(command, error));
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id)) return;
  await detach();
  await saveTarget({ tabId: tab.id, ownership: 'user' });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (target?.tabId !== tabId) return;
  attachedTabId = null;
  await saveTarget(null);
  port?.postMessage({
    type: 'browser.event',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    event: 'target.closed',
    tabId,
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== attachedTabId) return;
  attachedTabId = null;
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
