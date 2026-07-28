# TUI v2 OpenTUI Phase 1 capability matrix

Issue: #454  
Package: `services/tui`  
Framework: `@opentui/core` 0.4.5  
Runtime target: Bun 1.3.14

## Purpose

This work validates the terminal-dependent risks before the production TUI is
migrated. It is not yet a replacement for the existing Ink TUI. The production
v2 client now connects to the local-agent host, and a deterministic native
integration smoke exercises the production local-agent handler/session/runtime
chain over the real authenticated WebSocket transport without requiring a live
LLM.

The probe covers:

- OpenTUI `ScrollBoxRenderable` sticky-bottom and browse behavior;
- split-footer settled output in terminal scrollback with a live footer;
- terminal-owned wheel and selection input in split-footer mode;
- split-footer streaming through `ScrollbackSurface` stable-row commits;
- authenticated local-agent WebSocket transport through projection and native
  scrollback;
- terminal selection while mouse input is enabled;
- `TextareaRenderable` multiline editing, selection, paste, and undo/redo;
- Unicode, CJK, and emoji cursor/render behavior;
- raw key and bracketed-paste sequences produced by file drag-in;
- resize events;
- large timeline construction and high-frequency in-place text updates.

## Automated evidence

| Check | Expected | Status |
| --- | --- | --- |
| shared projection import | no `services/local-agent/src/*` import | implemented |
| local-agent host integration | production session, chat adapter, inflight operation, snapshot, and authenticated WebSocket handlers drive chat submission, operation/subagent/delta/completion events, completion rehydration, and duplicate-free native scrollback | Bun native integration test |
| local-agent reconnect integration | a transport termination triggers v2 backoff/reconnect and checkpoint rehydration; live-only operation/subagent state is intentionally omitted while committed terminal rows are not replayed | Bun native integration test |
| local attachment host boundary | structured local attachments traverse the authenticated production protocol with full paths available only to model context and no eager file-content read; a production-toolkit PTY then parses the selected Unicode path from actual subagent context, calls a real read-only tool, renders the returned file content in operation order, and keeps the terminal plus restarted checkpoint filename-only | Bun native + child-process production PTY test |
| production multi-path paste | the production attachment reducer and OpenTUI paste callback separate quoted multi-path input into distinct attachments, keep path text out of the composer, preserve ordinary multiline paste, and report duplicates/protocol limits; the parser preserves Windows drive, UNC, and `file:///C:/...` paths without consuming separator backslashes, while a real macOS PTY pastes three paths with spaces and Unicode, removes the last with Backspace, and proves only the selected paths reach model input and filename-only recovery | unit + Bun native + child-process PTY test |
| production session switching | v2 new/list/resume commands traverse the authenticated host, preserve per-thread checkpoints and active-session metadata, avoid replay on an empty new session, and deliberately recommit resumed history at a native scrollback session boundary | Bun native integration test |
| production interruption | a v2 interrupt traverses the authenticated host, aborts the graph signal, settles partial assistant output, appends the terminal notice in canonical order, and releases native scrollback for later rows | shared projection unit + Bun native integration test |
| production review resolution | canonical review interrupts reach v2 as waiting-review state; approval and cancel-to-reject decisions traverse the authenticated host, resume the same graph thread, clear the checkpointed interrupt, complete the assistant response, and release native scrollback; one no-smoke PTY drives a direct LangGraph checkpoint interrupt through the visible overlay, while a second production graph makes a real reviewed toolkit call and proves the tool side effect is gated until primary Enter, then executes, settles its operation before the final reply, and restores canonical messages without synthetic delegation-plan leakage after process restart | Bun native + child-process production PTY test |
| production failure recovery | a graph failure after assistant delta settles the partial message, appends the canonical error in order, releases the active run, and permits the next authenticated host request to complete normally | shared projection unit + Bun native integration test |
| production runtime stop | `requestStop()` aborts the runtime's keepalive wait immediately instead of delaying shutdown by the configured polling interval | local-agent lifecycle unit |
| production process restart | the local HTTP/WebSocket transport exposes an idempotent close lifecycle; two independent Bun host processes reuse one port and production FileSaver state while v2 reconnects, restores non-empty history/token usage, and continues the same session | local-agent lifecycle unit + Bun child-process integration test |
| production TUI process entry | the real no-flag `main.ts` process runs inside expect-managed macOS PTYs, authenticates to independent production hosts, applies snapshots, accepts attachment paste/removal, composer/history/`@path` flows, renders updated operation/subagent/multi-delta Markdown, resolves both a direct checkpoint review and an actual reviewed toolkit call, consumes a structured attachment with a real read tool, and performs real `$VISUAL` plus `$PAGER` handoffs; pager return, Markdown export, guarded write/read execution, `/quit`, privacy boundaries, and ordered checkpoint rehydration are verified across host restarts | Bun child-process PTY integration test |
| canonical timeline order | message/operation/subagent/message order is retained through the production host and settles in the same order on the real terminal surface | automated + Bun native + child-process production PTY test |
| operation raw payload | shared projection retains transient raw data | automated test |
| live ordered operation tail | running/updated operations remain visible with later subagent/message rows on one transient surface, then commit atomically in canonical order; a no-smoke production PTY observes started, output-delta, completed output, distinct subagent progress, multiple assistant deltas, and the final rich-text commit | Bun native + child-process production PTY test |
| operation detail rendering | bounded output/error text and `apply_patch` payload lines are visible without importing local-agent implementation code | automated test |
| legacy display-rule reuse | assistant Markdown normalization, subagent paragraph grouping, and `toolName(args)` operation presentation are shared as runtime-independent v2 formatters | automated test |
| scrollback-safe assistant Markdown | headings, inline emphasis and links, lists, blockquotes, code, and tables render without changing canonical message text; mutable table tails remain transient until completion | Bun native test |
| high-frequency delta projection | one streaming entry is updated in place | automated test |
| shared session list/resume | host results are correlated, timeout/error paths reject, and resume applies one canonical snapshot | automated test |
| resume race isolation | late completion snapshots from the previous session cannot replace the resumed session | automated test |
| resume overlay input ownership | navigation is isolated from the composer and locks during resume | automated test |
| resume overlay resize | 9-row split footer remains bounded at wide and narrow terminal widths | Bun native test |
| canonical approval restore | snapshot/runtime waiting-review state opens the same approval model | automated test |
| batched review decisions | approved decisions advance locally and the terminal response carries the complete canonical decision list | automated test |
| review response validation | stale action, stale batch, missing input, disconnect, and send failure cannot submit an invalid response | automated test |
| approval input ownership | option navigation yields to a dedicated multiline textarea after free text starts; ordinary characters on a non-input review remain isolated from the composer before primary Enter resumes the production host | automated + child-process production PTY test |
| approval details paging | long plain/markdown/diff review content remains pageable inside the fixed footer | automated test |
| approval overlay resize | CJK body/options and multiline input remain bounded in the 9-row split footer | Bun native test |
| global review policy | snapshot metadata restores the host policy; `/policy` persists a correlated update before changing visible state | automated test + OpenTUI PTY |
| policy overlay ownership | arrows/Enter/Esc remain isolated from the composer and the overlay stays bounded across resize | automated + Bun native test |
| slash command parsing | exact implemented commands resolve while absolute paths and slash-prefixed prose remain chat input | automated test |
| raw-control composer submit fallback | Kitty `Ctrl+Enter` remains the primary send chord, while raw `Ctrl+O` submits through the same production composer as a fallback for terminals that cannot distinguish modified Enter; ordinary Enter remains multiline input | automated help model + child-process production PTY test |
| command palette ownership | cursor-at-end slash tokens own navigation/submit while ordinary edit keys remain composer-owned; production Tab completion opens help and completes quit | automated + child-process PTY test |
| command palette cursor ownership | the five-row candidate menu stays above a compact visible composer while the footer remains fixed at nine rows; full-footer help alone hides the composer cursor and returns focus after Esc | automated + Bun native + child-process PTY test |
| help paging and resize | command help pages within the fixed footer, remains bounded at narrow widths, and owns Esc in the production process | automated + Bun native + child-process PTY test |
| Studio mode | `/studio [task]` and `/chat` keep composer mode local while projecting user/progress/reply/error rows through the shared ordered Session timeline | automated test + OpenTUI PTY |
| external editor lifecycle | `/edit [text]` suspends OpenTUI, gives the TTY to `$VISUAL`/`$EDITOR`, resumes on success or failure, and restores the multiline draft without submitting; the production process then submits that exact restored draft through the host, and Windows quoted executable paths retain backslash separators | automated + smoke PTY + child-process production PTY test |
| keyboard transcript browsing | PageUp from an empty composer or `/transcript` hands the full ordered canonical timeline to `$PAGER`, buffers projection rendering while suspended, and reconciles after return; the production PTY verifies all seven ordered turns plus operation/subagent rows, filename-only attachments, restored composer ownership, and Windows pager command parsing preserves quoted executable separators | automated test + interactive pager PTY + child-process production PTY test |
| transcript export | `/export [path]` writes completed canonical user/assistant messages locally without a new host protocol or local-agent implementation import; the production PTY reads the resulting Markdown and verifies message order plus local-path privacy, while Windows drive, directory, and `~\` home paths resolve with win32 semantics | automated + child-process PTY test |
| composer keyboard editing | Cmd+A, Cmd+Z/Shift+Cmd+Z, Option+arrows, Shift selection, Home/End, and Ctrl+A/E preserve multiline, CJK, and emoji offsets under Kitty keyboard input | Bun native test |
| composer prompt history | plain Up/Down routes to a bounded 100-entry history only at the first/last total visual row, preserves exact multiline prompts, restores the in-progress draft, and can resubmit the restored text through the production host | automated + Bun native soft-wrap + child-process PTY test |
| workspace file mention | standalone chat `@path` tokens open bounded workspace candidates; directory/file completion is cursor-aware, wide-character safe, rejects `..` or symlink escape, and submits a Unicode filename containing a space through the production host | automated + Bun native resize/cursor + child-process PTY test |
| internal selection clipboard | Cmd+C/Cmd+X and Ctrl+Shift fallbacks use OSC 52; cut deletes only after a successful clipboard write | automated test; manual terminal verification pending |
| new-session race isolation | `/new` waits for an authoritative new-session ID, discards late completion snapshots, and preserves identical messages across the native scrollback boundary | automated + Bun native test |
| interrupt ownership | Esc/first Ctrl+C sends one canonical interrupt and the notice owns input until the run settles; second Ctrl+C exits | automated test |
| error notice ownership | connection/local errors remain width-safe and dismissible without editing the composer | automated + Bun native test |
| two-line status | run/connection/notice and session in/out/context/workspace facts remain separate with narrow-width degradation | automated test |
| borderless welcome | terminal-raster paw, v2 package version, runtime facts, and shortcuts commit once before timeline history | automated + Bun native test |
| Phase 5 CLI entry | `pinpawo tui --v2` selects a bundled/workspace OpenTUI executable or workspace source while `--legacy` remains an explicit rollback | automated test + compiled PTY |
| npm distribution payload | one Bun-targeted JS bundle and versioned manifest ship in `pinpawo`; npm selects Bun/OpenTUI platform packages | automated manifest tests + installed-tarball PTY |
| distribution integrity and platform launch | launcher verifies the bundle byte count/SHA-256 before execution and resolves package-local Bun runtimes for darwin/Linux/Windows on x64/arm64; Windows uses the direct `bun.exe` rather than a command shim | automated test matrix |
| distribution artifact boot | a fresh runtime-neutral bundle is built outside the source entrypoint, its byte count/SHA-256 are rechecked, and its non-interactive version probe loads the external OpenTUI runtime before publishing | Bun native prepublish test |
| installed package check | `pinpawo tui --v2 --check` follows the normal launch plan without a terminal; the release smoke packs local tarballs, performs a lifecycle-enabled install in an empty project, verifies npm-selected Bun/OpenTUI assets, and runs that installed CLI path with bounded stages | passed on darwin-arm64; Linux/Windows pending |
| raw input preview | controls are escaped and output is bounded | automated test |
| fixed-footer composer layout | composer grows from 3–5 visible rows without changing terminal footer height | automated test |
| native textarea regression | multiline paste and single-grapheme backspace preserve line boundaries | Bun native test |
| TypeScript | `npm run typecheck -w @pinpawo/tui` | passed |
| unit tests | `npm run test -w @pinpawo/tui` | passed, 124 tests |
| native tests | `npm run test:native -w @pinpawo/tui` | passed, 28 tests including a freshly built distribution artifact boot, Bun-native Windows file-URL parsing, production multi-path paste, process failure cleanup, two real production-host PTY entries (the full composer flow plus reviewed-write and attachment-read toolkit calls), file-mention resize/wide-character cursor mapping, policy/command/help/notice, approval/resume resize, textarea editing/history shortcuts, 10 real ScrollbackSurface tests, a production handler vertical slice, and independent-process restart |
| focused host integration | `npm run test:host -w @pinpawo/tui` | passed; attachment boundaries, ordered chat completion, reconnect, new/list/resume, interruption, approval, cancel-to-reject, graph failure, next-turn recovery, process restart, and the real TUI PTY entry traverse production handlers |
| focused process lifecycle | `npm run test:process -w @pinpawo/tui` | passed, 4 tests; production hosts checkpoint, restore, and continue turns; the full no-smoke PTY covers selected attachments, prompt history, Unicode workspace mention, ordered operation/subagent/streaming-Markdown rendering, checkpoint approval, real `$VISUAL`/`$PAGER`, Markdown export, and `/quit`; an independent two-turn PTY proves a real production toolkit review gates a file mutation, then derives a read-only tool call from structured attachment context, settles both operations before their final replies, and restores canonical filename-only messages without synthetic plan or internal handoff duplication |
| alternate-screen PTY startup | `npm run smoke -w @pinpawo/tui` | passed in an automated 80×24 PTY |
| split-footer PTY startup | `npm run smoke:split -w @pinpawo/tui` | passed in an automated 80×24 PTY |
| Studio PTY flow | `npm run smoke:studio -w @pinpawo/tui` | passed; user/progress/final rows committed in order and terminal state restored |
| review policy PTY flow | `npm run smoke:policy -w @pinpawo/tui` | passed; host acknowledgement updates the compact policy status and terminal state is restored |
| external editor PTY flow | `npm run smoke:edit -w @pinpawo/tui` | passed; renderer suspend/resume restores the split footer and edited multiline draft |
| transcript pager PTY flow | `npm run smoke:transcript -w @pinpawo/tui` plus interactive `less` | passed; full ordered timeline is readable, `q` exits, split footer resumes, and terminal state is restored |
| standalone executable | `npm run build -w @pinpawo/tui` | passed for darwin-arm64; normal and approval compiled PTY smokes passed |
| root typecheck | `npm run typecheck` | passed |
| root tests | `npm test` | passed, including local-agent 776/776 and Chrome extension 22/22 |
| root build | `npm run build` | passed |
| CLI package dry-run | `npm run pack:dry -w pinpawo` | passed; `dist/tui/main.js` and its manifest are included |
| installed tarball v2 startup | `npm run test:tui-install -w pinpawo` installs generated local tarballs in an empty project and runs the installed `pinpawo tui --v2 --check` path | passed on darwin-arm64 with package-local Bun/OpenTUI runtime; interactive PTY remains separately covered |

## Manual terminal matrix

Use the same checklist in each terminal. Do not mark a capability supported
from an automated PTY run alone.

| Capability | macOS Terminal | iTerm2 | Ghostty | Integrated terminal |
| --- | --- | --- | --- | --- |
| touchpad scroll while timeline focused | pending | pending | passed | pending |
| PageUp `/transcript` pager and `q` return | pending | pending | pending | passed with interactive `less` PTY |
| browse position survives incoming rows | pending | pending | passed | pending |
| scrolling back to bottom resumes sticky follow | pending | pending | pending | pending |
| terminal/app text selection and copy | pending | pending | passed | pending |
| composer internal selection copy/cut | pending | pending | pending | pending |
| `Ctrl+Enter` or `Ctrl+O` composer submit | pending | pending | pending | pending |
| composer prompt history and draft restore | pending | pending | pending | pending |
| chat `@path` completion and Esc dismissal | pending | pending | pending | pending |
| command palette stays above the visible search composer | pending | pending | passed | pending |
| multiline edit and soft wrap | pending | pending | passed | pending |
| Shift selection and deletion | pending | pending | pending | pending |
| undo/redo | pending | pending | pending | pending |
| bracketed multiline paste is not submitted | pending | pending | passed | pending |
| CJK and emoji cursor alignment | pending | pending | pending | pending |
| Chinese IME composition | pending | pending | pending | pending |
| absolute path drag-in sequence | pending | pending | passed | pending |
| quoted/escaped multi-path drag-in sequence | pending | pending | delivered; parser automated, production UI retest pending | pending |
| resize during editing and browsing | pending | pending | passed with terminal-owned history limitation | pending |
| 250-row append burst | pending | pending | passed | pending |
| 400-update delta burst | pending | pending | passed | pending |

## Manual observations

### Codex integrated terminal

| Probe | Observation | Result |
| --- | --- | --- |
| alternate-screen `ScrollBoxRenderable` | scrolling became unstable and the internal scrollbar disappeared after burst updates | failed |
| split-footer with OpenTUI mouse tracking | wheel input was consumed by the footer instead of reaching terminal scrollback | failed |
| split-footer with terminal-owned mouse input | touchpad scrolling and native scrollback worked after OpenTUI mouse tracking was disabled | passed |
| per-token live-footer repaint | continuous footer output prevented browsing terminal history during the delta burst | failed |
| `ScrollbackSurface` stable-row commits | history remained scrollable during 400 off-screen delta updates | passed |

These are preliminary results from one integrated terminal, not a cross-terminal
compatibility claim. The current leading direction is split-footer with
terminal-owned wheel/selection input and stable-row scrollback commits.

### Ghostty

| Probe | Observation | Result |
| --- | --- | --- |
| terminal-owned scrolling and selection | touchpad scrolling, the terminal scrollbar, and text selection work in split-footer mode | passed |
| multiline composer in the initial split-footer build | frame chrome left only one content row, so pasted lines and newlines were hidden | failed; fixed with 3–5 visible row growth inside a stable footer |
| single-grapheme line backspace | OpenTUI 0.4.5 removed both the grapheme and its preceding newline | failed upstream; narrow workaround and Bun native regression added |
| `Cmd+A` | selects the composer contents | passed |
| single-file drag-in | Ghostty delivers the path to the composer | passed |
| multi-file drag-in | Ghostty delivers shell-style path text; the production client now parses quoted, escaped, `file://`, and multiple absolute paths into removable chips | automated parser complete; production Ghostty retest pending |
| resize | committed scrollback and footer layout became visually inconsistent | partial; fixed footer avoids app-driven height transitions, but committed terminal scrollback remains terminal-owned |
| dynamic composer height | changing `renderer.footerHeight` left old footer frames in Ghostty scrollback | failed; composer now reclaims title/live rows inside a fixed nine-row footer |
| palette-to-composer footer repaint | transparent footer cells retained stale palette/status text after the composer expanded | passed after painting the complete fixed footer with the terminal default background |

