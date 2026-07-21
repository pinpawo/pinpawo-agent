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

const CDP_VERSION = '1.3';
const ALLOWED_CDP_COMMANDS = new Set([
  'Accessibility.getFullAXTree',
  'Page.getNavigationHistory',
  'Page.navigate',
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

async function executeCommand(command) {
  if (Date.now() > Date.parse(command.deadlineAt)) {
    throw new ExtensionError('command_expired', 'Browser command deadline has already passed', true);
  }
  if (command.command === 'detach') return await detach();

  const activeTarget = await ensureTarget();
  await attach(activeTarget.tabId);
  if (command.command === 'snapshot') {
    return await readSnapshot(activeTarget.tabId, command.params.approvedOrigin);
  }

  const url = command.params.url;
  const approvedOrigin = command.params.approvedOrigin;
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
