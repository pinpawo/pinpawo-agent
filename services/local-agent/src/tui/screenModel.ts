import { buildBusyStatusLine } from './render/eventText';
import { TUI_TEXT } from './render/text';
import {
  selectFocusedActiveOperations,
  selectFocusedActivities,
  selectFocusedBusy,
  selectFocusedNotices,
  selectFocusedPendingApproval,
  selectFocusedPendingUi,
  selectFocusedSession,
  selectFocusedTimeline,
  selectReady,
} from './state/tuiStateReducer';
import type {
  ApprovalRequestModel,
  TuiConnectionState,
  SessionModel,
  TuiState,
} from './state/tuiState';
import {
  buildTimelineViewportModel,
  type AgentTimelineDisplayEntry,
} from './timeline/agentTimelineSelectors';
import type { ActiveOperation } from './types';

const SPINNER_FRAMES = ['-', '\\', '|', '/'];

export type TuiScreenModel = {
  session: SessionModel | null;
  petName: string;
  ready: boolean;
  busy: boolean;
  pendingApproval: ApprovalRequestModel | null;
  activeOperations: ActiveOperation[];
  regions: {
    timeline: {
      entries: AgentTimelineDisplayEntry[];
      staticEntries: AgentTimelineDisplayEntry[];
      dynamicEntries: AgentTimelineDisplayEntry[];
      renderKey: string;
      staticBoundaryKey: string;
      scrollStrategy: 'preserveStaticOutputUntilHostReset';
      width: number;
      emptyText: string;
    };
    overlay: {
      width: number;
    };
    composer: {
      focused: boolean;
      busy: boolean;
      width: number;
      textAreaWidth: number;
      borderColor: 'yellow' | 'gray';
      marginTop: number;
    };
    statusBar: {
      activityStatus: string | null;
      connectionStatus: string;
      width: number;
    };
  };
};

export function buildTuiScreenModel(input: {
  state: TuiState;
  terminalColumns: number;
  now: number;
  animationFrame: number;
  timelineRenderEpoch: number;
}): TuiScreenModel {
  const session = selectFocusedSession(input.state);
  const timeline = selectFocusedTimeline(input.state);
  const notices = selectFocusedNotices(input.state);
  const activities = selectFocusedActivities(input.state);
  const ready = selectReady(input.state);
  const busy = selectFocusedBusy(input.state);
  const pendingUi = selectFocusedPendingUi(input.state);
  const activeOperations = selectFocusedActiveOperations(input.state);
  const pendingApproval = selectFocusedPendingApproval(input.state);
  const contentWidth = Math.max(20, input.terminalColumns - 4);
  const textAreaWidth = Math.max(8, contentWidth - 4);
  const timelineViewport = buildTimelineViewportModel(timeline, notices, activities);
  const petName = session?.actor.label ?? TUI_TEXT.defaultPetName;
  const spinnerFrame = SPINNER_FRAMES[input.animationFrame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
  const activityStatus = pendingUi
    ? buildBusyStatusLine(pendingUi, input.now, spinnerFrame, activeOperations)
    : pendingApproval
      ? TUI_TEXT.approvalWaiting(pendingApproval.petId)
      : null;
  const connectionStatus = formatConnectionStatus(input.state.connection, Boolean(activityStatus));
  const composerFocused = ready && !busy;

  return {
    session,
    petName,
    ready,
    busy,
    pendingApproval,
    activeOperations,
    regions: {
      timeline: {
        entries: timelineViewport.entries,
        staticEntries: timelineViewport.staticEntries,
        dynamicEntries: timelineViewport.dynamicEntries,
        renderKey: formatViewportRenderKey(input.timelineRenderEpoch),
        staticBoundaryKey: formatViewportBoundaryKey(timelineViewport.staticEntries),
        scrollStrategy: 'preserveStaticOutputUntilHostReset',
        width: contentWidth,
        emptyText: TUI_TEXT.emptyHistory(petName),
      },
      overlay: {
        width: contentWidth,
      },
      composer: {
        focused: composerFocused,
        busy,
        width: contentWidth,
        textAreaWidth,
        borderColor: busy || pendingApproval ? 'yellow' : 'gray',
        marginTop: pendingApproval ? 0 : 1,
      },
      statusBar: {
        activityStatus,
        connectionStatus,
        width: contentWidth,
      },
    },
  };
}

function formatConnectionStatus(connection: TuiConnectionState, hasActivityStatus: boolean) {
  const message = connection.message.trim();
  if (connection.status === 'ready') {
    return !hasActivityStatus && message && message !== TUI_TEXT.statusReady
      ? message
      : TUI_TEXT.statusReady;
  }
  if (message) return message;
  if (connection.status === 'initializing') return TUI_TEXT.statusInitializing;
  if (connection.status === 'connecting') return TUI_TEXT.connectionConnecting;
  if (connection.status === 'disconnected') return TUI_TEXT.connectionDisconnected;
  return TUI_TEXT.statusErrorRecovered;
}

function formatViewportRenderKey(epoch: number) {
  return String(epoch);
}

function formatViewportBoundaryKey(entries: AgentTimelineDisplayEntry[]) {
  return entries.map((entry) => entry.id).join('\u001F');
}
