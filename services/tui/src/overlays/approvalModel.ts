import type {
  AgentReviewAction,
  AgentRunView,
  ReviewResponse,
  ReviewSpec,
} from '@pinpawo/agent-session';
import { reviewDecisionsRemainValid } from '../session/reviewDecision';
import {
  truncateTerminalLine,
  wrapTerminalText,
} from '../text/terminalText';

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
  options: string;
  inputVisible: boolean;
  inputPlaceholder: string;
  bodyRows: number;
  optionRows: number;
};

const MAX_REVIEW_CONTENT_CHARACTERS = 100_000;
const MAX_REVIEW_CONTENT_LINES = 500;
export const APPROVAL_FOOTER_ROWS = 13;
const APPROVAL_CONTENT_ROWS = 10;
const APPROVAL_TEXT_INPUT_BODY_ROWS = 4;
const APPROVAL_TEXT_INPUT_OPTION_ROWS = 2;
const APPROVAL_LONG_CONTENT_OPTION_ROWS = 2;
const APPROVAL_SUBMISSION_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;

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
  footerRows = APPROVAL_FOOTER_ROWS,
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
    approvalContentRows(footerRows),
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
  footerRows = APPROVAL_FOOTER_ROWS,
): ApprovalViewModel {
  const innerWidth = Math.max(1, width - 4);
  const review = currentApprovalReview(state);
  const reviewCount = state.action.reviews.length;
  const pet = state.action.petId ? ` · ${state.action.petId}` : '';
  if (state.phase === 'resolution-sent') {
    const marker = APPROVAL_SUBMISSION_FRAMES[
      Math.max(0, Math.floor(state.submissionFrame))
        % APPROVAL_SUBMISSION_FRAMES.length
    ];
    const message = state.message ?? 'Submitting review decision…';
    const rawTitle = width >= 50
      ? `Approval ${state.reviewIndex + 1}/${reviewCount}${pet}`
      : `Approval ${state.reviewIndex + 1}/${reviewCount}`;
    return {
      title: ` ${truncateTerminalLine(rawTitle, innerWidth)} `,
      bottomTitle: state.interruptSent
        ? ' Interrupt requested '
        : ' Esc interrupt · Ctrl+C interrupt ',
      body: truncateTerminalLine(`${marker} ${message}`, innerWidth),
      options: '',
      inputVisible: false,
      inputPlaceholder: '',
      bodyRows: approvalContentRows(footerRows),
      optionRows: 0,
    };
  }
  const allBodyLines = review
    ? buildReviewContentLines(review, innerWidth)
    : ['Review is no longer available.'];
  const { bodyRows, optionRows } = approvalLayoutRows(
    state,
    allBodyLines.length,
    review?.options.length ?? 0,
    approvalContentRows(footerRows),
  );
  const maxOffset = Math.max(0, allBodyLines.length - bodyRows);
  const offset = Math.min(state.contentOffset, maxOffset);
  const bodyLines = allBodyLines.slice(offset, offset + bodyRows);
  if (state.phase === 'error' && state.message) {
    bodyLines[0] = truncateTerminalLine(`Error: ${state.message}`, innerWidth);
  }
  const contentProgress = allBodyLines.length > bodyRows
    ? ` · details ${offset + 1}-${Math.min(offset + bodyRows, allBodyLines.length)}/${allBodyLines.length}`
    : '';
  const compactContentProgress = allBodyLines.length > bodyRows
    ? ` · ${offset + 1}-${Math.min(offset + bodyRows, allBodyLines.length)}/${allBodyLines.length}`
    : '';
  const rawTitle = width >= 50
    ? `Approval ${state.reviewIndex + 1}/${reviewCount}${pet}${contentProgress}`
    : `Approval ${state.reviewIndex + 1}/${reviewCount}${compactContentProgress}`;
  const title = truncateTerminalLine(
    rawTitle,
    Math.max(1, width - 4),
  );
  return {
    title: ` ${title} `,
    bottomTitle: approvalHelp(width),
    body: bodyLines.join('\n'),
    options: formatApprovalOptions(state, innerWidth, optionRows),
    inputVisible: approvalAcceptsTextInput(state),
    inputPlaceholder: selectedApprovalOption(state)?.input?.placeholder
      ?? selectedApprovalOption(state)?.input?.label
      ?? (selectedApprovalOption(state)?.input?.multiline
        ? 'Type a response · Shift+Enter for newline'
        : 'Type a response'),
    bodyRows,
    optionRows,
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
    return {
      bodyRows: Math.max(
        1,
        Math.min(
          APPROVAL_TEXT_INPUT_BODY_ROWS,
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

function approvalContentRows(footerRows: number) {
  return Math.max(
    6,
    Math.min(
      APPROVAL_CONTENT_ROWS,
      Math.floor(footerRows) - 3,
    ),
  );
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
  const fullContent = reviewContent(review);
  const content = fullContent.slice(0, MAX_REVIEW_CONTENT_CHARACTERS);
  const wrapped = wrapTerminalText(content, width, MAX_REVIEW_CONTENT_LINES + 1);
  const truncated = content.length < fullContent.length
    || wrapped.length > MAX_REVIEW_CONTENT_LINES;
  const lines = wrapped.slice(0, MAX_REVIEW_CONTENT_LINES);
  if (truncated) {
    lines[Math.max(0, lines.length - 1)] = truncateTerminalLine(
      '… review preview truncated',
      width,
    );
  }
  return lines.length ? lines : ['Review details unavailable.'];
}

function reviewContent(review: ReviewSpec) {
  const view = review.view;
  if (view.kind === 'diff') {
    return [
      view.title,
      view.summary,
      view.target ? `Target: ${view.target}` : undefined,
      view.patch,
    ].filter(nonEmpty).join('\n');
  }
  return [view.title, view.body].filter(nonEmpty).join('\n');
}

function nonEmpty(value: string | undefined): value is string {
  return Boolean(value?.trim());
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
