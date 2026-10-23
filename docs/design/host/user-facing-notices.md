# User-facing notices: codes on the wire, text in the client

Status: implemented (agent-session `notice.ts`, Host senders, TUI `i18n/`).

## Decision (2026-10-23)

- Only text for users is localized. Text for the model is one language
  (English) and is not part of this.
- The Host holds no locale. Each client decides its own display language:
  the TUI from `PINPAWO_LOCALE`, then `LC_ALL`, `LC_MESSAGES`, `LANG`;
  the Console from the browser when it gets a text table.
- Errors and notices the Host writes travel as data: a `code` and its
  `params`. The message's `message` field stays, carrying the English default
  text, so a client without a table for that code still shows something
  readable.

## Contract (`@pinpawo/agent-session`)

`AgentNotice` is the closed set of codes with typed params. It follows the
same shape as operation blocks (`docs/design/host/operation-summary.md`):

- `agentNoticeToText(notice)` is the one default (English) rendering. Its
  switch is exhaustive, so a new code fails typecheck until it has text.
- `renderAgentNotice(notice, renderers, fallback)` is the client dispatch: a
  partial renderer map per language, falling back to the default text.
- `parseAgentNotice` accepts only known codes with matching params. Anything
  else (a newer Host's code, malformed params) is dropped and the receiver
  shows `message`.

Messages that carry notice fields: the `error` event (`AgentErrorCode`), the
`system.notice` event (`AgentSystemNoticeCode`), `session.error` and
`runtime_config.error`. The projection keeps a system message's notice on the
timeline entry (`AgentMessageEntry.notice`) beside its default `text`, so
snapshots carry it and a client can render it again in its language.

`params.detail` holds text the Host did not write (a provider's error
message). Clients show it as it is.

Errors without a code are raw failures (an exception's message). They have no
fixed wording to translate and stay as `message`.

## Adding a notice

One change updates `AgentNotice`, the error or notice code set, the parser
case, `agentNoticeToText`, and the TUI's Chinese renderer (the TUI table is
typed as complete for Chinese). The Host sends it with `agentErrorEvent`,
`agentSystemNoticeEvent` or `agentNoticeMessage`, never with literal text.

## Not covered yet

- Text the agent writes into the checkpoint (review rejection, step limits):
  written once, in one language, and read by the model next turn. It needs a
  notice in message metadata, separate from what the model reads.
- Operation summaries' fixed words and approval risk reasons (the reasons are
  also auto review's input, so the human text and model input split first).
- Session titles the Host fills in ("新会话"): should become absent data that
  the client names.
- `model.select.error` already has its own codes and English text.
