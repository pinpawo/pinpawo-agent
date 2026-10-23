import { agentNoticeToText, type AgentErrorNotice } from '@pinpawo/agent-session';

/**
 * A run failure the user should see as a notice rather than as the raw error:
 * the failure path sends `notice` as data, with its default text as message.
 */
export class AgentNoticeError extends Error {
  readonly notice: AgentErrorNotice;

  constructor(notice: AgentErrorNotice) {
    super(agentNoticeToText(notice));
    this.name = 'AgentNoticeError';
    this.notice = notice;
  }
}
