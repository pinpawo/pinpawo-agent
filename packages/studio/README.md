# PinPawo Studio

Independent Studio Host/runtime package and executable entry.

It owns the process entry. Concrete Plugins remain externally injected
through `StudioPluginResolver`; Plugin-defined Toolkits enter the Host inventory,
while Agent Capabilities remain independently owned and registered.

Each Pet selects its Agent Capabilities through its conventional directory:

```text
.pinpawo/pets/<petId>/capabilities/<capability>/CAPABILITY.md
```

```bash
npm install --global \
  @pinpawo/studio \
  @pinpawo-plugin/studio-http \
  @pinpawo-plugin/channel \
  @pinpawo-plugin/scheduler \
  @pinpawo-plugin/notice \
  @pinpawo-plugin/project-files \
  @pinpawo-plugin/trigger

WORKDIR=/path/to/project
pinpawo-studio init --workdir "$WORKDIR"
export PINPAWO_STUDIO_TRIGGER_SECRET='choose-a-secret-at-least-16-characters'
pinpawo-studio --workdir "$WORKDIR"
pinpawo-studio --workdir "$WORKDIR" --pet-port 3212

# Connect tiled Pet TUIs to the already-running Host. Read its Pet listener
# port from Host startup output; Pets are discovered through Studio HTTP.
pinpawo-studio tmux --pet-port 3212 --console

# Start the separately served Studio Console Web if needed, then open it
# (default: http://127.0.0.1:5173).
pinpawo-studio console
```

Configured Plugin IDs are installed package names. Each package exposes its
Plugin through `createStudioPlugin()`; Studio core does not import concrete
Plugins. To connect the terminal client to a resident Pet, use the listener port
and Pet ID:

```bash
pinpawo tui --pet-port 3212 --pet-id planner
```

The package also exposes the programmatic Host/runtime API:

```ts
import { StudioHost, runStudioHostProcess } from '@pinpawo/studio';
```

Studio dispatch/event HTTP is provided by the configured HTTP Plugin. The
host Agent Session listener is only for direct conversation with a
resident Pet. The workdir must contain
`.pinpawo/studio.json` and the referenced `.pinpawo/pets/*.json` files.
Each Pet's authored identity and working conventions belong in
`.pinpawo/pets/<petId>/PET.md` (or `<petsDir>/<petId>/PET.md` when using a custom
Pet configuration directory). The Host loads the document at startup; restart
it after changing the document.

Pet JSON retains `petId`, `name`, `modelProfileId` and
`defaultCapabilityName`. The former `role` and `serviceSummary` are removed; no
consumer read them. Move former `personality`, `species` and `stage` values
into PET.md prose and remove those JSON fields. Remove `serverBinding`; the
local Host no longer consumes cloud Pet bindings. The parser reports these
retired fields instead of silently ignoring them. The implicit Pet Profile
Toolkit and cloud profile/history hydration have also been removed; conversation
history remains owned by the session checkpoint. Programmatic resident Hosts use
`petId` and `petName`; optional `traceUserId` is consumed only by Host tracing.
They also receive resolved `HostExecutionConfig` settings from the composing Host;
use `resolveHostExecutionConfig(runtimeConfig, settings)` from `pinpawo/host-runtime`.
Review policy belongs to these Host settings, not to model profiles. A resident's
conversation and dispatch surfaces share subsequent policy updates.

Per-Pet Capability directories are optional. The Host supplies the `general`
fallback only when a Pet does not configure `defaultCapabilityName`.

`pinpawo-studio init` creates the shipped four-Pet configuration, Capabilities,
and initial `wiki/PROJECT.md` in the selected workdir without overwriting
existing files. The package template itself contains no `.pinpawo/` runtime
directory or generated state.

The default template includes an HTTP Trigger for external requests. Set
`PINPAWO_STUDIO_TRIGGER_SECRET` before starting the Host, or replace that
Trigger in the initialized `.pinpawo/studio.json`.
The independent Studio Console remains a separate frontend application. From a
source checkout, `pinpawo-studio console` starts its local development server
when it is not already running, then opens the page. A published Studio CLI can
instead open a separately deployed Console with `pinpawo-studio console --url
<origin>`.

## Retired Kanban configuration

The Kanban Plugin, API, tools, and default task-assignment / task-completion
Trigger rules have been removed. The default template now enables Channel.
Planner returns proposals, Executor and Reviewer return delivery evidence,
and Wiki updates require an explicit request. Dispatch completion does not
imply accepted delivery and does not trigger Wiki maintenance.

Existing projects are not rewritten by startup or `init`. Before restarting an
old workdir, manually remove `@pinpawo-plugin/kanban` from `studio.json`, add the
installed `@pinpawo-plugin/channel` package, remove `wiki-on-task-done` and
`dispatch-assigned-kanban-task`, and update Pet documents / Capabilities against
the current template. Remove all `kanban*` Toolkit bindings and the old
`studio_reporting` Capability that only wrote task state; delivery now uses the
normal public reply. Preserve project-specific instructions while comparing
files. Rewrite the external-request planning prompt if it still requires a board.

Historical `.pinpawo/kanban/` databases, JSON snapshots, task history, and Wiki
files are left untouched. No schema cleanup, automatic migration, or no-op
compatibility Plugin is provided. See the [configuration migration guidance](
../../docs/studio/configuration.md#retired-kanban-workdirs).
