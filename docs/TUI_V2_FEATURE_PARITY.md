# TUI v2 feature parity

Issue: #454
Legacy baseline: `services/local-agent/src/tui`
OpenTUI implementation: `services/tui/src`

## Purpose

TUI v2 is still a migration target, not a default-entry candidate. This
document tracks user-visible parity with the legacy Ink TUI and orders the
remaining work by chat impact.

Status meanings:

- **aligned**: implemented in v2 with automated evidence;
- **partial**: the main path exists, but presentation, edge cases, or real-host
  dogfood are still incomplete;
- **missing**: no equivalent production behavior yet;
- **deferred**: deliberately outside the current chat-parity milestone.

## Current parity

| Area | Capability | Status | Remaining work |
| --- | --- | --- | --- |
| host | authenticated local WebSocket, snapshot bootstrap, reconnect | aligned | the real v2 process reaches an authenticated host through a macOS PTY, and independent host processes restore a non-empty FileSaver checkpoint and continue the same session; full `pinpawo run` browser-runtime dogfood remains |
| chat | submit a message through the shared protocol | aligned | a real PTY drives composer text and Kitty `Ctrl+Enter` through the production host, then rehydrates that turn after host restart; sustained live-LLM dogfood remains |
| chat | canonical message/operation/subagent ordering | aligned | richer rendering below |
| timeline | streaming assistant response on a live surface | aligned | real-host Markdown delta dogfood |
| timeline | running/updated tool operation appears before completion | aligned | current branch adds an atomic live operation surface |
| timeline | operation target, summary, bounded output/error, and patch detail | aligned | real-host tool and patch dogfood |
| timeline | assistant Markdown, lists, links, tables, and code blocks | aligned | cross-terminal and real-host Markdown dogfood |
| timeline | distinct subagent identity and progress presentation | aligned | v2 reuses the legacy paragraph/sentence grouping behind a distinct role surface |
| timeline | timestamps and actor label | aligned | canonical timestamps and the session actor label feed the shared display model |
| timeline | long-session bounded commits and session boundaries | aligned | continue performance dogfood with real sessions |
| scrolling | terminal-owned touchpad scroll, selection, and copy | aligned in Ghostty | Terminal.app, iTerm2, and integrated-terminal matrix |
| scrolling | browse position survives append and delta bursts | aligned in Ghostty | cross-terminal matrix |
| composer | multiline edit, soft wrap, paste, selection, undo/redo | aligned | remaining IME and terminal-specific key dogfood |
| composer | prompt history with draft restoration | aligned | manual cross-terminal verification |
| composer | slash commands and command/help palette | aligned | production workflow dogfood |
| composer | workspace `@path` completion | aligned | production workflow dogfood |
| attachments | quoted, escaped, `file://`, and multiple local paths | aligned | production OpenTUI paste handling now separates multiple paths into attachments while preserving ordinary multiline paste; cross-terminal drag-in matrix remains |
| attachments | removable structured attachment chips and submit | aligned | production host integration proves full paths reach model context without eager content reads while terminal/checkpoint text remains filename-only; live tool dogfood remains |
| review | approval, rejection, text response, batching, cancellation | aligned | production handler-chain approval and cancel-to-reject resume are covered; live guarded-tool dogfood remains |
| session | new session and resume picker | aligned | production handler-chain new/list/resume, native scrollback boundaries, and non-empty checkpoint recovery across host processes are covered; live checkpoint dogfood remains |
| runtime | interrupt, error notice, review policy | aligned | production interruption, graph-failure recovery, immediate stop wake-up, and process-level host restart are covered; full CLI/browser-runtime dogfood remains |
| status | two-line run/model/workspace/token/context status | aligned | narrow-terminal dogfood |
| transcript | pager handoff and Markdown export | aligned | production pager/editor combinations |
| editor | `$VISUAL`/`$EDITOR` handoff and draft restore | aligned | production editor combinations |
| Studio | Studio-specific workflow expansion | deferred | tracked after chat parity |
| release | package/runtime distribution | partial | platform install matrix; no default switch during parity work |

## Work order

### P0 — make the real chat loop complete

1. Dogfood the implemented timeline fidelity against the real host:
   - confirm running operations remain visible and in canonical order;
   - confirm operation output, errors, and `apply_patch` diffs;
   - confirm scrollback-safe assistant Markdown during streaming;
   - confirm subagent progress remains distinct from main-assistant messages.
2. Exercise a real local-agent run containing:
   user message → streaming assistant/tool activity → subagent output →
   completed assistant message.
3. Dogfood approval against a live guarded tool. Deterministic production-host
   coverage now includes approval, cancel-to-reject resume, interruption
   (including partial-stream settlement), reconnect across independent host
   processes with non-empty FileSaver history, new, list, resume, and native
   scrollback session boundaries.
4. Dogfood structured attachments with real local tools. The deterministic
   production-host integration already proves full paths reach model context,
   contents are not eagerly read, and terminal/checkpoint text remains
   filename-only.

### P1 — daily-use interaction parity

1. Complete prompt-history, command, file-mention, clipboard, external-editor,
   and transcript dogfood.
2. Finish multi-file drag-in and attachment removal tests in real terminals.
3. Validate narrow layouts, resize, long sessions, and failure recovery.

### P2 — release readiness

1. Complete the manual matrix in macOS Terminal, iTerm2, Ghostty, and one
   integrated terminal.
2. Complete supported-platform install and executable smokes.
3. Compare the final v2 checklist against the legacy TUI.
4. Only after parity and dogfood are complete, open a separate decision for the
   default entry and legacy fallback period.

## Current milestone exit criteria

The feature-parity milestone is complete only when:

- the real chat loop presents messages, operations, and subagents in canonical
  order with useful live and completed detail;
- core composer, attachment, review, session, interrupt, reconnect, and error
  workflows pass against a real local-agent host;
- known terminal-specific gaps have an explicit fallback;
- the legacy TUI remains available throughout the migration.
