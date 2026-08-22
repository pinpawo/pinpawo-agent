import type { TuiLaunchOptions } from '../cli/launchOptions';
import type { TuiSessionState } from '../session/sessionController';

export type QaLifecycleActions = {
  destroySoon: () => void;
  onFrame: (callback: () => void) => void;
  runPolicySelection: () => void;
  setComposerText: (text: string) => void;
  submitCurrentComposer: () => void;
  submitInput: (input: string) => void;
};

export type QaLifecycleDriverOptions = {
  enqueue?: (callback: () => void) => void;
};

export class QaLifecycleDriver {
  private readonly enqueue: (callback: () => void) => void;
  private policyStarted = false;
  private policyFinished = false;
  private editStarted = false;
  private transcriptStarted = false;
  private hostFinished = false;

  constructor(
    private readonly launch: TuiLaunchOptions,
    private readonly actions: QaLifecycleActions,
    options: QaLifecycleDriverOptions = {},
  ) {
    this.enqueue = options.enqueue ?? queueMicrotask;
  }

  installInitialFrameBehavior() {
    const { smoke } = this.launch;
    if (smoke.command) {
      this.actions.onFrame(() => {
        this.actions.setComposerText('Smoke footer repaint.');
        this.actions.submitCurrentComposer();
        this.actions.onFrame(() => this.actions.destroySoon());
      });
      return;
    }
    if (
      this.launch.smokeEnabled
      && !this.launch.hostSmoke
      && !smoke.policy
      && !smoke.edit
      && !smoke.transcript
    ) {
      this.actions.onFrame(() => this.actions.destroySoon());
    }
  }

  handleState(state: TuiSessionState) {
    const { smoke } = this.launch;
    if (
      smoke.policy
      && !this.policyStarted
      && state.connection === 'ready'
    ) {
      this.policyStarted = true;
      this.enqueue(() => {
        this.actions.submitInput('/policy');
        this.actions.runPolicySelection();
      });
      return;
    }
    if (
      smoke.policy
      && this.policyStarted
      && !this.policyFinished
      && state.session.runtime?.globalReviewPolicyMode === 'auto_authorization'
    ) {
      this.policyFinished = true;
      this.actions.destroySoon();
      return;
    }
    if (
      smoke.edit
      && !this.editStarted
      && state.connection === 'ready'
    ) {
      this.editStarted = true;
      this.enqueue(() => this.actions.submitInput('/edit smoke draft'));
      return;
    }
    if (
      smoke.transcript
      && !this.transcriptStarted
      && state.connection === 'ready'
    ) {
      this.transcriptStarted = true;
      this.enqueue(() => this.actions.submitInput('/transcript'));
      return;
    }
    if (
      smoke.hostReady
      && !this.hostFinished
      && state.connection === 'ready'
    ) {
      this.hostFinished = true;
      this.actions.destroySoon();
      return;
    }
    if (
      smoke.hostChat
      && !this.hostFinished
      && state.session.activeRun === null
      && state.session.timeline.some((entry) => (
        entry.type === 'message'
        && entry.role === 'assistant'
        && entry.status === 'completed'
      ))
    ) {
      this.hostFinished = true;
      this.actions.destroySoon();
    }
  }
}
