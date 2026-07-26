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
| TypeScript | `npm run typecheck -w @pinpawo/tui` | passed |
| unit tests | `npm run test -w @pinpawo/tui` | passed, 6 tests |
| alternate-screen PTY startup | `npm run smoke -w @pinpawo/tui` | passed in an automated 80×24 PTY |
| split-footer PTY startup | `npm run smoke:split -w @pinpawo/tui` | passed in an automated 80×24 PTY |
| standalone executable | `npm run build:spike -w @pinpawo/tui` | passed for darwin-arm64; compiled PTY smoke passed |

## Manual terminal matrix

Use the same checklist in each terminal. Do not mark a capability supported
from an automated PTY run alone.

| Capability | macOS Terminal | iTerm2 | Integrated terminal |
| --- | --- | --- | --- |
| touchpad scroll while timeline focused | pending | pending | pending |
| browse position survives incoming rows | pending | pending | pending |
| scrolling back to bottom resumes sticky follow | pending | pending | pending |
| terminal/app text selection and copy | pending | pending | pending |
| multiline edit and soft wrap | pending | pending | pending |
| Shift selection and deletion | pending | pending | pending |
| undo/redo | pending | pending | pending |
| bracketed multiline paste is not submitted | pending | pending | pending |
| CJK and emoji cursor alignment | pending | pending | pending |
| Chinese IME composition | pending | pending | pending |
| absolute path drag-in sequence | pending | pending | pending |
| quoted/escaped multi-path drag-in sequence | pending | pending | pending |
| resize during editing and browsing | pending | pending | pending |
| 250-row append burst | pending | pending | pending |
| 400-update delta burst | pending | pending | pending |

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

Phase 2 may start after at least macOS Terminal, iTerm2, and one integrated
terminal have results for the checklist above. Any unsupported critical
capability must have a documented fallback before the production client is
implemented.
