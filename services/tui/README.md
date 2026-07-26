# `@pinpawo/tui`

OpenTUI-based TUI v2 client.

The current package is the Phase 1 technical spike from issue #454. It is
deliberately isolated from the production CLI:

- it imports the canonical projection from `@pinpawo/agent-session`;
- it does not import `services/local-agent/src/*`;
- it does not replace or delegate the existing `pinpawo-agent tui` command;
- it exercises OpenTUI scrolling, textarea editing, paste/raw input, selection,
  resize, and high-frequency timeline updates.

## Run the spike

Install Bun, then from the repository root:

```sh
npm install
npm run dev -w @pinpawo/tui
```

The default probe uses an alternate-screen `ScrollBoxRenderable`. Run the
split-footer comparison with:

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
The composer grows from one to eight content rows for explicit newlines and
soft wrapping. A narrow compatibility workaround preserves the preceding
newline when backspacing the last grapheme on an OpenTUI 0.4.5 textarea line.
Its delta probe uses OpenTUI's `ScrollbackSurface`: token updates render into an
off-screen buffer, while only complete rows are committed to terminal
scrollback. The footer therefore does not repaint for every token.

Build the alternate-screen probe as a standalone executable with:

```sh
npm run build:spike -w @pinpawo/tui
```

The platform-specific executable is written to `services/tui/dist/`, which is
ignored by Git.

Useful controls:

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
