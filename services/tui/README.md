# `@pinpawo/tui`

OpenTUI-based TUI v2 client.

The package now contains the Phase 2–4 vertical slice and the first Phase 5
dogfood entrypoint from issue #454:

- it imports the canonical projection from `@pinpawo/agent-session`;
- it does not import `services/local-agent/src/*`;
- it is available through `pinpawo tui --v2`, while the default `pinpawo tui`
  and explicit `--legacy` rollback still use Ink;
- it connects to the authenticated loopback local-agent WebSocket;
- it decodes asynchronous WebSocket payloads on one per-socket queue, so a
  slower Blob/binary frame cannot be overtaken by a later event and change
  canonical timeline order;
- it loads one canonical Session snapshot, consumes live runtime events, and
  submits chat messages through the shared protocol;
- it renders settled timeline entries into terminal-native scrollback and keeps
  streaming state in an OpenTUI scrollback surface;
- it commits completed visual rows during streaming without pulling terminal
  wheel/selection ownership into the app;
- it recognizes pasted or dragged local paths as removable attachments without
  reading or uploading file contents.
- it keeps Markdown/code/CJK/emoji composer source unchanged through native
  selection, forward-delete, undo/redo, and submission, with narrow OpenTUI
  0.4.5 compatibility fixes isolated at the textarea boundary.
- it decorates Markdown structure, slash commands, and standalone `@path`
  tokens through terminal-cell-aware style ranges without changing composer
  text, cursor offsets, history, or the submitted protocol payload; completed
  Unicode paths containing spaces keep one stable range through nearby edits
  and invalidate or restore that range consistently through edits and
  undo/redo.
- it completes chat-only `@path` workspace file references in a fixed-footer
  candidate view without allowing `..` or symlink traversal outside the
  session workspace.
- it lists and resumes host sessions through the shared protocol in an
  OpenTUI-owned footer overlay, while keeping picker state outside the canonical
  Session projection.
- it restores canonical pending reviews from snapshots and provides an
  OpenTUI-owned approval overlay for single or batched approve, reject, respond,
  and cancel flows.
- it projects unfinished delegation availability from the focused session's
  authoritative checkpoint: while that session is idle, `/continue <guidance>`
  resumes the exact delegation whether it was suspended by this TUI, another
  client, or a previous process.
- it provides a compact cursor-aware slash command palette above the visible
  composer, plus a separate pageable help overlay for the commands currently
  implemented by the v2 client.
- it commits a borderless, terminal-rasterized paw welcome with the v2 package
  version before the first timeline rows.
- it keeps run/connection state and session token/context facts in a compact
  two-line status area, with width-priority degradation.
- it acknowledges an accepted message immediately with an animated live
  activity indicator, distinguishes tool/stream/review/interrupt states, and
  keeps the empty composer available for drafting while the run is active.
- it gives interrupting and connection/local errors an input-owning notice
  overlay instead of leaving them as easy-to-miss composer text; an interrupt
  still awaiting authoritative confirmation after ten seconds escalates the
  notice without releasing the run.
- it reads the host's global review policy from authoritative runtime metadata
  and changes it through a correlated, host-persisted `/policy` flow.
- it can suspend OpenTUI, hand the terminal to `$VISUAL` or `$EDITOR`, and load
  the edited multiline draft back into the composer.
- it exports completed canonical user/assistant messages as a local Markdown
  transcript without adding a host protocol or depending on local-agent code.
- it opens the complete ordered canonical timeline in `$PAGER` (or `less`) by
  temporarily handing over the TTY, instead of maintaining a second viewport.

## Run the vertical slice

Install dependencies. Start the Node host in one terminal:

```sh
npm install
npm run start -w pinpawo -- run
```

Then start the OpenTUI client through the Phase 5 migration entrypoint from the
repository root in another terminal:

```sh
npm run tui:v2 -w pinpawo
```

An installed package runs the Bun-targeted bundle carried at
`pinpawo/dist/tui/main.js` with the platform Bun and OpenTUI packages selected
by npm. A source checkout instead prefers its workspace Bun dependency and
current TUI source, then falls back to a compiled workspace binary, the packaged
bundle, or global `bun`. `PINPAWO_TUI_V2_BIN` can select an explicit standalone
build and `PINPAWO_BUN_BIN` can select a Bun runtime. Direct development remains
available with `npm run dev -w @pinpawo/tui`.

Use `npm run tui:v2 -w pinpawo -- --check` to verify the resolved workspace or
installed runtime without entering terminal mode.

