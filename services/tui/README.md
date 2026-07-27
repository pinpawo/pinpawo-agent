# `@pinpawo/tui`

OpenTUI-based TUI v2 client.

The package now contains the Phase 2–4 vertical slice from issue #454. It is
deliberately isolated from the production CLI while the migration is in
progress:

- it imports the canonical projection from `@pinpawo/agent-session`;
- it does not import `services/local-agent/src/*`;
- it does not replace or delegate the existing `pinpawo-agent tui` command;
- it connects to the authenticated loopback local-agent WebSocket;
- it loads one canonical Session snapshot, consumes live runtime events, and
  submits chat messages through the shared protocol;
- it renders settled timeline entries into terminal-native scrollback and keeps
  streaming state in an OpenTUI scrollback surface;
- it commits completed visual rows during streaming without pulling terminal
  wheel/selection ownership into the app;
- it recognizes pasted or dragged local paths as removable attachments without
  reading or uploading file contents.
- it lists and resumes host sessions through the shared protocol in an
  OpenTUI-owned footer overlay, while keeping picker state outside the canonical
  Session projection.
- it restores canonical pending reviews from snapshots and provides an
  OpenTUI-owned approval overlay for single or batched approve, reject, respond,
  and cancel flows.
- it provides a cursor-aware slash command palette and pageable help overlay
  for the commands currently implemented by the v2 client.
- it commits a borderless, terminal-rasterized paw welcome with the v2 package
  version before the first timeline rows.
- it keeps run/connection state and session token/context facts in a compact
  two-line status area, with width-priority degradation.
- it gives interrupting and connection/local errors an input-owning notice
  overlay instead of leaving them as easy-to-miss composer text.

## Run the vertical slice

Install Bun and dependencies. Start the Node host in one terminal:

```sh
npm install
npm run start -w pinpawo -- run
```

Then start the OpenTUI client from the repository root in another terminal:

```sh
npm run dev -w @pinpawo/tui
```

The client reads `LOCAL_SERVER_PORT` (default `3210`) and the bearer token
written by the host to `~/.pinpawo/local-server-token`. It will synchronize the
active Session before enabling submission and will reconnect with bounded
backoff if the host disappears.

Production client controls:

- `Ctrl+Enter` submits the composer;
- dragging or pasting one or more absolute local paths creates attachment chips;
- Backspace removes the last attachment while the composer text is empty;
- `Ctrl+R` or an exact `/resume` command opens the session picker;
- `↑`/`↓`, `PageUp`/`PageDown`, and Enter navigate and resume a session; Esc
  closes the picker without changing the composer draft;
- while an approval is open, `↑`/`↓` selects a decision, PageUp/PageDown pages
  the review details, Enter submits, and Esc cancels the pending review;
- a text-response option owns a separate multiline textarea; Shift+Enter inserts
  a newline while Enter submits, and the normal composer draft remains intact;
- typing `/` at the end of an attachment-free composer opens the command
  palette; `↑`/`↓` selects, Tab completes, Enter executes, and Esc clears it;
- `/help` opens pageable command and shortcut help, `/new` starts a clean chat
  projection, `/resume` opens the session picker, and `/quit` exits;
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

The resume overlay defaults to the newest inactive session so Enter does not
accidentally reload the current one. A successful switch clears the old draft
and attachments only after the host returns the selected canonical snapshot.
Late completion snapshots from the previous session are ignored.

Approval selection, paging, batch decisions, and text drafts are local overlay
state rather than Session projection fields. The controller validates each
response against the currently focused canonical review action before sending
`human_review_response` or `review.cancel`. A disconnect or missing canonical
state transition releases the submitting lock so the user can retry.

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

## Phase 1 probes

The original alternate-screen probe remains available with:

```sh
npm run dev:spike -w @pinpawo/tui
```

Run the split-footer capability probe with:

```sh
npm run dev:split -w @pinpawo/tui
```

Split-footer commits settled timeline rows to terminal scrollback and keeps only
the live response, composer, and status in the OpenTUI footer. The two probes
exist so Phase 1 can compare internal viewport behavior with the closest
OpenTUI-supported native-scrollback design.

The split-footer probe disables OpenTUI mouse tracking so the terminal retains
touchpad scrolling and native text selection. Mouse editing inside the composer
is intentionally outside this comparison; keyboard editing remains available.
The footer stays at a fixed eight rows so repainting never performs a terminal
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

Probe controls:

- `F2`: focus the timeline for keyboard and touchpad scrolling
- `F3`: focus the textarea
- `Ctrl+D`: run a high-frequency streaming-delta burst (stable-row commits in split-footer)
- `Ctrl+T`: append a burst of timeline rows
- `Ctrl+Enter`: submit the textarea without changing the production agent
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
