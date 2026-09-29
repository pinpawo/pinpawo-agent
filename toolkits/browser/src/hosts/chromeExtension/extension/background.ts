import {
  CAPABILITIES,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  errorResult,
  parseBrowserCancel,
  parseBrowserCommand,
  successResult,
} from './protocol.js';
import type { BrowserTarget, JsonRecord, TargetBindOptions } from './types.js';
import {
  accessibilityLoaderKey,
  isAccessibilityRef,
  parseAccessibilityRef,
} from './accessibilityRef.js';
import {
  assertSnapshotApprovedOrigin,
  buildDomTreeSnapshot,
  buildSensitiveInputsExpression,
  buildSnapshotExpression,
  originOf,
} from './snapshot.js';
import {
  AccessibilityScopeNotFoundError,
  buildAccessibilityTreeSnapshot,
} from './accessibilityTree.js';
import {
  HUMANIZED_TYPE_CHARACTER_LIMIT,
  buildExtractExpression,
  buildResolveTargetExpression,
  buildTargetElementExpression,
  chunkTrustedInsertText,
  createSerialExecutor,
  normalizeElementTarget,
  normalizeHumanization,
  randomDelayMs,
} from './interaction.js';
import {
  createTargetStack,
  isWebTab,
  selectNavigationTarget,
  shouldTrackPopup,
} from './targetLifecycle.js';
import { createBrowserStateTracker, type ContextTargetState } from './browserState.js';
import {
  contextForGroup,
  contextGroupColor,
  contextGroupTitle,
  parsePersistedContextGroups,
  type ContextGroup,
} from './tabGroups.js';
import { calculateReconnectDelay } from './reconnect.js';
import {
  documentReadyEvent,
  navigationCommittedEvent,
  domChangedEvent,
  networkActivityEvent,
} from './liveReadiness.js';

const CDP_VERSION = '1.3';
const ALLOWED_CDP_COMMANDS = new Set([
  'Accessibility.getFullAXTree',
  'DOM.describeNode',
  'DOM.getBoxModel',
  'DOM.scrollIntoViewIfNeeded',
  'Network.enable',
  'Page.getNavigationHistory',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.enable',
  'Page.captureScreenshot',
  'Input.insertText',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Runtime.evaluate',
  'Runtime.getProperties',
  'Runtime.releaseObjectGroup',
]);
const SESSION_KEY = 'pinpawoBrowserTarget';
const CONTEXT_TARGETS_KEY = 'pinpawoBrowserTargetsByContext';
const CONTEXT_GROUPS_KEY = 'pinpawoTabGroupsByContext';
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const STABLE_CONNECTION_RESET_MS = 10_000;
const connectionId = crypto.randomUUID();
let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let attachedTabId: number | null = null;
const enqueueExtensionWork = createSerialExecutor();
const browserState = createBrowserStateTracker();
const recentPopupByOpener = new Map<number, PopupRecord>();
const networkRequestsByTab = new Map<number, Set<string>>();
const queuedCommandRequestIds = new Set();
const cancelledCommandRequestIds = new Set();
let activeCommandRequestId: string | null = null;
// Commands run through enqueueExtensionWork. Retain the command identity as
// well, so a future change to command concurrency cannot let one cleanup erase
// a newer interaction's popup record.
interface PopupTracking {
  requestId: string | null;
  parentTabId: number;
}

interface PopupRecord {
  tabId: number;
  tracking: PopupTracking;
}

let popupTracking: PopupTracking | null = null;

const LEGACY_BROWSER_CONTEXT_ID = 'legacy';
const MAX_BROWSER_CONTEXT_ID_LENGTH = 128;

type BrowserTargetContext = {
  targets: ReturnType<typeof createTargetStack>;
  userBoundOrigin: string | null;
};

const targetContexts = new Map<string, BrowserTargetContext>();
/** Each Agent session context's tab group (#867). */
const groupsByContext = new Map<string, ContextGroup>();
let groupSequence = 0;
/**
 * Origins the user approved by dragging a tab into a session's group, per tab.
 * Like the approval they replace, they live only in the running extension.
 */
const grantsByTab = new Map<number, string>();
let activeBrowserContextId = LEGACY_BROWSER_CONTEXT_ID;
let targets = createTargetStack();
let userBoundOrigin: string | null = null;
targetContexts.set(LEGACY_BROWSER_CONTEXT_ID, {
  targets,
  userBoundOrigin,
});

function readBrowserContextId(value: unknown): string {
  if (value === undefined) return LEGACY_BROWSER_CONTEXT_ID;
  if (
    typeof value !== 'string'
    || !value
    || value.length > MAX_BROWSER_CONTEXT_ID_LENGTH
  ) {
    throw new ExtensionError(
      'invalid_browser_context',
      'Browser context id must be a non-empty string up to 128 characters.',
    );
  }
  return value;
}

function browserTargetContext(contextId: string): BrowserTargetContext {
  let context = targetContexts.get(contextId);
  if (!context) {
    context = {
      targets: createTargetStack(),
      userBoundOrigin: null,
    };
    targetContexts.set(contextId, context);
  }
  return context;
}

