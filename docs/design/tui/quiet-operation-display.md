# Quiet operation display

Status: Draft — 2026-10-01

The running TUI should make the current task, activity and need for user input
easy to find. Long shell commands, successful output previews and authorization
explanations currently dominate the transcript.

## Presentation boundary

- The canonical session timeline is unchanged. No events or raw payloads are
  removed from the session.
- Successful tools render as one neutral receipt row. Patch diffs keep their
  existing bounded preview. Failures retain a bounded error preview.
  Completed invocations returning explicit error payloads (`Error:`, `ok: false`,
  `success: false`, or error/timeout/spawn-failed status) also keep diagnostics.
- Successful authorization renders as one muted row. Its tool list and reason
  remain available in the PageUp transcript pager.
- Compact tool titles show the tool identity and target or command, with a
  104-column ceiling. Shell titles prefer the command over cwd; a leading
  `cd <directory> &&` is omitted only from the compact label. Absolute file paths
  may show their last three segments. Full canonical inputs and display metadata
  remain in the pager, including complete output and errors.
- Settled tools use a check mark; active tools use cyan and errors remain red.
  Ordinary tool rows have no extra blank row between them. Conversation messages
  and task headings retain their spacing.
- The live footer names the activity and explicitly labels elapsed time as the
  whole run's time. Streamed answer text is shown in the transcript only.
- The composer explains drafting and interruption. Its idle hint exposes PageUp.
  Plan headings name the current item index and its active/pending state rather
  than presenting a fraction that can look like completion.

## Limits

This is a presentation change, not a new authorization policy or operation
summary contract. Compact labels do not infer an operation's intent from arbitrary
shell syntax. The pager can only show data present in the current session snapshot;
it does not reconstruct raw results missing from older checkpoints. The Markdown
conversation export remains unchanged.

Dynamic collapsing or regrouping committed terminal scrollback is deferred.
It would need explicit replay behavior and keyboard navigation. This pass keeps
the existing append-only settlement and delegation ordering.

## Validation

Check one-line success and authorization receipts, preserved errors and patch
diffs, complete pager detail, control-character sanitization, narrow/CJK footer
width, plan state labels, and native OpenTUI rendering at wide and narrow sizes.
