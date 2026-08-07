import type {
  AgentReviewAction,
  AgentRunView,
  ReviewResponse,
  ReviewSpec,
} from '@pinpawo/agent-session';
import { reviewDecisionsRemainValid } from '../session/reviewDecision';
import { truncateTerminalLine } from '../text/terminalText';
import {
  buildReviewContentLines as renderReviewContentLines,
  type ReviewContentLine,
} from './reviewContentLines';

export type ApprovalPhase = 'ready' | 'resolution-sent' | 'error';

export type ApprovalState =
  | { phase: 'closed' }
  | {
      phase: ApprovalPhase;
      requestId: string;
      action: AgentReviewAction;
      reviewIndex: number;
      decisions: ReviewResponse[];
      selectedIndex: number;
      contentOffset: number;
      draft: string;
      interruptSent: boolean;
      submissionFrame: number;
      message?: string;
    };

export type ApprovalAction =
  | 'cancel'
  | 'submit'
  | 'previous-option'
  | 'next-option'
  | 'page-up'
  | 'page-down'
  | null;

export type ApprovalKey = {
  name: string;
  ctrl: boolean;
  shift: boolean;
};

export type ApprovalViewModel = {
  title: string;
  bottomTitle: string;
  body: string;
  /** Tone-tagged form of `body`, one entry per rendered row. */
  bodyLines: ReviewContentLine[];
  options: string;
  inputVisible: boolean;
  inputPlaceholder: string;
  bodyRows: number;
  optionRows: number;
  loadingFrame: number | null;
};

const MAX_REVIEW_CONTENT_CHARACTERS = 100_000;
const MAX_REVIEW_CONTENT_LINES = 500;
export const APPROVAL_FOOTER_ROWS = 18;
const APPROVAL_DIALOG_MAX_WIDTH = 112;
const APPROVAL_DIALOG_MAX_ROWS = 16;
const APPROVAL_CONTENT_ROWS = 13;
const APPROVAL_TEXT_INPUT_OPTION_ROWS = 2;
const APPROVAL_LONG_CONTENT_OPTION_ROWS = 2;

export type ApprovalDialogLayout = {
  width: number;
  height: number;
  left: number;
  top: number;
};

/**
 * Keep the review interaction visibly separate from the composer while
 * retaining split-footer scrollback above it. The dialog is centered within
 * the temporarily expanded footer rather than pretending to be a transcript
 * entry.
 */
export function calculateApprovalDialogLayout(
  availableWidth: number,
  availableHeight: number,
): ApprovalDialogLayout {
  const width = Math.max(1, Math.floor(availableWidth));
  const height = Math.max(1, Math.floor(availableHeight));
  const horizontalInset = width >= 72 ? 6 : width >= 48 ? 4 : 1;
  const dialogWidth = Math.max(
    1,
    Math.min(APPROVAL_DIALOG_MAX_WIDTH, width - horizontalInset * 2),
  );
  const dialogHeight = Math.max(
    1,
    Math.min(
      APPROVAL_DIALOG_MAX_ROWS,
      height > 4 ? height - 2 : height,
    ),
  );
  return {
    width: dialogWidth,
    height: dialogHeight,
    left: Math.max(0, Math.floor((width - dialogWidth) / 2)),
    top: Math.max(0, Math.floor((height - dialogHeight) / 2)),
  };
}

export function createApprovalState(): ApprovalState {
  return { phase: 'closed' };
}

export function syncApprovalState(
  state: ApprovalState,
  run: AgentRunView | null,
): ApprovalState {
  if (!run || run.state !== 'waiting_review') {
    return state.phase === 'closed' ? state : createApprovalState();
  }
  if (
    state.phase !== 'closed'
    && state.requestId === run.requestId
    && state.action.actionId === run.reviewAction.actionId
    && reviewDecisionsRemainValid(run.reviewAction, state.decisions)
  ) {
    return {
      ...state,
      action: run.reviewAction,
      reviewIndex: state.decisions.length,
      selectedIndex: clampOptionIndex(
        state.selectedIndex,
        currentReviewFrom(run.reviewAction, state.decisions)?.options.length ?? 0,
      ),
    };
  }
  return {
    phase: 'ready',
    requestId: run.requestId,
    action: run.reviewAction,
    reviewIndex: 0,
    decisions: [],
    selectedIndex: defaultOptionIndex(run.reviewAction.reviews[0]),
    contentOffset: 0,
    draft: '',
    interruptSent: false,
    submissionFrame: 0,
  };
}