function activateBrowserContext(contextId: string): void {
  const context = browserTargetContext(contextId);
  activeBrowserContextId = contextId;
  targets = context.targets;
  userBoundOrigin = context.userBoundOrigin;
}

function persistActiveBrowserContext(): void {
  const context = browserTargetContext(activeBrowserContextId);
  context.userBoundOrigin = userBoundOrigin;
}

function browserContextForTab(tabId: number): string | null {
  for (const [contextId, context] of targetContexts) {
    const current = context.targets.current();
    if (current?.tabId === tabId) return contextId;
    if (context.targets.history().some((target) => target.tabId === tabId)) {
      return contextId;
    }
  }
  return null;
}

function emitLifecycleEvent(
  event: string,
  tabId: number,
  options: { url?: string; payload?: Record<string, unknown> } = {},
): void {
  const contextId = browserContextForTab(tabId);
  if (!contextId || !port) return;
  port.postMessage({
    type: 'browser.event',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    event,
    contextId,
    tabId,
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  });
}

function networkRequestSet(tabId: number): Set<string> {
  let requests = networkRequestsByTab.get(tabId);
  if (!requests) {
    requests = new Set<string>();
    networkRequestsByTab.set(tabId, requests);
  }
  return requests;
}

type LiveReadinessState = {
  lastDomTextLength: number;
  lastDomTextRevision: number;
};

const liveReadinessByTab = new Map<number, LiveReadinessState>();

function liveReadinessState(tabId: number): LiveReadinessState {
  let state = liveReadinessByTab.get(tabId);
  if (!state) {
    state = { lastDomTextLength: 0, lastDomTextRevision: 0 };
    liveReadinessByTab.set(tabId, state);
  }
  return state;
}

class ExtensionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: JsonRecord;

  constructor(code: string, message: string, retryable = false, details?: JsonRecord) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

async function restoreTarget() {
  activateBrowserContext(LEGACY_BROWSER_CONTEXT_ID);
  const stored = await chrome.storage.local.get([SESSION_KEY, CONTEXT_TARGETS_KEY]);
  const persisted = stored[CONTEXT_TARGETS_KEY];
  const candidates = persisted && typeof persisted === 'object' && !Array.isArray(persisted)
    ? Object.entries(persisted as Record<string, unknown>)
    : [[LEGACY_BROWSER_CONTEXT_ID, stored[SESSION_KEY]]];
  const restored: Record<string, BrowserTarget> = {};
  for (const [contextId, candidate] of candidates) {
    if (
      typeof contextId !== 'string'
      || !contextId
      || contextId.length > MAX_BROWSER_CONTEXT_ID_LENGTH
      || !candidate
      || typeof candidate !== 'object'
      || !Number.isInteger((candidate as BrowserTarget).tabId)
    ) continue;
    try {
      const tab = await chrome.tabs.get((candidate as BrowserTarget).tabId);
      if (!isWebTab(tab)) continue;
      const context = browserTargetContext(contextId);
      context.targets.bind(candidate, { resetHistory: true });
      restored[contextId] = candidate as BrowserTarget;
    } catch {
      // Closed tabs are discarded from the persisted target map.
    }
  }
  if (Object.keys(restored).length > 0) {
    await chrome.storage.local.set({ [CONTEXT_TARGETS_KEY]: restored });
  } else {
    await chrome.storage.local.remove(CONTEXT_TARGETS_KEY);
  }
}

async function saveTarget(nextTarget: BrowserTarget | null, options: TargetBindOptions = {}) {
  const target = targets.bind(nextTarget, options);
  if (Object.hasOwn(options, 'userBoundOrigin')) {
    userBoundOrigin = options.userBoundOrigin;
    if (target && options.userBoundOrigin) grantsByTab.set(target.tabId, options.userBoundOrigin);
  } else if (target?.binding !== 'user') {
    userBoundOrigin = null;
  } else if (grantsByTab.has(target.tabId)) {
    // Falling back to an earlier user-granted tab restores its own grant.
    userBoundOrigin = grantsByTab.get(target.tabId) ?? null;
  }
  persistActiveBrowserContext();
  const stored = await chrome.storage.local.get(CONTEXT_TARGETS_KEY);
  const persisted = stored[CONTEXT_TARGETS_KEY];
  const nextTargets = persisted && typeof persisted === 'object' && !Array.isArray(persisted)
    ? { ...(persisted as Record<string, BrowserTarget>) }
    : {};
  if (target) nextTargets[activeBrowserContextId] = target;
  else delete nextTargets[activeBrowserContextId];
  if (Object.keys(nextTargets).length > 0) {
    await chrome.storage.local.set({ [CONTEXT_TARGETS_KEY]: nextTargets });
  } else {
    await chrome.storage.local.remove(CONTEXT_TARGETS_KEY);
  }
  if (activeBrowserContextId === LEGACY_BROWSER_CONTEXT_ID) {
    if (target) await chrome.storage.local.set({ [SESSION_KEY]: target });
    else await chrome.storage.local.remove(SESSION_KEY);
  }
  publishBrowserStateChange();
}

