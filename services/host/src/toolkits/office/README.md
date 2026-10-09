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
Status reports `installed`, `missing` or `invalid` for the managed dependency.
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

Use `help` to discover the installed version's syntax. Supported commands are
help, create, view, get, query, add, set, remove, validate and close.
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
failure, timeout and cancellation. Actual format roundtrips require the approved
OfficeCLI binary; mock execution tests do not establish document fidelity.

Source review: npm registry `@officecli/officecli@1.0.156` points to
`iOfficeAI/OfficeCLI`; its release source is
`699cafbc8f0b8a7841c6cca53dafd0c24e982f56`. The official npm shim may download
a missing native binary at first launch, so this Toolkit resolves only its
already-installed `vendor/officecli`; missing vendor binaries are unavailable.
Availability checks executable presence, not identity, version or format fidelity.
Use an explicitly approved native binary; real format roundtrips are still
required before claiming OfficeCLI compatibility is fully validated.