The empty-project distribution check is verified on local darwin-arm64 and
Linux arm64/x64 with Node 24, plus GitHub-hosted macOS, Ubuntu, and Windows
runners. It rebuilds and packs the local packages, installs them with lifecycle
scripts in a clean consumer project, verifies npm-selected Bun and OpenTUI
assets, and runs the installed `pinpawo tui --v2 --check` path. On macOS the
same clean install also enters `pinpawo tui --v2 --qa` through a real PTY,
submits with Enter, waits for deterministic completion and usage,
verifies the composer returns, and exits through `/quit`.

`@pinpawo/tui` remains a private implementation package. The public `pinpawo`
tarball carries one runtime-neutral Bun bundle and a versioned manifest rather
than publishing a TUI API package or six PinPawo platform binary packages.
`bun`, `@opentui/core`, and `web-tree-sitter` are optional runtime dependencies,
so legacy CLI installation and `pinpawo tui --legacy` remain available if a
platform cannot install the v2 runtime.

Windows drive and UNC attachment paths, plus quoted `VISUAL`/`EDITOR`/`PAGER`
commands under `Program Files`, use Windows tokenization so separator
backslashes are not interpreted as POSIX shell escapes.

The client reads `LOCAL_SERVER_PORT` (default `3210`) and the bearer token
written by the host to `~/.pinpawo/local-server-token`. It will synchronize the
active Session before enabling submission and will reconnect with bounded
backoff if the host disappears. After the fast retry sequence, it keeps polling
at the capped interval until the host returns and a fresh snapshot is applied.

Production client controls:

- Enter submits the composer; Shift+Enter inserts a newline when the terminal
  exposes the modifier, and `Ctrl+J` is the terminal-independent newline
  fallback;
- `Cmd+A`, `Cmd+Z`/`Shift+Cmd+Z`, Option+arrows, Home/End, and Shift-modified
  movement use the native multiline editor selection and history behavior;
- plain `↑` on the first visual row recalls sent chat prompts; plain `↓` on
  the last visual row moves forward and restores the in-progress draft;
- `Cmd+C`/`Cmd+X` copy or cut an internal selection through OSC 52;
  `Ctrl+Shift+C`/`Ctrl+Shift+X` are available when the terminal forwards them,
  and a failed clipboard write never deletes the selection;
- dragging or pasting one or more absolute local paths creates attachment chips;
  POSIX shell escaping and Windows drive/UNC separators are parsed independently
  so Windows backslashes are not consumed as shell escapes;
- Backspace removes the last attachment while the composer text is empty;
- typing a standalone `@path` token in chat opens workspace candidates;
  `↑`/`↓` selects, Tab/Enter inserts, and Esc closes only the candidate view;
- PageUp from an empty, attachment-free composer or `/transcript` opens the
  complete timeline in `$PAGER`; `q` returns to the composer;
- `Ctrl+R` or an exact `/resume` command opens the session picker;
- `↑`/`↓`, `PageUp`/`PageDown`, and Enter navigate and resume a session; Esc
  closes the picker without changing the composer draft;
- while an approval is open, `↑`/`↓` selects a decision, PageUp/PageDown pages
  the review details, Enter submits, and Esc cancels the pending review and
  interrupts its active delegation;
- a text-response option owns a separate multiline textarea; Shift+Enter inserts
  a newline while Enter submits, and the normal composer draft remains intact;
- typing `/` at the end of an attachment-free composer opens a five-row command
  palette above the compact still-visible search composer; `↑`/`↓` selects, Tab
  completes, Enter executes, and Esc clears it;
- `/help` opens pageable command and shortcut help, `/new` starts a clean chat
  projection, `/policy` chooses the host review policy, `/resume` opens the
  session picker, `/transcript` (or `/history`) opens the timeline pager,
  `/edit [text]` opens `$VISUAL` or `$EDITOR`, `/export [path]` writes a
  Markdown transcript, `/continue <guidance>` resumes the current session's
  unfinished checkpointed delegation, `/review-policy` aliases `/policy`, and
  `/quit` exits;
- `/studio [task]` enters Studio mode and optionally starts a task; subsequent
  prose keeps the same Studio conversation until `/chat` returns to chat mode;
- ordinary prose containing a path remains text, and unavailable path-only
  pastes are inserted as text with a notice;
- Esc or the first `Ctrl+C` interrupts an active response; a second `Ctrl+C`
  while interruption is settling exits immediately;
- Enter or Esc dismisses an error notice; `Ctrl+C` exits while idle.

The timeline keeps message, operation, and subagent ordering from the shared
Session projection. During a streaming message, only complete terminal rows are
committed to native scrollback; the mutable last row remains live. Historical
alignment uses an object-identity fast path for deltas and falls back to
fingerprint reconciliation after a snapshot or reconnect. Large settled
prefixes are committed in bounded batches.

