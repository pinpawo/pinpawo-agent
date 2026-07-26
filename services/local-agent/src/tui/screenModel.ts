import { buildBusyStatusLine } from './render/eventText';
import { TUI_TEXT } from './render/text';
import {
  selectFocusedActiveOperations,
  selectFocusedBusy,
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
import type { AgentTimelineEntry } from '@pinpawo/agent-session';
import type { ActiveOperation } from './types';
import { buildWelcomePanelModel, type WelcomePanelModel } from './welcomePanelModel';

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
      entries: AgentTimelineEntry[];
      renderKey: string;
      width: number;
      emptyState: WelcomePanelModel | null;
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
      statusNotice: string | null;
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
  const ready = selectReady(input.state);
  const busy = selectFocusedBusy(input.state);
  const pendingUi = selectFocusedPendingUi(input.state);
  const activeOperations = selectFocusedActiveOperations(input.state);
  const pendingApproval = selectFocusedPendingApproval(input.state);
  const contentWidth = Math.max(20, input.terminalColumns - 4);
  const textAreaWidth = Math.max(8, contentWidth - 4);
  const petName = session?.actor.label ?? TUI_TEXT.defaultPetName;
  const spinnerFrame = SPINNER_FRAMES[input.animationFrame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
  const activityStatus = pendingUi
    ? buildBusyStatusLine(pendingUi, input.now, spinnerFrame, activeOperations)
    : pendingApproval
      ? TUI_TEXT.approvalWaiting(pendingApproval.petId)
      : null;
  const connectionStatus = formatConnectionStatus(input.state.connection);
  const composerFocused = ready && !busy;
  const timelineEmptyState = timeline.length === 0
    ? buildWelcomePanelModel({
        session,
        width: contentWidth,
        ready,
        connectionStatus,
      })
    : null;

  return {
    session,
    petName,
    ready,
    busy,
    pendingApproval,
    activeOperations,
    regions: {
      timeline: {
        entries: timeline,
        renderKey: formatViewportRenderKey(input.timelineRenderEpoch),
        width: contentWidth,
        emptyState: timelineEmptyState,
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
        statusNotice: activityStatus ? null : input.state.statusNotice,
        connectionStatus,
        width: contentWidth,
      },
    },
  };
}

function formatConnectionStatus(connection: TuiConnectionState) {
  const detail = connection.detail?.trim();
  if (detail) return detail;
  if (connection.status === 'ready') return TUI_TEXT.statusReady;
  if (connection.status === 'initializing') return TUI_TEXT.statusInitializing;
  if (connection.status === 'connecting') return TUI_TEXT.connectionConnecting;
  if (connection.status === 'disconnected') return TUI_TEXT.connectionDisconnected;
  return TUI_TEXT.statusErrorRecovered;
}

function formatViewportRenderKey(epoch: number) {
  return String(epoch);
}