The final Ghostty retest confirmed multiline growth, multiline paste, resize,
touchpad scroll anchoring during a 250-row append, browsing during the
400-update delta burst, the palette-above-composer layout, and a clean
palette-to-composer footer transition with one two-line status. Existing
committed scrollback remains terminal-owned by design, so the spike does not
destructively replay it after resize.

## Phase 1 decision

The production direction is the split-footer model:

- completed timeline rows are committed to native terminal scrollback through
  `ScrollbackSurface`;
- OpenTUI mouse tracking stays disabled so touchpad scrolling, selection, and
  copy remain terminal-owned;
- live state and the composer occupy a fixed nine-row footer;
- the composer exposes three to five visible rows without resizing that footer
  and scrolls internally beyond five rows;
- streaming rows update in place and are committed only when stable, so
  high-frequency deltas do not continually repaint terminal history.

The alternate-screen `ScrollBoxRenderable` probe remains useful as a reference,
but it is not the default TUI v2 scrolling model. It gave the application more
viewport control at the cost of native selection and terminal scrollback
behavior, without a compensating improvement in the tested chat workflow.

Known limits and follow-up work:

- composer mouse editing is not enabled because terminal mouse tracking would
  take ownership away from native scrolling and selection;
- the production Phase 2 client now has structured path parsing and removable
  attachment UI; cross-terminal drag-in retesting remains a release gate;
