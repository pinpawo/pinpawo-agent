import {
  readHumanReviewPendingInterrupt,
  type HumanReviewPendingInterruptProjection,
  type PendingInterruptProjection,
  type ReviewOption,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/agent-session';
import { reviewResponsesRemainValid } from '../session/reviewDecision';
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
      pendingInterrupt: HumanReviewPendingInterruptProjection;
      reviewIndex: number;
      responses: ReviewResponse[];
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

export type ApprovalOptionLine = {
  /** Option label, with ` …` when choosing it opens a response input. */
  text: string;
  selected: boolean;
  variant: NonNullable<ReviewOption['variant']>;
};

export type ApprovalViewModel = {
  title: string;
  bottomTitle: string;
  /** The reviewed view's own title, kept fixed above the paged content. */
  heading: string | null;
  body: string;
  /** Tone-tagged form of `body`, one entry per rendered row. */
  bodyLines: ReviewContentLine[];
  options: string;
  /** Structured form of `options`, one entry per rendered row. */
  optionLines: ApprovalOptionLine[];
  /** The selected option's description, shown under the option list. */
  description: string;
  inputVisible: boolean;
  inputPlaceholder: string;
  headingRows: number;
  bodyRows: number;
  /** Blank row separating the reviewed content from the decisions. */
  gapRows: number;
  optionRows: number;
  descriptionRows: number;
  inputRows: number;
  /**
   * Rows the dialog needs, borders included. Never more than the rows it was
   * given; short reviews get a short dialog instead of trailing blank rows.
   */
  dialogRows: number;
  loadingFrame: number | null;
};

const MAX_REVIEW_CONTENT_CHARACTERS = 100_000;
const MAX_REVIEW_CONTENT_LINES = 500;
export const APPROVAL_FOOTER_ROWS = 18;
const APPROVAL_DIALOG_MAX_ROWS = 16;
const APPROVAL_TEXT_INPUT_OPTION_ROWS = 2;
const APPROVAL_LONG_CONTENT_OPTION_ROWS = 2;
/** With room to spare, long content never hides the usual four decisions. */
const APPROVAL_ROOMY_OPTION_ROWS = 4;
const APPROVAL_INPUT_ROWS = 4;
/** Rows needed before the heading, gap and description rows are shown. */
const APPROVAL_ROOMY_INNER_ROWS = 10;
/** Width of the gutter drawn left of the reviewed content. */
export const APPROVAL_BODY_GUTTER = 2;

export type ApprovalDialogLayout = {
  width: number;
  height: number;
  left: number;
  top: number;
};

/**
 * The dialog spans the full terminal width, like the composer it temporarily
 * replaces and the transcript above it, so long commands wrap as late as
 * they can. Vertically it gets the expanded footer minus a spare row above
 * and below; the view then shrinks it to its content against the bottom.
 */
export function calculateApprovalDialogLayout(
  availableWidth: number,
  availableHeight: number,
): ApprovalDialogLayout {
  const width = Math.max(1, Math.floor(availableWidth));
  const height = Math.max(1, Math.floor(availableHeight));
  const dialogHeight = Math.max(
    1,
    Math.min(
      APPROVAL_DIALOG_MAX_ROWS,
      height > 4 ? height - 2 : height,
    ),
  );
  return {
    width,
    height: dialogHeight,
    left: 0,
    top: Math.max(0, Math.floor((height - dialogHeight) / 2)),
  };
}

export function createApprovalState(): ApprovalState {
  return { phase: 'closed' };
}

export function syncApprovalState(
  state: ApprovalState,
  pendingInterrupt: PendingInterruptProjection | null,
  resumeInFlight = false,
): ApprovalState {
  const pendingReview = readHumanReviewPendingInterrupt(pendingInterrupt);
  if (!pendingReview) {
    return state.phase === 'closed' ? state : createApprovalState();
  }
  if (
    state.phase !== 'closed'
    && state.pendingInterrupt.interruptId === pendingReview.interruptId
    && reviewResponsesRemainValid(pendingReview, state.responses)
  ) {
    if (state.phase === 'resolution-sent' && !resumeInFlight) {
      return {
        ...state,
        phase: 'ready',
        pendingInterrupt: pendingReview,
        interruptSent: false,
        submissionFrame: 0,
        message: undefined,
      };
    }
    return {
      ...state,
      pendingInterrupt: pendingReview,
      reviewIndex: state.responses.length,
      selectedIndex: clampOptionIndex(
        state.selectedIndex,
        currentReviewFrom(pendingReview, state.responses)?.options.length ?? 0,
      ),
    };
  }
  return {
    phase: 'ready',
    pendingInterrupt: pendingReview,
    reviewIndex: 0,
    responses: [],
    selectedIndex: defaultOptionIndex(pendingReview.payload.interactions[0]),
    contentOffset: 0,
    draft: '',
    interruptSent: false,
    submissionFrame: 0,
  };
}

export function currentApprovalReview(state: ApprovalState) {
  return state.phase === 'closed'
    ? null
    : state.pendingInterrupt.payload.interactions[state.reviewIndex] ?? null;
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
    approvalBodyWidth(width),
  ).length;
  const bodyRows = approvalLayoutRows(
    state,
    review,
    lineCount,
    dialogRows,
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
  responses: ReviewResponse[],
): ApprovalState {
  const interactions = state.phase === 'closed'
    ? []
    : state.pendingInterrupt.payload.interactions;
  if (state.phase === 'closed' || responses.length >= interactions.length) {
    return state;
  }
  const review = interactions[responses.length];
  return {
    ...state,
    phase: 'ready',
    reviewIndex: responses.length,
    responses,
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
  const bodyWidth = approvalBodyWidth(width);
  const review = currentApprovalReview(state);
  const reviewCount = state.pendingInterrupt.payload.interactions.length;
  const heading = review?.view.title?.trim() || null;
  if (state.phase === 'resolution-sent') {
    const message = state.message ?? 'Submitting review decision…';
    const rawTitle = `Review ${state.reviewIndex + 1}/${reviewCount}`;
    const text = truncateTerminalLine(message, Math.max(1, innerWidth - 4));
    const headingRows = heading && dialogRows - 2 >= 2 ? 1 : 0;
    return {
      title: ` ${truncateTerminalLine(rawTitle, innerWidth)} `,
      bottomTitle: state.interruptSent
        ? ' Interrupt requested '
        : ' Esc interrupt · Ctrl+C interrupt ',
      heading: headingRows ? truncateTerminalLine(heading ?? '', innerWidth) : null,
      body: text,
      bodyLines: [{ text, tone: 'default' }],
      options: '',
      optionLines: [],
      description: '',
      inputVisible: false,
      inputPlaceholder: '',
      headingRows,
      bodyRows: 1,
      gapRows: 0,
      optionRows: 0,
      descriptionRows: 0,
      inputRows: 0,
      dialogRows: Math.min(Math.max(1, Math.floor(dialogRows)), headingRows + 3),
      loadingFrame: state.submissionFrame,
    };
  }
  const allBodyLines: ReviewContentLine[] = review
    ? buildReviewContentLines(review, bodyWidth)
    : [{ text: 'Review is no longer available.', tone: 'muted' }];
  const rows = approvalLayoutRows(
    state,
    review,
    allBodyLines.length,
    dialogRows,
  );
  const { bodyRows, optionRows } = rows;
  const maxOffset = Math.max(0, allBodyLines.length - bodyRows);
  const offset = Math.min(state.contentOffset, maxOffset);
  const bodyLines = allBodyLines.slice(offset, offset + bodyRows);
  if (state.phase === 'error' && state.message) {
    bodyLines[0] = {
      text: truncateTerminalLine(`Error: ${state.message}`, bodyWidth),
      tone: 'removed',
    };
  }
  const overflowing = allBodyLines.length > bodyRows;
  const contentProgress = overflowing
    ? ` · details ${offset + 1}-${Math.min(offset + bodyRows, allBodyLines.length)}/${allBodyLines.length}`
    : '';
  const compactContentProgress = overflowing
    ? ` · ${offset + 1}-${Math.min(offset + bodyRows, allBodyLines.length)}/${allBodyLines.length}`
    : '';
  const rawTitle = width >= 50
    ? `Review ${state.reviewIndex + 1}/${reviewCount}${contentProgress}`
    : `Review ${state.reviewIndex + 1}/${reviewCount}${compactContentProgress}`;
  const title = truncateTerminalLine(
    rawTitle,
    Math.max(1, width - 4),
  );
  const optionLines = buildApprovalOptionLines(
    state,
    Math.max(1, innerWidth - 2),
    optionRows,
  );
  const description = rows.descriptionRows
    ? truncateTerminalLine(
        selectedApprovalOption(state)?.description ?? '',
        Math.max(1, innerWidth - 2),
      )
    : '';
  return {
    title: ` ${title} `,
    bottomTitle: approvalHelp(width, overflowing),
    heading: rows.headingRows && heading
      ? truncateTerminalLine(heading, innerWidth)
      : null,
    body: bodyLines.map((line) => line.text).join('\n'),
    bodyLines,
    options: optionLines.length
      ? optionLines
        .map((line) => `${line.selected ? '› ' : '  '}${line.text}`)
        .join('\n')
      : '  No available decisions',
    optionLines,
    description,
    inputVisible: approvalAcceptsTextInput(state),
    inputPlaceholder: selectedApprovalOption(state)?.input?.placeholder
      ?? selectedApprovalOption(state)?.input?.label
      ?? (selectedApprovalOption(state)?.input?.multiline
        ? 'Type a response · Shift+Enter for newline'
        : 'Type a response'),
    ...rows,
    dialogRows: Math.min(
      Math.max(1, Math.floor(dialogRows)),
      2
        + rows.headingRows
        + Math.min(bodyRows, allBodyLines.length)
        + rows.gapRows
        + optionRows
        + rows.descriptionRows
        + rows.inputRows,
    ),
    loadingFrame: null,
  };
}

/**
 * Splits the dialog's inner rows between the fixed heading, the pageable
 * content, the decisions and the response input. Decorative rows (heading,
 * gap, description) are dropped first when the terminal is short.
 */
function approvalLayoutRows(
  state: ApprovalState,
  review: ReviewSpec | null,
  bodyLineCount: number,
  dialogRows: number,
) {
  const innerRows = Math.max(1, Math.floor(dialogRows) - 2);
  const roomy = innerRows >= APPROVAL_ROOMY_INNER_ROWS;
  const headingRows = review?.view.title?.trim() && innerRows >= 6 ? 1 : 0;
  const gapRows = roomy ? 1 : 0;
  const descriptionRows = roomy
    && review?.options.some((option) => option.description?.trim())
    ? 1
    : 0;
  const textInput = approvalAcceptsTextInput(state);
  const inputRows = textInput ? APPROVAL_INPUT_ROWS : 0;
  const contentRows = Math.max(
    1,
    innerRows - headingRows - gapRows - descriptionRows - inputRows,
  );
  const fixed = { headingRows, gapRows, descriptionRows, inputRows };

  if (textInput) {
    const optionRows = contentRows >= 4
      ? APPROVAL_TEXT_INPUT_OPTION_ROWS
      : 1;
    // The response textarea takes fixed rows, but the reviewed content must not
    // collapse below what is left: a multi-line shell command stays readable
    // while the operator types a reply.
    return {
      ...fixed,
      bodyRows: Math.max(
        1,
        Math.min(Math.max(bodyLineCount, 1), contentRows - optionRows),
      ),
      optionRows,
    };
  }

  const availableBodyLines = Math.max(1, bodyLineCount);
  const availableOptions = Math.max(1, review?.options.length ?? 0);
  const reservedOptionRows = Math.min(
    availableOptions,
    roomy ? APPROVAL_ROOMY_OPTION_ROWS : APPROVAL_LONG_CONTENT_OPTION_ROWS,
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
  return { ...fixed, bodyRows, optionRows };
}

function approvalBodyWidth(width: number) {
  return Math.max(1, width - 4 - APPROVAL_BODY_GUTTER);
}

function buildApprovalOptionLines(
  state: Exclude<ApprovalState, { phase: 'closed' }>,
  width: number,
  rowCount: number,
): ApprovalOptionLine[] {
  const review = currentApprovalReview(state);
  if (!review?.options.length) return [];
  const start = Math.min(
    Math.max(0, state.selectedIndex - rowCount + 1),
    Math.max(0, review.options.length - rowCount),
  );
  return review.options
    .slice(start, start + rowCount)
    .map((option, offset) => ({
      text: truncateTerminalLine(
        `${option.label}${option.input ? ' …' : ''}`,
        width,
      ),
      selected: start + offset === state.selectedIndex,
      variant: option.variant ?? 'normal',
    }));
}

function approvalHelp(width: number, pageable: boolean) {
  if (width >= 64) {
    return pageable
      ? ' ↑↓ choose · Enter confirm · PgUp/PgDn scroll · Esc cancel '
      : ' ↑↓ choose · Enter confirm · Esc cancel ';
  }
  if (width >= 36) {
    return pageable
      ? ' ↑↓ · Enter · Pg scroll · Esc '
      : ' ↑↓ choose · Enter · Esc ';
  }
  return pageable ? ' ↑↓ · Enter · Pg · Esc ' : ' ↑↓ · Enter · Esc ';
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
  pendingInterrupt: HumanReviewPendingInterruptProjection,
  responses: readonly ReviewResponse[],
) {
  return pendingInterrupt.payload.interactions[responses.length];
}
