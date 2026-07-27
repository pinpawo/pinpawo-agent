# `@pinpawo/tui`

OpenTUI-based TUI v2 client.

The package now contains the Phase 2 vertical slice from issue #454. It is
deliberately isolated from the production CLI while the migration is in
progress:

- it imports the canonical projection from `@pinpawo/agent-session`;
- it does not import `services/local-agent/src/*`;
- it does not replace or delegate the existing `pinpawo-agent tui` command;
- it connects to the authenticated loopback local-agent WebSocket;
- it loads one canonical Session snapshot, consumes live runtime events, and
  submits chat messages through the shared protocol;
- it renders settled timeline entries into terminal-native scrollback and keeps
  streaming state in an OpenTUI scrollback surface.

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

`Ctrl+Enter` submits the composer. `Ctrl+C` exits the client.

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
