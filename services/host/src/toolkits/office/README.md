# Optional Office Toolkit

Uses the Apache-2.0 [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)
project for DOCX, XLSX and PPTX. No automatic download or installation.

Enable by adding `"office": true` to `capabilities` in
`~/.pinpawo/config.json`, then restart the Host. The default is disabled:
no Office tools or capability are registered, and no executable is checked.
An embedding Host can override with `includeOffice: true` or `false`.

Install or inspect the managed native dependency explicitly:

```sh
pinpawo toolkit status office
pinpawo toolkit install office
```

This downloads iOfficeAI/OfficeCLI **1.0.156** from the official GitHub release,
checks a pinned SHA-256 and atomically writes
`~/.pinpawo/toolkits/office/1.0.156/officecli`. It never executes the downloaded
binary, edits PATH/profile files, starts a Host, or enables the Toolkit.
Repeated installation reports `alreadyInstalled: true` after checksum and
executable checks. Failed HTTP/checksum/install verification exits with an error.
Status reports `installed`, `missing` or `invalid` for the managed dependency,
or `unsupported` on platforms without a pinned release asset. The SHA-256 is
checked by install and status; at run time the Toolkit only checks that the
managed file is executable.
Installation supports macOS arm64/x64; other platforms produce an explicit error.
`--dir <directory>` selects another dependency root; set `PINPAWO_OFFICECLI_PATH`
to its resulting absolute executable path for Host use.

The Toolkit prefers the managed binary, otherwise PATH; an absolute
`PINPAWO_OFFICECLI_PATH` overrides both. Existing approved native installs can
be used without our installer. Do not substitute officecli/officecli-dist.
Enabled but missing dependencies produce an unavailable Toolkit diagnostic.

`office_cli` accepts a command and separate argument strings, for example:

```json
{"command":"create","args":["My Report.docx"]}
```

`args` starts with the document path and never repeats the command. OfficeCLI
rewrites the whole package on each edit, so concurrent calls on one document
silently drop all but the last write; the Toolkit runs all calls except `help`
one at a time (the document cannot be identified reliably from argv, since
OfficeCLI accepts options before the path). Queued time does not count toward
`timeoutSeconds`. Args that repeat the command are rejected without running.
Exit code 2 is reported as status `warning`: it can mean applied with warnings
or, for some usage errors such as `set` without `--prop`, nothing written, so
the model must read back before retrying. With `--json` OfficeCLI exits 0 even
when it applied nothing, so a JSON envelope's `success: false` is reported as
`failed` and non-empty `warnings` as `warning`, overriding the exit code.

Supported commands are help, create, view, get, query, add, set, remove,
validate, close, batch and dump. `batch` must pass `--commands` or `--input`
(stdin is not connected) and may not use `--best-effort` (including `=`/`:` value forms) or `@` response files: the default batch is
atomic, so a failed batch leaves the file byte-identical, while best-effort
keeps partial writes yet still exits 1. Inside a batch an unsupported prop is
only a warning (exit 0). `dump` is read-only and prints replayable batch JSON.

The Toolkit instructions (`OFFICE_TOOLKIT_INSTRUCTIONS`) are a short usage
guide adapted from upstream's Apache-2.0 `SKILL.md` for this Toolkit's argv
form, allowlist and no-resident mode; each claim was checked against 1.0.156.
They are injected into every capability using the Toolkit, so keep them brief.
Upstream's per-format skills are not included.

Every call uses existing command-execution review and ShellRS with a bounded
wait and process-group termination on timeout. There is no shell interpolation.
The model chooses its operations; no fixed workflow or roles are introduced.

Files are ordinary local output files, with paths reported to the user.
This adds no PDF/OCR, preview system, artifact protocol or filesystem sandbox.
Calls disable automatic install, update checks and auto-started residents via
upstream environment flags. Existing residents started outside this Toolkit
remain owned by OfficeCLI; use independent files and close before delivery.
The Toolkit has no independent state or job store.

Tests cover opt-in, missing executable, argv/paths with spaces, execution
failure, batch restrictions, timeout and cancellation. Actual format roundtrips
require the approved OfficeCLI binary; mock execution tests do not establish
document fidelity.

Source review: npm registry `@officecli/officecli@1.0.156` points to
`iOfficeAI/OfficeCLI`; its release source is
`699cafbc8f0b8a7841c6cca53dafd0c24e982f56`. The official npm shim may download
a missing native binary at first launch, so this Toolkit resolves only its
already-installed `vendor/officecli`; missing vendor binaries are unavailable.
Availability checks executable presence, not identity, version or format fidelity.
Use an explicitly approved native binary; real format roundtrips are still
required before claiming OfficeCLI compatibility is fully validated.