The fixed footer reserves two status rows. The first keeps connection, current
run activity, and notices visible; the second keeps cumulative
`in/out`, context remaining, and the compact workspace path visible. At narrow
widths the path is dropped first, then context falls back to a percentage.
The live row begins with a short activity pulse as soon as the host accepts a
request, before the first model delta arrives. A new pulse marks a real
thinking/tool/streaming phase change, but it does not repaint indefinitely and
interfere with terminal-native history browsing. If one phase stays quiet for
ten seconds, a single non-repeating refresh changes the copy to “still
thinking/using/responding”; completion, review, interruption, or a real phase
change cancels that timer. While a run is active, the live row and composer use
the canonical session actor label, and the composer placeholder makes it
explicit that a follow-up can be drafted and that Esc interrupts the run;
review pauses and interruption use non-animated labels.

The resume overlay defaults to the newest inactive session so Enter does not
accidentally reload the current one. A successful switch clears the old draft
and attachments only after the host returns the selected canonical snapshot.
Late completion snapshots from the previous session are ignored.

Approval selection, paging, batch decisions, and text drafts are local overlay
state rather than Session projection fields. The controller validates each
response against the currently focused canonical review action before sending
`human_review_response` or `review.cancel`. Once transport accepts a resolution,
the local one-shot marker continues to gate duplicate decisions across timeout
and reconnect; only a server-observed review or run transition clears it.
Esc or Ctrl+C after that marker sends an ordered `run.interrupt`, while another
Ctrl+C exits. Cancellation does not masquerade as rejection. Delegation
continuation is a separate checkpoint capability: the controller offers
`/continue` while the focused snapshot reports `hasResumableDelegation` and the
session is idle, sends `resume_active` for that command, and sends
`supersede_active` for ordinary chat input. Accepted input does not mutate the
checkpoint-owned capability; the active run hides the affordance until the
next authoritative snapshot. The idle status and composer placeholder make the
choice visible without introducing a second editor or composer target.

The policy picker also remains view-local, but its current value does not. The
host exposes the process-wide policy in snapshot runtime metadata, persists
changes, and acknowledges each v2 update before the TUI changes its status.
Legacy clients may still send the older uncorrelated update. Run the
deterministic policy flow without a host with:

```sh
npm run smoke:policy -w @pinpawo/tui
```

`/edit [text]` writes a temporary Markdown draft, suspends the OpenTUI renderer,
and starts `$VISUAL` (preferred) or `$EDITOR` with inherited terminal I/O. When
the editor exits successfully, the renderer resumes and the edited text returns
to the composer without submitting it. The temporary file is then removed. Run
the deterministic suspend/resume PTY flow with:

```sh
npm run smoke:edit -w @pinpawo/tui
```

