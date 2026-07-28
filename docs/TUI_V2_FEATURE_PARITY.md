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
| host | authenticated local WebSocket, snapshot bootstrap, reconnect | aligned | the no-smoke v2 production process reaches an authenticated host through a macOS PTY, exits through the user `/quit` path, and independent host processes restore a non-empty FileSaver checkpoint and continue the same session; full `pinpawo run` browser-runtime dogfood remains |
| chat | submit a message through the shared protocol | aligned | real PTYs drive composer text through both Kitty `Ctrl+Enter` and the raw `Ctrl+O` fallback, then rehydrate turns after host restart; the fallback keeps multiline Enter usable when a terminal cannot distinguish modified Enter, while sustained live-LLM dogfood remains |
| chat | canonical message/operation/subagent ordering | aligned | a no-smoke production PTY now settles operation output, distinct subagent progress, and the final assistant message in canonical terminal order; sustained real-agent dogfood remains |
| timeline | streaming assistant response on a live surface | aligned | a no-smoke production PTY observes multiple Markdown deltas before the final rich-text commit; live-LLM Markdown dogfood remains |
| timeline | running/updated tool operation appears before completion | aligned | the production PTY observes the running operation, an output-delta update, and its completed output before later canonical rows settle |
| timeline | operation target, summary, bounded output/error, and patch detail | aligned | real-host tool and patch dogfood |
| timeline | assistant Markdown, lists, links, tables, and code blocks | aligned | production PTY coverage now includes streaming emphasis plus a final heading/rich-text commit; cross-terminal and broader real-host Markdown dogfood remains |
| timeline | distinct subagent identity and progress presentation | aligned | v2 reuses the legacy paragraph/sentence grouping behind a distinct role surface, now verified between a production operation and main-assistant reply in a real PTY |
| timeline | timestamps and actor label | aligned | canonical timestamps and the session actor label feed the shared display model |
| timeline | long-session bounded commits and session boundaries | aligned | continue performance dogfood with real sessions |
| scrolling | terminal-owned touchpad scroll, selection, and copy | aligned in Ghostty | Terminal.app, iTerm2, and integrated-terminal matrix |
| scrolling | browse position survives append and delta bursts | aligned in Ghostty | cross-terminal matrix |
| composer | multiline edit, soft wrap, paste, selection, undo/redo | aligned | raw `Ctrl+O` now provides an explicit submit fallback without taking ordinary Enter away from multiline input; remaining IME and terminal-specific key dogfood |
| composer | prompt history with draft restoration | aligned | a no-smoke macOS PTY restores and resubmits an exact prior prompt through the production host; the cross-terminal matrix remains |
| composer | slash commands and command/help palette | aligned | a no-smoke macOS PTY uses Tab completion to open `/help`, proves help owns Esc and returns focus, then completes `/quit` and exits; remaining command workflows and the cross-terminal matrix remain |
| composer | workspace `@path` completion | aligned | a no-smoke macOS PTY opens the production overlay, completes a Unicode filename containing a space, submits the exact text to the host, and restores it from checkpoint; the cross-terminal matrix remains |
| attachments | quoted, escaped, `file://`, and multiple local paths | aligned | production OpenTUI paste handling separates multiple paths into attachments while preserving ordinary multiline paste; parsing now preserves Windows drive/UNC separators and Windows file URLs instead of treating backslashes as POSIX escapes, while a real macOS PTY covers quoted paths with spaces, Unicode filenames, and last-item removal and the cross-terminal drag-in matrix remains |
| attachments | removable structured attachment chips and submit | aligned | production host integration proves selected full paths reach model context without eager content reads while terminal/checkpoint text remains filename-only; the full composer PTY proves a removed path does not reach model input or recovery, and the production-toolkit PTY parses a selected Unicode attachment from actual subagent context, executes a real read tool, renders its content through the operation timeline, and preserves the filename-only terminal/checkpoint boundary across host restart |
| review | approval, rejection, text response, batching, cancellation | aligned | production handler-chain approval and cancel-to-reject resume are covered; one no-smoke PTY drives a checkpointed LangGraph interrupt through overlay ownership, while an independent production graph makes a real reviewed toolkit call, proves its file side effect is absent before approval and present afterward, renders its operation before the completed reply, and restores only canonical messages after host restart; sustained manual local-tool dogfood remains |
| session | new session and resume picker | aligned | production handler-chain new/list/resume, native scrollback boundaries, and non-empty checkpoint recovery across host processes are covered; live checkpoint dogfood remains |
| runtime | interrupt, error notice, review policy | aligned | production interruption, graph-failure recovery, immediate stop wake-up, and process-level host restart are covered; full CLI/browser-runtime dogfood remains |
| status | two-line run/model/workspace/token/context status | aligned | narrow-terminal dogfood |
| transcript | pager handoff and Markdown export | aligned | a no-smoke macOS PTY completes `/transcript` through the palette, hands all seven ordered turns plus operation/subagent rows to a real `$PAGER` child without local-path leakage, resumes the composer, and writes the seven canonical user/assistant turns through `/export`; Windows quoted executable paths preserve separators and export paths use drive plus `~\` home semantics, while actual pager and cross-terminal combinations remain |
| editor | `$VISUAL`/`$EDITOR` handoff and draft restore | aligned | a no-smoke macOS PTY invokes a real `$VISUAL` child with inherited TTY, validates its initial file, restores a Unicode multiline draft after renderer resume, submits it to the production host, and recovers it from checkpoint; Windows quoted executable paths such as `C:\Program Files\...\editor.exe` now parse without consuming separators, while actual editor combinations remain |
| Studio | Studio-specific workflow expansion | deferred | tracked after chat parity |
| release | package/runtime distribution | partial | a fresh Bun bundle boots its external OpenTUI dependency in the prepublish gate, and a real empty-project tarball install now traverses the installed CLI/manifest/package-local Bun path on darwin-arm64; Linux/Windows install execution and the default-switch decision remain |

## Work order

### P0 — make the real chat loop complete

1. Dogfood the implemented timeline fidelity against the real host:
   - confirm running operations remain visible and in canonical order;
   - confirm operation output, errors, and `apply_patch` diffs;
   - confirm scrollback-safe assistant Markdown during streaming;
   - confirm subagent progress remains distinct from main-assistant messages.
2. Exercise a real local-agent run containing:
   user message → streaming assistant/tool activity → subagent output →
   completed assistant message. The deterministic production host and no-smoke
   `main.ts` PTY now cover this exact ordering, including a tool-output update
   and multi-delta Markdown; sustained live-model/tool dogfood remains.
3. Dogfood approval against a live guarded tool. Deterministic production-host
   coverage now includes approval, cancel-to-reject resume, interruption
   (including partial-stream settlement), reconnect across independent host
   processes with non-empty FileSaver history, new, list, resume, and native
   scrollback session boundaries. The no-smoke production PTY also drives a
   real checkpointed LangGraph review through overlay ownership, keyed resume,
   completion, and restart recovery. A second deterministic production host now
   exercises the actual toolkit review middleware and tool execution, including
   pre-approval side-effect isolation, operation settlement, and checkpoint
   recovery; sustained manual local-tool dogfood remains.
4. Dogfood structured attachments with real local tools. The deterministic
   production-host integration already proves full paths reach model context,
   contents are not eagerly read, and terminal/checkpoint text remains
   filename-only. A real PTY now also drives three bracketed-paste paths through
   the production composer, removes the last one, submits the selected two, and
   verifies filename-only recovery after host restart. An independent production
   graph now consumes a selected Unicode attachment with a real read-only
   Toolkit tool whose call path is parsed from the model context rather than
   hard-coded, while the terminal and restored checkpoint expose only its name.

### P1 — daily-use interaction parity

1. Complete cross-terminal prompt-history/file-mention plus command, clipboard,
   actual-editor, and pager combinations.
2. Complete the cross-terminal multi-file drag-in and attachment-removal matrix.
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