- IME, key mapping, and repaint behavior still require dogfood in macOS
  Terminal and iTerm2 before the new TUI becomes the default.

## Procedure

1. Run `npm run dev:split -w @pinpawo/tui` for the Phase 1 interaction probe.
2. Browse upward through the initial 40 rows with the touchpad, then press
   `Ctrl+T` to commit 250 more rows.
3. Confirm the viewport remains anchored while those rows are added.
4. Return to the bottom, press `Ctrl+T` again, and confirm terminal-native
   sticky follow resumes. Press `Ctrl+D` to run the 400-update stable-row delta
   probe, then browse history while it streams.
5. Select timeline text and copy it using the terminal's normal workflow.
6. The split-footer composer is focused by default. Test multiline input, soft
   wrap, selection, deletion, undo/redo, CJK, emoji, and IME. In the production
   composer, verify Cmd+A, Option+arrows, Home/End,
   Cmd+Z/Shift+Cmd+Z, and Cmd+C/Cmd+X; confirm a clipboard failure leaves a cut
   selection unchanged. Submit two prompts, start a third draft, and verify
   Up/Down at the first/last visual row recalls both prompts and restores the
   untouched draft.
7. Paste multiple lines and confirm no accidental submit occurs.
8. Run `npm run dev -w @pinpawo/tui`, then drag a path with spaces, a Unicode
   path, and multiple files into the production composer. Confirm each path
   becomes a distinct chip and Backspace removes the last chip when the text is
   empty. Type `中文 @serv`, use Tab/Enter to descend or complete a candidate,
   and confirm Esc closes the candidate view without clearing the composer.