export function currentApprovalReview(state: ApprovalState) {
  return state.phase === 'closed'
    ? null
    : state.action.reviews[state.reviewIndex] ?? null;
}

export function selectedApprovalOption(state: ApprovalState) {
  const review = currentApprovalReview(state);
  return review?.options[state.phase === 'closed' ? 0 : state.selectedIndex] ?? null;
}

export function approvalAcceptsTextInput(state: ApprovalState) {
  return state.phase !== 'closed'
    && state.phase !== 'resolution-sent'
    && selectedApprovalOption(state)?.input?.kind === 'text';
}

export function moveApprovalSelection(
  state: ApprovalState,
  delta: number,
): ApprovalState {
  if (
    state.phase === 'closed'
    || state.phase === 'resolution-sent'
    || state.draft.trim()
  ) {
    return state;
  }
  const review = currentApprovalReview(state);
  if (!review?.options.length) return state;
  return {
    ...state,
    phase: 'ready',
    message: undefined,
    selectedIndex: clampOptionIndex(
      state.selectedIndex + delta,
      review.options.length,
    ),
  };
}

export function setApprovalDraft(
  state: ApprovalState,
  draft: string,
): ApprovalState {
  if (!approvalAcceptsTextInput(state) || state.phase === 'closed') return state;
  if (state.draft === draft && state.phase === 'ready' && !state.message) {
    return state;
  }
  return {
    ...state,
    phase: 'ready',
    draft,
    message: undefined,
  };
}

export function scrollApprovalContent(
  state: ApprovalState,
  direction: -1 | 1,
  width: number,
  dialogRows = APPROVAL_DIALOG_MAX_ROWS,
): ApprovalState {
  if (state.phase === 'closed' || state.phase === 'resolution-sent') return state;
  const review = currentApprovalReview(state);
  if (!review) return state;
  const lineCount = buildReviewContentLines(
    review,
    Math.max(1, width - 4),
  ).length;
  const bodyRows = approvalLayoutRows(
    state,
    lineCount,
    review.options.length,
    approvalContentRows(dialogRows),
  ).bodyRows;
  const maximum = Math.max(0, lineCount - bodyRows);
  return {
    ...state,
    contentOffset: Math.max(
      0,
      Math.min(maximum, state.contentOffset + direction * bodyRows),
    ),
  };
}

export function advanceApproval(
  state: ApprovalState,
  decisions: ReviewResponse[],
): ApprovalState {
  if (state.phase === 'closed' || decisions.length >= state.action.reviews.length) {
    return state;
  }
  const review = state.action.reviews[decisions.length];
  return {
    ...state,
    phase: 'ready',
    reviewIndex: decisions.length,
    decisions,
    selectedIndex: defaultOptionIndex(review),
    contentOffset: 0,
    draft: '',
    interruptSent: false,
    submissionFrame: 0,
    message: undefined,
  };
}

export function beginApprovalSubmission(
  state: ApprovalState,
): ApprovalState {
  return state.phase === 'closed'
    ? state
    : {
        ...state,
        phase: 'resolution-sent',
        interruptSent: false,
        submissionFrame: 0,
        message: undefined,
      };
}

export function advanceApprovalSubmissionFrame(
  state: ApprovalState,
): ApprovalState {
  return state.phase !== 'resolution-sent'
    ? state
    : {
        ...state,
        submissionFrame: state.submissionFrame + 1,
      };
}

export function updateApprovalResolutionSent(
  state: ApprovalState,
  update: {
    message: string;
    interruptSent?: boolean;
  },
): ApprovalState {
  return state.phase !== 'resolution-sent'
    ? state
    : {
        ...state,
        interruptSent: update.interruptSent ?? state.interruptSent,
        message: update.message,
      };
}