function contextTargetStates(): Record<string, ContextTargetState> {
  persistActiveBrowserContext();
  const states: Record<string, ContextTargetState> = {};
  for (const [contextId, context] of targetContexts) {
    if (contextId === LEGACY_BROWSER_CONTEXT_ID) continue;
    const current = context.targets.current();
    if (!current) continue;
    states[contextId] = {
      ...current,
      ...(current.binding === 'user' && context.userBoundOrigin
        ? { userBoundOrigin: context.userBoundOrigin }
        : {}),
    };
  }
  return states;
}

function registerMessage() {
  const target = targets.current();
  const state = browserState.snapshot(target, attachedTabId, userBoundOrigin, contextTargetStates());
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

function scheduleStableConnectionReset(nextPort: chrome.runtime.Port) {
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

async function cdp(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  if (!ALLOWED_CDP_COMMANDS.has(method)) {
    throw new ExtensionError('cdp_command_blocked', `CDP command is not allowlisted: ${method}`);
  }
  return await chrome.debugger.sendCommand({ tabId }, method, params) as Record<string, any>;
}

async function attach(tabId: number) {
  if (attachedTabId === tabId) return;
  const nextContextId = browserContextForTab(tabId) ?? activeBrowserContextId;
  if (attachedTabId !== null) await detach();
  activateBrowserContext(nextContextId);
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    attachedTabId = tabId;
    // Enable lifecycle sources before the URL is dispatched. Attaching only
    // after tabs.update/create misses the exact navigation events the Runtime
    // needs to decide whether browser_open can return readable content.
    await cdp(tabId, 'Page.enable');
    await cdp(tabId, 'Network.enable');
    publishBrowserStateChange();
    port?.postMessage({
      type: 'browser.event',
      protocolVersion: PROTOCOL_VERSION,
      connectionId,
      event: 'debugger.attached',
      contextId: activeBrowserContextId,
      tabId,
    });
  } catch (error) {
    if (attachedTabId === tabId) {
      attachedTabId = null;
      await chrome.debugger.detach({ tabId }).catch(() => {});
      publishBrowserStateChange();
    }
    throw new ExtensionError(
      'debugger_attach_failed',
      `Chrome debugger permission was not granted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function activateTarget(tabId: number) {
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

async function detach(expectedContextId?: string) {
  if (attachedTabId === null) return { detached: false };
  const tabId = attachedTabId;
  const contextId = browserContextForTab(tabId);
  if (expectedContextId && contextId && contextId !== expectedContextId) {
    return { detached: false };
  }
  if (contextId) activateBrowserContext(contextId);
  attachedTabId = null;
  await chrome.debugger.detach({ tabId }).catch(() => {});
  publishBrowserStateChange();
  port?.postMessage({
    type: 'browser.event',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    event: 'debugger.detached',
    contextId: activeBrowserContextId,
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

/**
 * The tab browser_open navigates. Tabs the session already holds (a tab the
 * user handed over, earlier popups) stay in its fallback chain rather than
 * being dropped: they remain in the session's tab group, and the group is
 * what the session holds (#867).
 */
async function prepareNavigationTarget() {
  const existing = targets.current();
  let existingTab = null;
  if (existing) {
    try {
      existingTab = await chrome.tabs.get(existing.tabId);
    } catch {
      targets.remove(existing.tabId);
    }
  }
  if (
    selectNavigationTarget(existing) === 'reuse_agent_tab'
    && isWebTab(existingTab)
  ) {
    await saveTarget({ tabId: existing.tabId, binding: 'agent' });
    return targets.current();
  }

  if (existing?.binding === 'agent' && existingTab) {
    targets.remove(existing.tabId);
    await chrome.tabs.remove(existing.tabId).catch(() => {});
  }

  // A tab explicitly bound by the user remains their page. browser_open gets a
  // separate agent-owned tab instead of navigating the user's bound tab away.
  // The tab starts on about:blank because the debugger is attached before the
  // URL is dispatched, and Chrome refuses to attach to its New Tab page
  // (chrome://newtab). The navigation lifecycle ignores the about:blank commit.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (!Number.isInteger(tab.id)) {
    throw new ExtensionError('target_create_failed', 'Chrome did not return a tab id');
  }
  await saveTarget({ tabId: tab.id, binding: 'agent' }, { rememberCurrent: true });
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
    await joinContextGroup(tabId);
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

async function persistContextGroups() {
  await chrome.storage.local.set({
    [CONTEXT_GROUPS_KEY]: { sequence: groupSequence, groups: Object.fromEntries(groupsByContext) },
  });
}

/** Groups outlive the service worker; ids of groups Chrome no longer has are dropped. */
async function restoreContextGroups() {
  const stored = parsePersistedContextGroups(
    (await chrome.storage.local.get(CONTEXT_GROUPS_KEY))[CONTEXT_GROUPS_KEY],
  );
  groupSequence = stored.sequence;
  for (const [contextId, group] of Object.entries(stored.groups)) {
    try {
      await chrome.tabGroups.get(group.groupId);
      groupsByContext.set(contextId, group);
    } catch {
      // Closed groups, or ids from an earlier browser session, are gone.
    }
  }
  await persistContextGroups();
}

/**
 * Put a tab the active context holds into that context's group, creating the
 * group on first use. Grouping is presentation and the hand-off channel, not
 * what makes the tab the context's: a tab Chrome refuses to group (one in a
 * popup window) stays usable. A new group is titled once, after the site of
 * the page the session first opens (`url`); later pages leave it as it is.
 */
async function joinContextGroup(tabId, url?: string) {
  const contextId = activeBrowserContextId;
  if (contextId === LEGACY_BROWSER_CONTEXT_ID) return;
  try {
    const existing = groupsByContext.get(contextId);
    if (existing) {
      try {
        await chrome.tabs.group({ groupId: existing.groupId, tabIds: tabId });
        return;
      } catch {
        groupsByContext.delete(contextId);
      }
    }
    const groupId = await chrome.tabs.group({ tabIds: tabId });
    groupSequence += 1;
    await chrome.tabGroups.update(groupId, {
      title: contextGroupTitle(url),
      color: contextGroupColor(groupSequence),
    });
    groupsByContext.set(contextId, { groupId });
    await persistContextGroups();
  } catch (error) {
    console.warn(
      '[pinpawo-extension] tab was not grouped:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * A tab left the context that held it: forget it there, and if it was the
 * current tab fall back to the previous one without focusing it — the user is
 * working in the tab they just moved.
 */
async function releaseTarget(tabId) {
  const removed = targets.remove(tabId);
  grantsByTab.delete(tabId);
  if (attachedTabId === tabId) await detach();
  await saveTarget(removed.current);
}

async function handleGroupMembership(tabId, groupId) {
  const holder = browserContextForTab(tabId);
  const joined = groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
    ? null
    : contextForGroup(groupsByContext, groupId);
  if (holder === joined) return;
  if (holder && holder !== LEGACY_BROWSER_CONTEXT_ID) {
    activateBrowserContext(holder);
    await releaseTarget(tabId);
  }
  if (!joined) return;
  let origin = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    origin = isWebTab(tab) ? originOf(tab.url ?? tab.pendingUrl) : null;
  } catch {
    return;
  }
  // Only an http(s) page can be approved; anything else stays in the group
  // without becoming the session's tab.
  if (!origin) return;
  activateBrowserContext(joined);
  // The user's hand-off becomes the session's current tab (#867); the tab it
  // replaces stays reachable as the fallback.
  await saveTarget({ tabId, binding: 'user' }, { rememberCurrent: true, userBoundOrigin: origin });
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
    contextId: activeBrowserContextId,
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

const SNAPSHOT_OBJECT_GROUP = 'pinpawo-snapshot';

/**
 * Backend ids of the page's sensitive inputs, or null when they cannot be
 * determined (page scripts unavailable, or a node could not be mapped); the
 * tree then withholds every field value.
 */
async function sensitiveInputNodeIds(tabId) {
  try {
    const evaluation = await cdp(tabId, 'Runtime.evaluate', {
      expression: buildSensitiveInputsExpression(),
      returnByValue: false,
      objectGroup: SNAPSHOT_OBJECT_GROUP,
    });
    const arrayId = evaluation.result?.objectId;
    if (evaluation.exceptionDetails || typeof arrayId !== 'string') return null;
    const { result: properties = [] } = await cdp(tabId, 'Runtime.getProperties', {
      objectId: arrayId,
      ownProperties: true,
    });
    const ids = new Set<number>();
    for (const property of properties) {
      if (!/^\d+$/.test(property?.name) || typeof property.value?.objectId !== 'string') continue;
      const { node } = await cdp(tabId, 'DOM.describeNode', { objectId: property.value.objectId });
      if (!Number.isInteger(node?.backendNodeId)) return null;
      ids.add(node.backendNodeId);
    }
    return ids;
  } catch {
    return null;
  } finally {
    await cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: SNAPSHOT_OBJECT_GROUP })
      .catch(() => {});
  }
}

const MAX_SNAPSHOT_DEPTH = 50;

/** `browser_snapshot` options (#873 3b); interactions always take a full snapshot. */
function readSnapshotOptions(params) {
  const { target, depth, interactiveOnly } = params ?? {};
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > MAX_SNAPSHOT_DEPTH)) {
    throw new ExtensionError('invalid_snapshot_options', `depth must be an integer from 1 to ${MAX_SNAPSHOT_DEPTH}`);
  }
  if (interactiveOnly !== undefined && typeof interactiveOnly !== 'boolean') {
    throw new ExtensionError('invalid_snapshot_options', 'interactiveOnly must be a boolean');
  }
  return {
    target: target === undefined ? undefined : normalizeElementTarget(target),
    maxDepth: depth,
    interactiveOnly: interactiveOnly === true,
  };
}

/** The backend node a snapshot scope target names in the current document. */
async function snapshotTargetNodeId(tabId, target, loaderId) {
  if ('ref' in target && isAccessibilityRef(target.ref)) {
    const ref = parseAccessibilityRef(target.ref);
    if (!ref || ref.loaderKey !== accessibilityLoaderKey(loaderId)) {
      throw staleAccessibilityRef('it was read from another tab or an earlier page load');
    }
    return ref.backendNodeId;
  }
  try {
    const evaluation = await cdp(tabId, 'Runtime.evaluate', {
      expression: buildTargetElementExpression(target),
      returnByValue: false,
      objectGroup: SNAPSHOT_OBJECT_GROUP,
    });
    const result = evaluation.result;
    if (evaluation.exceptionDetails || !result) {
      throw new ExtensionError('runtime_evaluation_failed', 'Could not resolve the snapshot target', true);
    }
    if (result.type === 'string') {
      const code = String(result.value);
      throw new ExtensionError(
        code,
        code === 'stale_element_reference'
          ? 'The element reference is stale; take a new snapshot'
          : code === 'invalid_selector' ? 'The CSS selector is invalid' : 'No element matched the selector',
        code === 'element_not_found',
      );
    }
    const { node } = await cdp(tabId, 'DOM.describeNode', { objectId: result.objectId });
    if (!Number.isInteger(node?.backendNodeId)) {
      throw new ExtensionError('element_not_found', 'The snapshot target has no page node');
    }
    return node.backendNodeId;
  } finally {
    await cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: SNAPSHOT_OBJECT_GROUP })
      .catch(() => {});
  }
}

async function readAccessibilitySnapshot(tabId, url, options = readSnapshotOptions({})) {
  // Read the loader before the tree: if a navigation lands in between, the
  // refs name the older document and are refused as stale, rather than
  // labelling the new document's nodes with the old loader.
  const loaderId = await mainFrameLoaderId(tabId);
  const rootBackendNodeId = options.target
    ? await snapshotTargetNodeId(tabId, options.target, loaderId)
    : undefined;
  const tree = await cdp(tabId, 'Accessibility.getFullAXTree');
  // Read the sensitive inputs after the tree, so every input the tree holds
  // already exists in the page when they are looked up.
  const sensitiveNodeIds = await sensitiveInputNodeIds(tabId);
  try {
    return buildAccessibilityTreeSnapshot(tree.nodes || [], url, {
      loaderId,
      sensitiveNodeIds,
      ...(rootBackendNodeId !== undefined ? { rootBackendNodeId } : {}),
      ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      interactiveOnly: options.interactiveOnly,
    });
  } catch (error) {
    if (error instanceof AccessibilityScopeNotFoundError) {
      throw new ExtensionError(
        'element_not_found',
        'The snapshot target is not in the accessibility tree (it may be hidden or decorative)',
      );
    }
    throw error;
  }
}

async function readDomSnapshot(tabId) {
  const evaluation = await cdp(tabId, 'Runtime.evaluate', {
    expression: buildSnapshotExpression(),
    returnByValue: true,
    awaitPromise: true,
  });
  if (evaluation.exceptionDetails || !evaluation.result?.value) {
    throw new Error(evaluation.exceptionDetails?.text || 'Runtime.evaluate returned no value');
  }
  return buildDomTreeSnapshot(evaluation.result.value);
}

/**
 * Chrome's accessibility tree is the snapshot (#873); the page-side DOM
 * snapshot, in the same shape, covers a tree Chrome cannot provide.
 */
async function readSnapshot(tabId, approvedOrigin, params = {}) {
  const options = readSnapshotOptions(params);
  const url = await assertApprovedOrigin(tabId, approvedOrigin);
  let snapshot;
  try {
    snapshot = await readAccessibilitySnapshot(tabId, url, options);
  } catch (accessibilityError) {
    // A scoped, depth-limited or interactive-only request has no DOM
    // equivalent; report the failure rather than a different snapshot.
    const scoped = options.target !== undefined || options.maxDepth !== undefined || options.interactiveOnly;
    if (scoped) throw accessibilityError;
    try {
      snapshot = await readDomSnapshot(tabId);
    } catch (runtimeError) {
      throw new ExtensionError(
        'snapshot_unavailable',
        `Accessibility and runtime snapshot failed: ${accessibilityError}; ${runtimeError}`,
        true,
      );
    }
  }
  validateSnapshotOrigin(snapshot, approvedOrigin, tabId);
  await assertApprovedOrigin(tabId, approvedOrigin);
  // Echoes what was applied, so a Host can tell this build from one that
  // ignores snapshot options.
  return {
    ...snapshot,
    applied: {
      target: options.target !== undefined,
      depth: options.maxDepth ?? null,
      interactiveOnly: options.interactiveOnly,
    },
  };
}

/** Post a unified `browser.event` to the native host (no-op when disconnected). */
function postBrowserEvent(message) {
  const contextId = browserContextForTab(message.tabId);
  if (!port || !contextId) return;
  port.postMessage({
    type: 'browser.event',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    contextId,
    tabId: message.tabId,
    url: message.url,
    event: message.event,
    payload: message.payload,
  });
}

/**
 * Live readiness event emission (block 1 of issue #601). Translates reliable,
 * stateless CDP `Page`/`tabs` facts into the unified live readiness stream the
 * Runtime consumes. The pure translation lives in `liveReadiness.ts`; these
 * helpers own the `port.postMessage`.
 *
 * Stateful live facts (network inflight deltas via `Network.*`, repeated DOM
 * text samples during hydration) are wired via CDP `Network.*` / `Page.loadEventFired`
 * events and per-tab counters. The pure translators live in `liveReadiness.ts`.
 */
function emitLiveCommitted(tabId, url) {
  const event = navigationCommittedEvent({ url, timestamp: Date.now() }, tabId);
  postBrowserEvent({ ...event, tabId, url });
}

function emitLiveDocumentReady(tabId, url, readyState) {
  const event = documentReadyEvent({ readyState, timestamp: Date.now() }, tabId, url);
  postBrowserEvent({ ...event, tabId, url });
}


async function emitLiveDomSample(tabId: number, url: string) {
  if (!port || attachedTabId !== tabId || !browserContextForTab(tabId)) return;
  try {
    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression: '(document.body?.innerText || "").length',
      returnByValue: true,
    });
    const textLength = typeof result?.result?.value === 'number'
      ? Math.max(0, result.result.value)
      : 0;
    const state = liveReadinessState(tabId);
    if (textLength > state.lastDomTextLength || state.lastDomTextRevision === 0) {
      state.lastDomTextRevision += 1;
      state.lastDomTextLength = textLength;
      const event = domChangedEvent(
        { textLength, textRevision: state.lastDomTextRevision, timestamp: Date.now() },
        tabId,
        url,
      );
      postBrowserEvent({ ...event, tabId, url });
    }
  } catch {
    // DOM sampling is best-effort.
  }
}

/**
 * Report the current inflight count. `networkActivityEvent` applies its own
 * +1/-1 delta for the reported fact, so the base must be the count *before*
 * that fact is applied — otherwise a finished request would be double-counted
 * and the tally could never return to zero, keeping the page from settling.
 */
function emitLiveNetworkActivity(tabId: number, kind: 'request' | 'finish' | 'fail') {
  if (!port || attachedTabId !== tabId || !browserContextForTab(tabId)) return;
  const inflightRequests = networkRequestSet(tabId).size;
  const baseInflight = kind === 'request'
    ? Math.max(0, inflightRequests - 1)
    : inflightRequests + 1;
  postBrowserEvent({
    ...networkActivityEvent(
      { kind, timestamp: Date.now() },
      tabId,
      baseInflight,
    ),
    tabId,
  });
}

function resetLiveCounters(tabId: number) {
  networkRequestsByTab.delete(tabId);
  liveReadinessByTab.delete(tabId);
}

/**
 * Best-effort URL for the tab the live readiness events are reported against.
 *
 * Several CDP events the Runtime cares about carry no URL of their own
 * (`Page.loadEventFired` only has a `timestamp`), and the managed target may not
 * have recorded one yet. Falling back to `chrome.tabs.get` keeps the live
 * `dom.changed` / `document.ready` stream flowing: those events are dropped
 * downstream when their URL is empty, which would leave the Runtime waiting for
 * a body sample that never arrives.
 */
async function liveTabUrl(tabId: number): Promise<string> {
  const contextId = browserContextForTab(tabId);
  const target = contextId ? browserTargetContext(contextId).targets.current() : null;
  const known = target?.tabId === tabId ? (target as { url?: string }).url : undefined;
  if (typeof known === 'string' && known) return known;
  try {
    const tab = await chrome.tabs.get(tabId);
    return typeof tab?.url === 'string' ? tab.url : '';
  } catch {
    return '';
  }
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

/** The main-frame document load, or null when it cannot be read. */
async function mainFrameLoaderId(tabId) {
  try {
    const { frameTree } = await cdp(tabId, 'Page.getFrameTree');
    return typeof frameTree?.frame?.loaderId === 'string' ? frameTree.frame.loaderId : null;
  } catch {
    return null;
  }
}

function staleAccessibilityRef(reason) {
  return new ExtensionError(
    'stale_element_reference',
    `The element reference is stale: ${reason}; take a new snapshot`,
  );
}

async function resolveAccessibilityTarget(tabId, value) {
  const ref = parseAccessibilityRef(value);
  if (!ref || ref.loaderKey !== accessibilityLoaderKey(await mainFrameLoaderId(tabId))) {
    throw staleAccessibilityRef('it was read from another tab or an earlier page load');
  }
  let model;
  try {
    await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: ref.backendNodeId });
    model = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: ref.backendNodeId });
  } catch (error) {
    if (/No node with given id/i.test(error instanceof Error ? error.message : String(error))) {
      throw staleAccessibilityRef('the element is no longer in the page');
    }
    throw error;
  }
  const quad = model.model?.border;
  if (!Array.isArray(quad) || quad.length !== 8) {
    throw new ExtensionError('element_not_visible', 'The accessibility element has no visible box');
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    ok: true,
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    box: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    tag: ref.role,
    editable: ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(ref.role),
  };
}

async function resolveTarget(tabId, target) {
  const normalized = normalizeElementTarget(target);
  if ('ref' in normalized && isAccessibilityRef(normalized.ref)) {
    return await resolveAccessibilityTarget(tabId, normalized.ref);
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
      const retryableSelectorState = 'selector' in normalized && normalized.selector
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

async function dispatchKey(tabId, key, params: Record<string, any> = {}, approvedOrigin) {
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

/** A result must stay under the Native Messaging message limit. */
const MAX_SCREENSHOT_BYTES = 700_000;
/** Taller regions are cut: past this a model cannot read the downscaled image. */
const MAX_SCREENSHOT_CSS_HEIGHT = 8_000;

function screenshotScope(params) {
  const fullPage = params.fullPage === true;
  if (params.fullPage !== undefined && typeof params.fullPage !== 'boolean') {
    throw new ExtensionError('invalid_screenshot_options', 'fullPage must be a boolean');
  }
  if (fullPage && params.target) {
    throw new ExtensionError('invalid_screenshot_options', 'A screenshot takes either a target or fullPage, not both');
  }
  if (params.target) return 'element';
  return fullPage ? 'fullPage' : 'viewport';
}

/** The document-coordinate region for an element or the whole page. */
async function screenshotClip(tabId, scope, params) {
  // Resolving the target scrolls it into view, so metrics are read after it.
  const box = scope === 'element' ? (await resolveTarget(tabId, params.target)).box : null;
  const metrics = await cdp(tabId, 'Page.getLayoutMetrics');
  const content = metrics.cssContentSize;
  const viewport = metrics.cssVisualViewport;
  if (!content || !viewport) {
    throw new ExtensionError('screenshot_unavailable', 'Chrome returned no layout metrics', true);
  }
  let region;
  if (!box) {
    region = { x: 0, y: 0, width: content.width, height: content.height };
  } else {
    // Target boxes are viewport-relative; the clip is in document coordinates.
    region = {
      x: box.x + viewport.pageX,
      y: box.y + viewport.pageY,
      width: box.width,
      height: box.height,
    };
  }
  const x = Math.max(0, region.x);
  const y = Math.max(0, region.y);
  const width = Math.min(region.width - (x - region.x), content.width - x);
  const fullHeight = Math.min(region.height - (y - region.y), content.height - y);
  if (!(width > 0) || !(fullHeight > 0)) {
    throw new ExtensionError('element_not_visible', 'The screenshot region is empty');
  }
  const height = Math.min(fullHeight, MAX_SCREENSHOT_CSS_HEIGHT);
  return {
    clip: { x, y, width, height },
    ...(height < fullHeight ? { truncated: { capturedHeight: height, regionHeight: fullHeight } } : {}),
  };
}

/**
 * Output pixels per CSS pixel to try, largest first. `clip.scale` multiplies
 * the device pixel ratio, so the ladder is expressed in CSS pixels and divided
 * by it: on a 2x display a full page at scale 1 would render twice as wide and
 * tall as its CSS size. An element starts at native sharpness; a full page is
 * a layout overview, so it starts at one output pixel per CSS pixel.
 */
async function screenshotScales(tabId, scope) {
  if (scope === 'viewport') return [1];
  // Page scripts may be unavailable (the accessibility-fallback case); the
  // ladder still ends small enough if the ratio is taken as 1.
  const ratio = await evaluateValue(tabId, 'window.devicePixelRatio').catch(() => 1);
  const devicePixelRatio = typeof ratio === 'number' && ratio > 0 ? ratio : 1;
  const cssScales = scope === 'fullPage' ? [1, 0.5, 0.25] : [devicePixelRatio, 1, 0.5];
  return [...new Set(cssScales.map((cssScale) => cssScale / devicePixelRatio))];
}

async function captureScreenshot(tabId, approvedOrigin, params = {}) {
  const scope = screenshotScope(params);
  await assertApprovedOrigin(tabId, approvedOrigin);
  const region = scope === 'viewport' ? null : await screenshotClip(tabId, scope, params);
  // A large region is scaled down before quality drops too far to read.
  for (const scale of await screenshotScales(tabId, scope)) {
    for (const quality of [75, 55, 35]) {
      const result = await cdp(tabId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality,
        fromSurface: true,
        optimizeForSpeed: true,
        ...(region
          ? { clip: { ...region.clip, scale }, captureBeyondViewport: true }
          : { captureBeyondViewport: false }),
      });
      if (typeof result.data !== 'string') {
        throw new ExtensionError('screenshot_unavailable', 'Chrome returned no screenshot data', true);
      }
      const estimatedBytes = Math.floor(result.data.length * 3 / 4);
      if (estimatedBytes <= MAX_SCREENSHOT_BYTES) {
        await assertApprovedOrigin(tabId, approvedOrigin);
        return {
          mimeType: 'image/jpeg',
          data: result.data,
          scope,
          ...(region?.truncated ? { truncated: region.truncated } : {}),
        };
      }
    }
  }
  throw new ExtensionError(
    'screenshot_too_large',
    `The ${scope} screenshot exceeds the Native Messaging safety limit`,
    true,
  );
}

async function executeCommand(command) {
  activateBrowserContext(readBrowserContextId(command.params.browserContextId));
  activeCommandRequestId = command.requestId;
  try {
    return await executeCommandBody(command);
  } finally {
    activeCommandRequestId = null;
  }
}

async function executeCommandBody(command) {
  ensureCommandAlive(command.deadlineAt);
  if (command.command === 'detach') return await detach(activeBrowserContextId);

  const approvedOrigin = command.params.approvedOrigin;
  if (command.command === 'navigate') {
    const url = command.params.url;
    if (typeof url !== 'string' || originOf(url) !== approvedOrigin) {
      throw new ExtensionError('origin_approval_mismatch', 'Navigation URL does not match its approved origin');
    }
    const activeTarget = await prepareNavigationTarget();
    if (!activeTarget) {
      throw new ExtensionError('target_create_failed', 'Chrome did not provide a navigation target');
    }
    await joinContextGroup(activeTarget.tabId, url);
    await activateTarget(activeTarget.tabId);
    await attach(activeTarget.tabId);
    emitLifecycleEvent('navigation.requested', activeTarget.tabId, { url });
    await chrome.tabs.update(activeTarget.tabId, { url, active: true });
    // Issue #601: fire-and-forget — the Runtime owns the readiness wait.
    // Live events (Page.frameNavigated → navigation.committed,
    // tabs.onUpdated complete → document.ready, periodic DOM samples)
    // drive the BrowserLifecycleController via the bridge. The Runtime's
    // waitForReadiness will resolve when the page reaches readable.
    return { ok: true, tabId: activeTarget.tabId, url };
  }

  const activeTarget = await ensureTarget();
  await attach(activeTarget.tabId);
  if (command.command === 'snapshot') {
    return await readSnapshot(activeTarget.tabId, approvedOrigin, command.params);
  }
  if (command.command === 'extract') {
    return await readExtract(activeTarget.tabId, command.params, approvedOrigin);
  }
  if (command.command === 'screenshot') {
    return await captureScreenshot(activeTarget.tabId, approvedOrigin, command.params);
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

// A tab is handed to an Agent session by dragging it into that session's
// PinPawo group, and taken back by dragging it out (#867). Group changes the
// extension makes itself land on a tab the session already holds, so they
// are no-ops here.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId === undefined) return;
  void enqueueExtensionWork(() => handleGroupMembership(tabId, changeInfo.groupId))
    .catch((error) => {
      console.warn(
        '[pinpawo-extension] tab group change was not applied:',
        error instanceof Error ? error.message : String(error),
      );
    });
});

chrome.tabGroups.onRemoved.addListener((group) => {
  void enqueueExtensionWork(async () => {
    const contextId = contextForGroup(groupsByContext, group.id);
    if (!contextId) return;
    groupsByContext.delete(contextId);
    await persistContextGroups();
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
    grantsByTab.delete(tabId);
    const contextId = browserContextForTab(tabId);
    if (!contextId) return;
    activateBrowserContext(contextId);
    resetLiveCounters(tabId);
    recentPopupByOpener.delete(tabId);
    await handleRemovedTarget(tabId);
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== attachedTabId) return;
  const contextId = browserContextForTab(source.tabId);
  if (contextId) activateBrowserContext(contextId);
  attachedTabId = null;
  resetLiveCounters(source.tabId);
  publishBrowserStateChange();
  port?.postMessage({
    type: 'browser.event',
    protocolVersion: PROTOCOL_VERSION,
    connectionId,
    event: 'debugger.detached',
    contextId: activeBrowserContextId,
    tabId: source.tabId,
    reason,
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!Number.isInteger(source.tabId)) return;
  const tabId = source.tabId;
  if (tabId !== attachedTabId || !browserContextForTab(tabId)) return;
  const eventParams = params as Record<string, unknown>;

  if (method === 'Page.frameNavigated') {
    const frame = eventParams.frame as Record<string, unknown> | undefined;
    // Iframe commits must not replace the main page's origin/readiness state.
    if (!frame || typeof frame.url !== 'string' || frame.parentId !== undefined) return;
    resetLiveCounters(tabId);
    emitLiveCommitted(tabId, frame.url);
    return;
  }
  if (method === 'Page.domContentEventFired') {
    void liveTabUrl(tabId).then((url) => {
      if (url) emitLiveDocumentReady(tabId, url, 'interactive');
    });
    return;
  }
  if (method === 'Page.loadEventFired') {
    void (async () => {
      const url = await liveTabUrl(tabId);
      if (!url) return;
      emitLiveDocumentReady(tabId, url, 'complete');
      await emitLiveDomSample(tabId, url);
    })();
    return;
  }
  if (method === 'Network.requestWillBeSent' && typeof eventParams.requestId === 'string') {
    const requests = networkRequestSet(tabId);
    if (!requests.has(eventParams.requestId)) {
      requests.add(eventParams.requestId);
      emitLiveNetworkActivity(tabId, 'request');
    }
    return;
  }
  if (
    (method === 'Network.loadingFinished' || method === 'Network.loadingFailed')
    && typeof eventParams.requestId === 'string'
  ) {
    const requests = networkRequestSet(tabId);
    if (requests.delete(eventParams.requestId)) {
      emitLiveNetworkActivity(
        tabId,
        method === 'Network.loadingFinished' ? 'finish' : 'fail',
      );
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== attachedTabId || !browserContextForTab(tabId)) return;
  if (changeInfo.status !== 'complete') return;
  // `Page.loadEventFired` has no URL; Chrome tab state provides a reliable
  // fallback for the final ready/body sample when it arrives first.
  void (async () => {
    const url = await liveTabUrl(tabId);
    if (!url) return;
    emitLiveDocumentReady(tabId, url, 'complete');
    await emitLiveDomSample(tabId, url);
  })();
});

async function initialize() {
  await restoreTarget();
  await restoreContextGroups();
  connectNativeHost();
}

void initialize().catch((error) => {
  console.error(
    '[pinpawo-extension] initialization failed:',
    error instanceof Error ? error.message : String(error),
  );
  connectNativeHost();
});