9. Press `Ctrl+R`, browse sessions with arrows and PageUp/PageDown, then press
   Esc and confirm the composer draft is unchanged. Open it again, resume an
   inactive session, and confirm its timeline replaces the current one.
10. Resize the terminal while editing, browsing history, and while the resume
    overlay is open.
11. Run `npm run dev:review -w @pinpawo/tui`. Page through details, select the
    text-response option, paste multiple lines, submit, and confirm focus returns
    to the composer. Restart it, press Esc, and confirm cancellation also
    restores the composer.
12. Run `npm run dev:command -w @pinpawo/tui`. Filter the palette, navigate and
    complete commands, open `/help`, page it, close with Esc/q, then run `/new`
    and `/resume`. Run `/edit draft`, save a multiline change in the external
    editor, and confirm it returns to the composer without submitting. Press
    PageUp from an empty composer, navigate the transcript pager, and press `q`;
    then run `/export transcripts` and inspect the generated Markdown. Confirm
    every overlay and terminal handoff restores the composer focus.
13. Start a long response, press Esc or Ctrl+C, and confirm the interrupt notice
    owns the footer until the host settles. Confirm a second Ctrl+C exits.
14. Resize through 80, 40, and 24 columns; confirm both status rows stay bounded
    and the welcome precedes the first timeline entry.
15. Repeat the selection, scroll, resize, paste, IME, and burst checks with
    `npm run dev:split -w @pinpawo/tui`. Compare native terminal scrollback
    against the alternate-screen internal viewport.
16. From the repository root run `npm run tui:v2 -w pinpawo` and confirm the
    compiled/workspace launcher opens the same v2 client. Run
    `npm run tui:legacy -w pinpawo` and confirm the Ink rollback still starts.

## Decision gate

The Phase 1 architecture decision is complete based on automated PTY coverage,
Ghostty manual testing, and the integrated-terminal probes above. Phase 2 may
start with the split-footer model.

The remaining macOS Terminal and iTerm2 matrix is a dogfood and release gate,
not an implementation blocker. Any unsupported critical capability still needs
a documented fallback before TUI v2 replaces the existing Ink client.