export function failApproval(
  state: ApprovalState,
  message: string,
): ApprovalState {
  return state.phase === 'closed'
    ? state
    : {
        ...state,
        phase: 'error',
        message,
      };
}

export function resolveApprovalKey(
  state: ApprovalState,
  key: ApprovalKey,
): ApprovalAction {
  if (state.phase === 'closed' || (key.ctrl && key.name === 'c')) return null;
  if (state.phase === 'resolution-sent') return null;
  if (key.name === 'escape') return 'cancel';
  if (key.name === 'pageup') return 'page-up';
  if (key.name === 'pagedown') return 'page-down';
  if (
    key.name === 'return'
    && (
      !key.shift
      || selectedApprovalOption(state)?.input?.multiline !== true
    )
  ) {
    return 'submit';
  }
  if (!state.draft.trim() && key.name === 'up') return 'previous-option';
  if (!state.draft.trim() && key.name === 'down') return 'next-option';
  return null;
}

export function buildApprovalViewModel(
  state: Exclude<ApprovalState, { phase: 'closed' }>,
  width: number,
  dialogRows = APPROVAL_DIALOG_MAX_ROWS,
): ApprovalViewModel {
  const innerWidth = Math.max(1, width - 4);
  const review = currentApprovalReview(state);
  const reviewCount = state.action.reviews.length;
  const pet = state.action.petId ? ` · ${state.action.petId}` : '';
  if (state.phase === 'resolution-sent') {
    const message = state.message ?? 'Submitting review decision…';
    const rawTitle = width >= 50
      ? `Review ${state.reviewIndex + 1}/${reviewCount}${pet}`
      : `Review ${state.reviewIndex + 1}/${reviewCount}`;
    return {
      title: ` ${truncateTerminalLine(rawTitle, innerWidth)} `,
      bottomTitle: state.interruptSent
        ? ' Interrupt requested '
        : ' Esc interrupt · Ctrl+C interrupt ',
      body: truncateTerminalLine(message, Math.max(1, innerWidth - 4)),
      bodyLines: [{
        text: truncateTerminalLine(message, Math.max(1, innerWidth - 4)),
        tone: 'default',
      }],
      options: '',
      inputVisible: false,
      inputPlaceholder: '',
      bodyRows: approvalContentRows(dialogRows),
      optionRows: 0,
      loadingFrame: state.submissionFrame,
    };
  }
  const allBodyLines: ReviewContentLine[] = review
    ? buildReviewContentLines(review, innerWidth)
    : [{ text: 'Review is no longer available.', tone: 'muted' }];
  const { bodyRows, optionRows } = approvalLayoutRows(
    state,
    allBodyLines.length,
    review?.options.length ?? 0,
    approvalContentRows(dialogRows),
  );
  const maxOffset = Math.max(0, allBodyLines.length - bodyRows);
  const offset = Math.min(state.contentOffset, maxOffset);
  const bodyLines = allBodyLines.slice(offset, offset + bodyRows);
  if (state.phase === 'error' && state.message) {
    bodyLines[0] = {
      text: truncateTerminalLine(`Error: ${state.message}`, innerWidth),
      tone: 'removed',
    };
  }
  const contentProgress = allBodyLines.length > bodyRows
    ? ` · details ${offset + 1}-${Math.min(offset + bodyRows, allBodyLines.length)}/${allBodyLines.length}`
    : '';
  const compactContentProgress = allBodyLines.length > bodyRows
    ? ` · ${offset + 1}-${Math.min(offset + bodyRows, allBodyLines.length)}/${allBodyLines.length}`
    : '';
  const rawTitle = width >= 50
    ? `Review ${state.reviewIndex + 1}/${reviewCount}${pet}${contentProgress}`
    : `Review ${state.reviewIndex + 1}/${reviewCount}${compactContentProgress}`;
  const title = truncateTerminalLine(
    rawTitle,
    Math.max(1, width - 4),
  );
  return {
    title: ` ${title} `,
    bottomTitle: approvalHelp(width),
    body: bodyLines.map((line) => line.text).join('\n'),
    bodyLines,
    options: formatApprovalOptions(state, innerWidth, optionRows),
    inputVisible: approvalAcceptsTextInput(state),
    inputPlaceholder: selectedApprovalOption(state)?.input?.placeholder
      ?? selectedApprovalOption(state)?.input?.label
      ?? (selectedApprovalOption(state)?.input?.multiline
        ? 'Type a response · Shift+Enter for newline'
        : 'Type a response'),
    bodyRows,
    optionRows,
    loadingFrame: null,
  };
}

