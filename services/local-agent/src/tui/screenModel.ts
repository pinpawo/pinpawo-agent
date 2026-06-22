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
      renderEpoch: number;
      width: number;
      emptyText: string;
    };
    overlay: {
      pendingApproval: ApprovalRequestModel | null;
      activityStatus: string;
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
      status: string;
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
    : input.state.connection.message;
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
        renderEpoch: input.timelineRenderEpoch,
        width: contentWidth,
        emptyText: TUI_TEXT.emptyHistory(petName),
      },
      overlay: {
        pendingApproval,
        activityStatus,
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
        status: activityStatus,
        width: contentWidth,
      },
    },
  };
}
