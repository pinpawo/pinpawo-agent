# TUI v2 OpenTUI Phase 1 capability matrix

Issue: #454  
Package: `services/tui`  
Framework: `@opentui/core` 0.4.5  
Runtime target: Bun 1.3.14

## Purpose

This spike validates the terminal-dependent risks before the production TUI is
migrated. It is not a replacement for the existing Ink TUI and does not connect
to the local-agent host.

The probe covers:

- OpenTUI `ScrollBoxRenderable` sticky-bottom and browse behavior;
- split-footer settled output in terminal scrollback with a live footer;
- terminal-owned wheel and selection input in split-footer mode;
- split-footer streaming through `ScrollbackSurface` stable-row commits;
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
| canonical timeline order | message/operation/message order is retained | automated test |
| operation raw payload | shared projection retains transient raw data | automated test |
| high-frequency delta projection | one streaming entry is updated in place | automated test |
| raw input preview | controls are escaped and output is bounded | automated test |
| fixed-footer composer layout | composer grows from 3–5 visible rows without changing terminal footer height | automated test |
| native textarea regression | multiline paste and single-grapheme backspace preserve line boundaries | Bun native test |
| TypeScript | `npm run typecheck -w @pinpawo/tui` | passed |
| unit tests | `npm run test -w @pinpawo/tui` | passed, 9 tests |
| native tests | `npm run test:native -w @pinpawo/tui` | passed, 1 test |
| alternate-screen PTY startup | `npm run smoke -w @pinpawo/tui` | passed in an automated 80×24 PTY |
| split-footer PTY startup | `npm run smoke:split -w @pinpawo/tui` | passed in an automated 80×24 PTY |
| standalone executable | `npm run build:spike -w @pinpawo/tui` | passed for darwin-arm64; compiled PTY smoke passed |
| root typecheck | `npm run typecheck` | passed |
| root tests | `npm test` | passed, including local-agent 717/717 and Chrome extension 22/22 |
| root build | `npm run build` | passed |

## Manual terminal matrix

Use the same checklist in each terminal. Do not mark a capability supported
from an automated PTY run alone.

| Capability | macOS Terminal | iTerm2 | Ghostty | Integrated terminal |
| --- | --- | --- | --- | --- |
| touchpad scroll while timeline focused | pending | pending | passed | pending |
| browse position survives incoming rows | pending | pending | passed | pending |
| scrolling back to bottom resumes sticky follow | pending | pending | pending | pending |
| terminal/app text selection and copy | pending | pending | passed | pending |
| multiline edit and soft wrap | pending | pending | passed | pending |
| Shift selection and deletion | pending | pending | pending | pending |
| undo/redo | pending | pending | pending | pending |
| bracketed multiline paste is not submitted | pending | pending | passed | pending |
| CJK and emoji cursor alignment | pending | pending | pending | pending |
| Chinese IME composition | pending | pending | pending | pending |
| absolute path drag-in sequence | pending | pending | passed | pending |
| quoted/escaped multi-path drag-in sequence | pending | pending | delivered; parsing pending | pending |
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
| multi-file drag-in | Ghostty delivers shell-style path text, but the original preview did not distinguish escaped spaces from path separators | partial; spaces now render as `␠`, structured attachment parsing remains Phase 2 |
| resize | committed scrollback and footer layout became visually inconsistent | partial; fixed footer avoids app-driven height transitions, but committed terminal scrollback remains terminal-owned |
| dynamic composer height | changing `renderer.footerHeight` left old footer frames in Ghostty scrollback | failed; composer now reclaims title/live rows inside a fixed eight-row footer |

The final Ghostty retest confirmed multiline growth, multiline paste, resize,
and the fixed-footer repaint behavior. Existing committed scrollback remains
terminal-owned by design, so the spike does not destructively replay it after
resize.

## Phase 1 decision

The production direction is the split-footer model:

- completed timeline rows are committed to native terminal scrollback through
  `ScrollbackSurface`;
- OpenTUI mouse tracking stays disabled so touchpad scrolling, selection, and
  copy remain terminal-owned;
- live state and the composer occupy a fixed eight-row footer;
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
- paths delivered by drag-in remain raw composer text in this spike; structured
  path parsing and removable attachment UI belong to Phase 2;
- IME, key mapping, and repaint behavior still require dogfood in macOS
  Terminal and iTerm2 before the new TUI becomes the default.

## Procedure

1. Run `npm run dev -w @pinpawo/tui`.
2. Press `F2`, browse upward with the touchpad, then press `Ctrl+T`.
3. Confirm the viewport remains anchored while 250 rows are added.
4. Return to the bottom and press `Ctrl+D`; confirm sticky follow resumes.
5. Select timeline text and copy it using the terminal's normal workflow.
6. Press `F3` and test multiline input, soft wrap, selection, deletion,
   undo/redo, CJK, emoji, and IME.
7. Paste multiple lines and confirm no accidental submit occurs.
8. Drag a path with spaces, a Unicode path, and multiple files into the
   textarea. Record whether the status line reports `key:` or `paste:` and copy
   the escaped preview into this document.
9. Resize the terminal while editing and while browsing history.
10. Repeat the selection, scroll, resize, paste, IME, and burst checks with
    `npm run dev:split -w @pinpawo/tui`. Compare native terminal scrollback
    against the alternate-screen internal viewport.

## Decision gate

The Phase 1 architecture decision is complete based on automated PTY coverage,
Ghostty manual testing, and the integrated-terminal probes above. Phase 2 may
start with the split-footer model.

The remaining macOS Terminal and iTerm2 matrix is a dogfood and release gate,
not an implementation blocker. Any unsupported critical capability still needs
a documented fallback before TUI v2 replaces the existing Ink client.
