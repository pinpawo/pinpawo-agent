import type { AgentRunView } from '@pinpawo/agent-session';
import type {
  TuiSessionController,
  TuiConnectionStatus,
} from '../session/sessionController';
import {
  APPROVAL_FOOTER_ROWS,
  advanceApproval,
  advanceApprovalSubmissionFrame,
  beginApprovalSubmission,
  createApprovalState,
  failApproval,
  moveApprovalSelection,
  scrollApprovalContent,
  selectedApprovalOption,
  setApprovalDraft,
  syncApprovalState,
  updateApprovalResolutionSent,
  type ApprovalAction,
  type ApprovalState,
} from './approvalModel';

type TimerHandle = ReturnType<typeof setTimeout>;

type ReviewSessionController = Pick<
  TuiSessionController,
  'submitReviewResponse' | 'cancelReview'
>;

export type ApprovalControllerOptions = {
  sessionController: ReviewSessionController;
  getWidth: () => number;
  getHeight?: () => number;
  onChange: (state: ApprovalState) => void;
  submissionTimeoutMs?: number;
  submissionPulseMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

const DEFAULT_SUBMISSION_TIMEOUT_MS = 10_000;
const DEFAULT_SUBMISSION_PULSE_MS = 240;

export class ApprovalController {
  private readonly sessionController: ReviewSessionController;
  private readonly getWidth: () => number;
  private readonly getHeight: () => number;
  private readonly onChange: (state: ApprovalState) => void;
  private readonly submissionTimeoutMs: number;
  private readonly submissionPulseMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private state = createApprovalState();
  private submissionTimer: TimerHandle | null = null;
  private submissionPulseTimer: TimerHandle | null = null;

  constructor(options: ApprovalControllerOptions) {
    this.sessionController = options.sessionController;
    this.getWidth = options.getWidth;
    this.getHeight = options.getHeight ?? (() => APPROVAL_FOOTER_ROWS);
    this.onChange = options.onChange;
    this.submissionTimeoutMs = options.submissionTimeoutMs
      ?? DEFAULT_SUBMISSION_TIMEOUT_MS;
    this.submissionPulseMs = options.submissionPulseMs
      ?? DEFAULT_SUBMISSION_PULSE_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  getState() {
    return this.state;
  }

  sync(run: AgentRunView | null, connection: TuiConnectionStatus) {
    let next = syncApprovalState(this.state, run);
    if (next.phase !== 'resolution-sent') {
      this.clearSubmissionTimers();
    } else if (connection !== 'ready') {
      this.clearSubmissionTimer();
      next = updateApprovalResolutionSent(
        next,
        {
          message:
            'Connection changed; waiting for authoritative review state…',
        },
      );
    }
    this.update(next);
  }

  setDraft(draft: string) {
    this.update(setApprovalDraft(this.state, draft));
  }

  handle(action: ApprovalAction) {
    if (
      this.state.phase === 'closed'
      || this.state.phase === 'resolution-sent'
      || !action
    ) {
      return;
    }
    if (action === 'previous-option' || action === 'next-option') {
      this.update(moveApprovalSelection(
        this.state,
        action === 'previous-option' ? -1 : 1,
      ));
      return;
    }
    if (action === 'page-up' || action === 'page-down') {
      this.update(scrollApprovalContent(
        this.state,
        action === 'page-up' ? -1 : 1,
        this.getWidth(),
        this.getHeight(),
      ));
      return;
    }
    if (action === 'cancel') {
      const result = this.sessionController.cancelReview({
        requestId: this.state.requestId,
        actionId: this.state.action.actionId,
      });
      this.update(result.ok
        ? this.beginSubmission(this.state)
        : failApproval(this.state, reviewFailureText(result.reason)));
      return;
    }

    const option = selectedApprovalOption(this.state);
    if (!option) {
      this.update(failApproval(this.state, 'no review option is selected'));
      return;
    }
    const result = this.sessionController.submitReviewResponse({
      requestId: this.state.requestId,
      actionId: this.state.action.actionId,
      decisions: this.state.decisions,
      optionId: option.id,
      inputText: this.state.draft,
    });
    if (!result.ok) {
      this.update(failApproval(this.state, reviewFailureText(result.reason)));
    } else if (result.status === 'advanced') {
      this.update(advanceApproval(this.state, result.decisions));
    } else {
      this.update(this.beginSubmission(this.state));
    }
  }

  destroy() {
    this.clearSubmissionTimers();
    this.state = createApprovalState();
  }

  markInterruptSent() {
    this.update(updateApprovalResolutionSent(this.state, {
      interruptSent: true,
      message: 'Interrupt requested; waiting for the run to stop…',
    }));
  }

  noteResolutionWait(message: string) {
    this.update(updateApprovalResolutionSent(this.state, { message }));
  }

  private beginSubmission(state: ApprovalState) {
    this.clearSubmissionTimers();
    const resolutionSent = beginApprovalSubmission(state);
    if (resolutionSent.phase === 'closed') return resolutionSent;
    const actionId = resolutionSent.action.actionId;
    this.submissionTimer = this.setTimer(() => {
      this.submissionTimer = null;
      if (
        this.state.phase !== 'resolution-sent'
        || this.state.action.actionId !== actionId
      ) {
        return;
      }
      this.update(updateApprovalResolutionSent(
        this.state,
        {
          message:
            'Still waiting for authoritative review state…',
        },
      ));
    }, this.submissionTimeoutMs);
    this.scheduleSubmissionPulse(actionId);
    return resolutionSent;
  }

  private scheduleSubmissionPulse(actionId: string) {
    this.submissionPulseTimer = this.setTimer(() => {
      this.submissionPulseTimer = null;
      if (
        this.state.phase !== 'resolution-sent'
        || this.state.action.actionId !== actionId
      ) {
        return;
      }
      this.update(advanceApprovalSubmissionFrame(this.state));
      this.scheduleSubmissionPulse(actionId);
    }, this.submissionPulseMs);
  }

  private clearSubmissionTimer() {
    if (this.submissionTimer === null) return;
    this.clearTimer(this.submissionTimer);
    this.submissionTimer = null;
  }

  private clearSubmissionTimers() {
    this.clearSubmissionTimer();
    if (this.submissionPulseTimer === null) return;
    this.clearTimer(this.submissionPulseTimer);
    this.submissionPulseTimer = null;
  }

  private update(next: ApprovalState) {
    if (next === this.state) return;
    this.state = next;
    this.onChange(next);
  }
}

function reviewFailureText(
  reason:
    | 'not-ready'
    | 'closed'
    | 'stale'
    | 'input-required'
    | 'send-failed',
) {
  switch (reason) {
    case 'not-ready':
      return 'local-agent is not connected';
    case 'closed':
      return 'this review is already closed';
    case 'stale':
      return 'this review changed; wait for the refreshed request';
    case 'input-required':
      return 'enter a response before submitting';
    case 'send-failed':
      return 'the review response could not be sent';
  }
}
