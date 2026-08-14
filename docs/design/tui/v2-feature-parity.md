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
| chat | submit a message through the shared protocol | aligned | real PTYs drive composer text through Enter, then rehydrate turns after host restart; Shift+Enter and the terminal-independent `Ctrl+J` keep multiline input available, while an isolated local-only host also completed live-model turns through the production v2 client and sustained live-LLM dogfood remains |
| chat | canonical message/operation/subagent ordering | aligned | a no-smoke production PTY now settles operation output, distinct subagent progress, and the final assistant message in canonical terminal order; asynchronous Blob/binary WebSocket payload decoding is serialized per socket so later frames cannot overtake earlier events; sustained real-agent dogfood remains |
| timeline | streaming assistant response on a live surface | aligned | a no-smoke production PTY observes multiple Markdown deltas before the final rich-text commit; live-LLM Markdown dogfood remains |
| timeline | running/updated tool operation appears before completion | aligned | the production PTY observes the running operation, an output-delta update, and its completed output before later canonical rows settle; the first isolated live-model tool probe returned a literal `Calling: Bash` assistant completion with no canonical operation event, which is a capability/runtime invocation issue rather than a TUI ordering failure |
| timeline | operation target, summary, bounded output/error, and patch detail | aligned | real-host tool and patch dogfood |
| timeline | assistant Markdown, lists, links, tables, and code blocks | aligned | production PTY coverage now includes streaming emphasis plus a final heading/rich-text commit; cross-terminal and broader real-host Markdown dogfood remains |
| timeline | distinct subagent identity and progress presentation | aligned | v2 reuses the legacy paragraph/sentence grouping behind a distinct role surface, now verified between a production operation and main-assistant reply in a real PTY |
| timeline | timestamps and actor label | aligned | canonical timestamps and one terminal-safe session actor label feed welcome, live activity, settled rows, pager, and export metadata |
| timeline | long-session bounded commits and session boundaries | aligned | continue performance dogfood with real sessions |
| scrolling | terminal-owned touchpad scroll, selection, and copy | aligned in Ghostty | Terminal.app, iTerm2, and integrated-terminal matrix |
| scrolling | browse position survives append and delta bursts | aligned in Ghostty | cross-terminal matrix |
| scrolling | submitting a new round returns to bottom follow | partial | v2 immediately commits the new canonical user row, but an automated PTY cannot observe or control the terminal emulator's native scrollback viewport; verify this explicitly in Ghostty, Terminal.app, iTerm2, and the integrated terminal without clearing history |
| composer | multiline edit, soft wrap, paste, selection, forward delete, undo/redo | aligned | Enter submits while Shift+Enter and `Ctrl+J` insert newlines; terminal-cell-aware decoration styles Markdown, slash commands, and standalone `@path` tokens while native coverage proves the source, CJK/emoji offsets, history, and protocol payload remain unchanged; narrow OpenTUI 0.4.5 editor fixes stay at the textarea boundary; a production PTY also keeps a decorated multiline draft editable while an active run resizes from 80×24 to 44×18 and back to 96×28, then submits it unchanged; remaining IME and terminal-specific key dogfood |
| composer | prompt history with draft restoration | aligned | a no-smoke macOS PTY restores and resubmits an exact prior prompt through the production host; the cross-terminal matrix remains |
| composer | slash commands and command/help palette | aligned | a no-smoke macOS PTY uses Tab completion to open `/help`, proves help owns Esc and returns focus, completes the session-scoped `/continue` command after a cancelled review, then completes `/quit` and exits; remaining command workflows and the cross-terminal matrix remain |
| composer | workspace `@path` completion | aligned | a no-smoke macOS PTY opens the production overlay, completes a Unicode filename containing a space, submits the exact text to the host, and restores it from checkpoint; native editor coverage keeps the entire completed path visually decorated when earlier text moves it, invalidates stale decoration after internal edits or complete deletion, and restores it through undo without changing source text; the cross-terminal matrix remains |
| attachments | quoted, escaped, `file://`, and multiple local paths | aligned | production OpenTUI paste handling separates multiple paths into attachments while preserving ordinary multiline paste; parsing now preserves Windows drive/UNC separators and Windows file URLs instead of treating backslashes as POSIX escapes, while a real macOS PTY covers quoted paths with spaces, Unicode filenames, and last-item removal and the cross-terminal drag-in matrix remains |
| attachments | removable structured attachment chips and submit | aligned | production host integration proves selected full paths reach model context without eager content reads while terminal/checkpoint text remains filename-only; the full composer PTY proves a removed path does not reach model input or recovery, and the production-toolkit PTY parses a selected Unicode attachment from actual subagent context, executes a real read tool, renders its content through the operation timeline, and preserves the filename-only terminal/checkpoint boundary across host restart |
| review | approval, rejection, text response, batching, cancellation | aligned | production handler coverage gives rejection and cancellation the same rollback lifecycle: both consume the concrete pending interrupt, remove the complete unexecuted AI tool-call action without synthetic `ToolMessage`, interrupt the run, and leave the delegation pending; `/continue <guidance>` sends `resume_active` and replans from the last complete lane boundary, while a later new review still runs auto-review normally; sustained manual local-tool dogfood remains |
| session | new session and resume picker | aligned | production handler-chain new/list/resume, native scrollback boundaries, and non-empty checkpoint recovery across host processes are covered; live checkpoint dogfood remains |
| runtime | interrupt, error notice, review policy | aligned | production interruption, graph-failure recovery, immediate stop wake-up, and process-level host restart are covered; an isolated live-model run also settled an Esc interrupt authoritatively and accepted a successful next turn; if the authoritative interrupt result remains pending for ten seconds, v2 escalates its local notice without fabricating completion or unlocking input; full browser-runtime dogfood remains |
| status | immediate waiting feedback plus two-line run/model/workspace/token/context status | aligned | accepted requests continuously animate the canonical session actor in the fixed live footer at a bounded 240 ms cadence, distinguish tool/stream/review/interrupt states, and leave the composer available for drafting; a quiet phase adds “still working” after ten seconds without adding an elapsed clock; explicit `pinpawo tui --v2 --qa` drives the normally resolved production UI/bundle through the deterministic lifecycle, and isolated live-model turns confirmed final cumulative `in/out` plus remaining context updates; terminal-native browse anchoring with the continuous low-frequency footer animation remains in the cross-terminal matrix |
| transcript | pager handoff and Markdown export | aligned | a no-smoke macOS PTY completes `/transcript` through the palette, hands all seven ordered turns plus operation/subagent rows to a real `$PAGER` child without local-path leakage, resumes the composer, and writes the seven canonical user/assistant turns through `/export`; a separate blocking-pager PTY proves that a response completed while the pager owns the TTY is reconciled into native scrollback on return; Windows quoted executable paths preserve separators and export paths use drive plus `~\` home semantics, while actual pager and cross-terminal combinations remain |
| editor | `$VISUAL`/`$EDITOR` handoff and draft restore | aligned | a no-smoke macOS PTY invokes a real `$VISUAL` child with inherited TTY, validates its initial file, restores a Unicode multiline draft after renderer resume, submits it to the production host, and recovers it from checkpoint; Windows quoted executable paths such as `C:\Program Files\...\editor.exe` now parse without consuming separators, while actual editor combinations remain |
| Studio | Studio-specific workflow expansion | deferred | tracked after chat parity |
| release | package/runtime distribution | partial | a fresh Bun bundle boots its external OpenTUI dependency in the prepublish gate; real empty-project tarball installs now traverse the installed CLI/manifest/package-local Bun path on local darwin-arm64 and Linux arm64/x64 plus GitHub-hosted macOS, Ubuntu, and Windows runners; only the default-switch decision remains |

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
   coverage now includes approval, review cancellation as suspension, explicit
   session-scoped `/continue` with guidance, interruption
   (including partial-stream settlement), reconnect across independent host
   processes with non-empty FileSaver history, new, list, resume, and native
   scrollback session boundaries. The no-smoke production PTY also drives a
   real checkpointed LangGraph review through overlay ownership, keyed resume,
   completion, and restart recovery. A second deterministic production host now
   exercises the actual toolkit review middleware and tool execution, including
   cancellation without side effects, explicit delegation continuation,
   re-review, approved execution, operation settlement, and checkpoint recovery;
   sustained manual local-tool dogfood remains.
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
   Dynamic production-PTY coverage now preserves an active-run multiline draft
   through a narrow resize and submits it after the response settles; the
   cross-terminal visual matrix remains.

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