function approvalLayoutRows(
  state: ApprovalState,
  bodyLineCount: number,
  optionCount: number,
  contentRows: number,
) {
  if (approvalAcceptsTextInput(state)) {
    const optionRows = contentRows >= 8
      ? APPROVAL_TEXT_INPUT_OPTION_ROWS
      : 1;
    // The response textarea takes fixed rows, but the reviewed content must not
    // collapse below what is left: a multi-line shell command stays readable
    // while the operator types a reply.
    return {
      bodyRows: Math.max(
        1,
        Math.min(
          Math.max(bodyLineCount, 1),
          contentRows - 4 - optionRows,
        ),
      ),
      optionRows,
    };
  }

  const availableBodyLines = Math.max(1, bodyLineCount);
  const availableOptions = Math.max(1, optionCount);
  const reservedOptionRows = Math.min(
    availableOptions,
    APPROVAL_LONG_CONTENT_OPTION_ROWS,
    Math.max(1, contentRows - 1),
  );
  const bodyRows = Math.max(1, Math.min(
    availableBodyLines,
    contentRows - reservedOptionRows,
  ));
  const optionRows = Math.max(1, Math.min(
    availableOptions,
    contentRows - bodyRows,
  ));
  return { bodyRows, optionRows };
}

function approvalContentRows(dialogRows: number) {
  return Math.max(1, Math.min(APPROVAL_CONTENT_ROWS, Math.floor(dialogRows) - 3));
}

function formatApprovalOptions(
  state: Exclude<ApprovalState, { phase: 'closed' }>,
  width: number,
  rowCount: number,
) {
  const review = currentApprovalReview(state);
  if (!review?.options.length) return '  No available decisions';
  const start = Math.min(
    Math.max(0, state.selectedIndex - rowCount + 1),
    Math.max(0, review.options.length - rowCount),
  );
  return review.options
    .slice(start, start + rowCount)
    .map((option, offset) => {
      const selected = start + offset === state.selectedIndex;
      const input = option.input ? ' …' : '';
      const description = option.description ? ` — ${option.description}` : '';
      return truncateTerminalLine(
        `${selected ? '› ' : '  '}${option.label}${input}${description}`,
        width,
      );
    })
    .join('\n');
}

function approvalHelp(width: number) {
  if (width >= 60) {
    return ' ↑↓ option · PgUp/PgDn details · Enter · Esc cancel ';
  }
  if (width >= 36) {
    return ' ↑↓ option · Pg details · Enter · Esc ';
  }
  return ' ↑↓ · Pg · Enter · Esc ';
}

function buildReviewContentLines(review: ReviewSpec, width: number) {
  return renderReviewContentLines(review.view, width, {
    maxCharacters: MAX_REVIEW_CONTENT_CHARACTERS,
    maxLines: MAX_REVIEW_CONTENT_LINES,
  });
}

function defaultOptionIndex(review: ReviewSpec | undefined) {
  if (!review?.options.length) return 0;
  const primary = review.options.findIndex((option) => option.variant === 'primary');
  return primary >= 0 ? primary : 0;
}

function clampOptionIndex(index: number, count: number) {
  return Math.max(0, Math.min(Math.max(0, count - 1), index));
}

function currentReviewFrom(
  action: AgentReviewAction,
  decisions: readonly ReviewResponse[],
) {
  return action.reviews[decisions.length];
}