`/export [path]` formats the current canonical Session directly in the TUI
client. It includes only completed user and assistant messages, so live deltas,
operations, and system rows are not duplicated into the transcript. A path
with an extension is treated as the destination file; a path without one is
treated as a directory. Without an argument, the file is written under the
session runtime working directory. Windows drive paths and `~\` home paths use
win32 resolution rather than POSIX path rules.

`/transcript` is intentionally different from `/export`: it snapshots every
ordered canonical timeline entry, including operations, system rows, and
subagent messages, into a temporary plain-text file and opens `$PAGER`
(defaulting to `less`). OpenTUI is suspended while the pager owns the terminal,
then resumed and reconciled with any Session events received in the background.
The pager snapshot itself stays stable; after `q`, buffered timeline updates and
the correct overlay focus are rendered. Welcome, live activity, settled
timeline, pager, and export metadata share one terminal-safe session actor
label. Run the deterministic handoff with:

```sh
npm run smoke:transcript -w @pinpawo/tui
```

Run the deterministic interactive approval demo without starting the Node host:

```sh
npm run dev:review -w @pinpawo/tui
```

The demo accepts real keyboard navigation, multiline paste/input, submit, and
cancel, then restores focus to the composer.

Run the deterministic command/help demo with the palette already open:

```sh
npm run dev:command -w @pinpawo/tui
```

Only commands implemented by the v2 client are advertised. Slash-prefixed paths
and prose that do not have the exact command shape remain ordinary chat input.
`/new` waits for the host's authoritative new-session ID and empty snapshot
before switching the projection. Outstanding completion snapshots from the
previous session are then discarded.

Run the cross-terminal production-UI QA harness without a host or model account:

```sh
npm run tui:v2 -w pinpawo -- --qa
```

An installed CLI can run the same scenario with
`pinpawo tui --v2 --qa`. The public launcher translates this explicit QA mode
to the TUI's internal deterministic transport while still resolving the normal
workspace, binary, or packaged-bundle launch plan. The entry uses the normal
`main.ts`, composer, fixed footer, native scrollback, timeline renderer, and
Session projection. Its local deterministic transport
preloads enough history to browse, then turns each submitted message into a
timed thinking → operation started/updated/completed → subagent → multi-delta
Markdown → completed response sequence. The final response also supplies
predictable token/context usage. Submit with Enter, use Shift+Enter or `Ctrl+J`
for a newline, browse
native history while events arrive, edit a multiline CJK/emoji draft during
the run, resize, and use Esc to verify interruption. `/quit` exits normally.
The transport is reachable only through the explicit `--qa` flag; normal v2
startup and the default legacy entry remain production paths. Direct workspace
development is still available through `npm run dev:qa -w @pinpawo/tui`.

Studio mode reuses the shared `studio_request`, progress event, review,
interrupt, response, and error protocol. Composer mode and conversation ID stay
view-local; accepted Studio runs, progress, terminal replies, and errors are
projected into the canonical ordered timeline. Run the deterministic Studio PTY
smoke without a host with:

```sh
npm run smoke:studio -w @pinpawo/tui
```

## Phase 1 probes

The original alternate-screen probe remains available with:

```sh
npm run dev:spike -w @pinpawo/tui
```

Run the split-footer capability probe with:

```sh
npm run dev:probe -w @pinpawo/tui
```

`dev:split` remains a compatibility alias. Both commands run an interaction
probe with no local-agent host or session functionality; use `npm run dev -w
@pinpawo/tui` for the production v2 client.

Split-footer commits settled timeline rows to terminal scrollback and keeps only
the live response, composer, and status in the OpenTUI footer. The two probes
exist so Phase 1 can compare internal viewport behavior with the closest
OpenTUI-supported native-scrollback design.

The split-footer probe disables OpenTUI mouse tracking so the terminal retains
touchpad scrolling and native text selection. Mouse editing inside the composer
is intentionally outside this comparison; keyboard editing remains available.
The footer stays at a fixed nine rows so repainting never performs a terminal
scrollback transition. Its composer grows from three to five visible rows by
reclaiming the title and idle-live rows, then scrolls internally for longer
input. A narrow compatibility workaround preserves the preceding newline when
backspacing the last grapheme on an OpenTUI 0.4.5 textarea line.
Its delta probe uses OpenTUI's `ScrollbackSurface`: token updates render into an
off-screen buffer, while only complete rows are committed to terminal
scrollback. The footer therefore does not repaint for every token.

Build the Phase 2 client as a standalone executable with:

```sh
npm run build -w @pinpawo/tui
```

Build the alternate-screen probe with:

```sh
npm run build:spike -w @pinpawo/tui
```

Platform-specific executables are written to `services/tui/dist/`, which is
ignored by Git.

Build the npm distribution payload used by the local-agent package with:

```sh
npm run build:distribution -w @pinpawo/tui
```

This writes `main.js` and a checked `manifest.json` to
`services/local-agent/dist/tui/`. The normal `pinpawo` build runs this step
after the local-agent bundle is created.

Verify that a freshly built bundle can load its external OpenTUI runtime and
execute outside the source entrypoint with:

```sh
npm run test:distribution -w @pinpawo/tui
```

The probe uses the bundle's non-interactive `--version` path, so it is safe in
package and CI environments without a terminal. The `pinpawo` prepublish gate
runs it after building the package.

Run the stronger registry-backed install smoke with:

```sh
npm run test:tui-install -w pinpawo
```

It packs the local agent packages, installs them into an empty project with
normal dependency lifecycle scripts, and exercises the installed
`pinpawo tui --v2 --check` launcher path.

Probe controls:

- `F2`: focus the timeline for keyboard and touchpad scrolling
- `F3`: focus the textarea
- `Ctrl+D`: run a high-frequency streaming-delta burst (stable-row commits in split-footer)
- `Ctrl+T`: append a burst of timeline rows
- Enter: submit the textarea without changing the production agent
- Shift+Enter / `Ctrl+J`: insert a newline
- `Ctrl+C`: exit

Drag one or more files into the terminal while the textarea is focused. The
probe shows whether the terminal delivered the input as bracketed paste or key
input and displays a bounded escaped preview. Spaces appear as `␠`, making the
separator between shell-escaped paths visible. The probe does not parse, read,
or upload files.

Run the native textarea regression with Bun:

```sh
npm run test:native -w @pinpawo/tui
```

Manual results belong in
[`docs/TUI_V2_OPENTUI_CAPABILITY_MATRIX.md`](../../docs/TUI_V2_OPENTUI_CAPABILITY_MATRIX.md).
