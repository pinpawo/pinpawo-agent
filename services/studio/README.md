# PinPawo Studio

Complete Studio distribution and executable entry, including HTTP, Channel, Scheduler, Notice, Project Files, and Trigger Plugins.

It depends on the independent `@pinpawo/studio-core` and all six foundational
Plugin packages. The core imports no concrete Plugins. Plugins are resolved
through `StudioPluginResolver`; Plugin-defined Toolkits enter the Host inventory,
while Agent Capabilities remain independently owned and registered.

Each Pet selects its Agent Capabilities through its conventional directory:

```text
.pinpawo/pets/<petId>/capabilities/<capability>/CAPABILITY.md
```

```bash
npm install --global @pinpawo/studio

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
Plugin through `createStudioPlugin()`; Studio Core does not import concrete
Plugins. To connect the terminal client to a resident Pet, use the listener port
and Pet ID:

```bash
pinpawo tui --pet-port 3212 --pet-id executor
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

Pet JSON and directory rules are defined in [Studio configuration](../../docs/studio/configuration.md).
Keep identity and working conventions in PET.md, execution responsibilities in
CAPABILITY.md, and machine settings in JSON. Programmatic resident Hosts receive
resolved Host settings through `resolveHostExecutionConfig()` from
`pinpawo/host-runtime`; review policy belongs to those settings, not model profiles.

Per-Pet Capability directories are optional. The Host supplies the `general`
fallback only when a Pet does not configure `defaultCapabilityName`.

`pinpawo-studio init` creates the shipped three-Pet configuration and Capabilities
in the selected workdir, and an initial `PROJECT.md` in a separate durable Studio
knowledge directory (`~/.pinpawo/studios/<random-uuid>/wiki/`). The absolute path
is stored in the Project Files Plugin's `wikiDirectory` option and printed by init.
Existing files are not overwritten. The package template itself contains no
`.pinpawo/` runtime directory or generated state.

The default template includes an HTTP Trigger for external requests. Set
`PINPAWO_STUDIO_TRIGGER_SECRET` before starting the Host, or replace that
Trigger in the initialized `.pinpawo/studio.json`.
The independent Studio Console remains a separate frontend application. From a
source checkout, `pinpawo-studio console` starts its local development server
when it is not already running, then opens the page. A published Studio CLI can
instead open a separately deployed Console with `pinpawo-studio console --url
<origin>`.

## Channel and migration

The default template enables Channel: a conversation among human and Pet members.
Its [model](../../docs/design/studio/channel-model.md) and [addressing design](../../docs/design/studio/channel-addressing-and-execution.md)
explain membership, member handoff, Reply defaults, trusted input and fixed sessions.
Channels stored by earlier versions are not migrated. Wiki maintenance requires an
explicit request; dispatch completion is not acceptance.

Existing workdirs are never rewritten by startup or `init`. Follow the single
[configuration migration guide](../../docs/studio/configuration.md#retired-kanban-workdirs),
preserving local instructions and historical databases, snapshots and Wiki files.

## Operate a running Host

The same Node.js CLI provides HTTP operator commands. These commands do not
start a Host, open Console, or connect an exclusive TUI client:

```sh
pinpawo-studio channels list
pinpawo-studio channels create --title "Release" --pet executor --pet reviewer
pinpawo-studio channels read CHANNEL_ID --after 0 --limit 50
pinpawo-studio channels members CHANNEL_ID
pinpawo-studio channels add-member CHANNEL_ID --member pet:wiki
pinpawo-studio channels send CHANNEL_ID --file message.md --mention PARTICIPANT_ID
pinpawo-studio channels sessions CHANNEL_ID
pinpawo-studio queues
pinpawo-studio pets
pinpawo-studio snapshot executor --full
pinpawo-studio events executor --seconds 30
pinpawo-studio dispatch executor --file task.txt
pinpawo-studio send executor --file command.json
```

`--studio-url`, `--agent-url`, and `--token-file` select the already-running
Host and existing Bearer authority. Defaults are `http://127.0.0.1:3211`,
`http://127.0.0.1:3212`, and `~/.pinpawo/local-server-token`. Connection flags
may precede or follow operator commands; `--file -` reads stdin. Repeat
`--mention` for current members' participant IDs; `--reply-to` supplies a message
reference. `channels --help` lists the operator command contract.

Output is JSON, with bounded live SSE observations emitted as JSON lines.
Reads return one page and preserve `nextAfter`/`hasMore`; `channels read`
starts from the newest messages and also returns `nextBefore`/`hasEarlier`.
Commands do not retry. Dispatch accepts an optional `--idempotency-key`, scoped
by the Host's process-local admission contract; Channel sends create a new
message each time. Saved/accepted/completed does not establish acceptance.

The [Studio skill](../../skills/studio/SKILL.md) explains operator workflows,
identity resolution and review boundaries. Its former Python helper has been
replaced by these CLI commands; no Python runtime is required. Pet Capability
and Channel Toolkit ownership is unchanged. HTTP protocols remain defined in
[Studio API](../../docs/reference/api/studio.md).
