# PinPawo Studio

Complete Studio distribution and executable entry, including HTTP, Channel, Scheduler, Notice, Project Files, and Trigger Plugins.

It depends on the independent `@pinpawo/studio-core` and all six foundational
Plugin packages. The core imports no concrete Plugins. Plugins are resolved
through `StudioPluginResolver`; Plugin-defined Toolkits enter the Host inventory,
while Agent Capabilities remain independently owned and registered.

Each Pet definition selects its Agent Capabilities through its conventional directory:

```text
.pinpawo/pets/<definitionId>/capabilities/<capability>/CAPABILITY.md
```

```bash
npm install --global @pinpawo/studio

WORKDIR=/path/to/project
pinpawo-studio init --workdir "$WORKDIR"
# Keep the Host running in this terminal; --pet-port is optional.
pinpawo-studio --workdir "$WORKDIR" --pet-port 3212
```

In another terminal, open the standalone Console first. From a source checkout,
this command starts its server if needed (default: `http://127.0.0.1:5173`). For a
separately deployed Console, add `--url <origin>`.

```bash
pinpawo-studio console
```

The Host and standalone Console work with no Pet instances. Create a Channel and
its instances in Console using the local Host token, or use the
[operator commands](#operate-a-running-host) below. Once at least one instance
exists, connect tiled Pet TUIs to the running Host:

```bash
# Use the Pet listener port printed by Host startup; discovery uses Studio HTTP.
pinpawo-studio tmux --pet-port 3212 --console
```

On a fresh Studio, `tmux --console` rejects empty Pet discovery before opening
Console. Use the standalone `console` command for first-time setup.

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
`.pinpawo/pets/<definitionId>/PET.md` (or `<petsDir>/<definitionId>/PET.md` with
a custom Pet configuration directory). The Host loads the document at startup; restart
it after changing the document.

Pet JSON and directory rules are defined in [Studio configuration](../../docs/studio/configuration.md).
Keep identity and working conventions in PET.md, execution responsibilities in
CAPABILITY.md, and machine settings in JSON. Programmatic resident Hosts receive
resolved Host settings through `resolveHostExecutionConfig()` from
`pinpawo/host-runtime`; review policy belongs to those settings, not model profiles.

Per-Pet Capability directories are optional. The Host supplies the `general`
fallback when `defaultCapabilityName` is omitted or set to `general`. Shared
definitions live in `.pinpawo/capabilities/` and are selected explicitly by each
Pet JSON's `sharedCapabilities` list; installing a Plugin does not add Capabilities.

`pinpawo-studio init` creates the shipped Issuer, Executor, Reviewer and Wiki definitions and Capabilities
in the selected workdir, and an initial `PROJECT.md` in a separate durable Studio
knowledge directory (`~/.pinpawo/studios/<random-uuid>/wiki/`). The absolute path
is stored in the Project Files Plugin's `wikiDirectory` option and printed by init.
When the selected workdir is a non-Git home directory, the default remains under
`~/.pinpawo/studios`. For other workdirs, the data root must be outside the workdir;
a home directory inside a Git worktree also requires an external data root. In those
cases, select a parent with `pinpawo-studio init --workdir "$HOME" --studio-data-root /path/outside/home/studio-data`.
This option applies only to initialization; the resulting absolute Wiki path is stored
in the Studio configuration.
Existing files are not overwritten. Init installs definitions, not Pet instances.
Create an empty Channel, then create its instances as shown below. The package
template itself contains no `.pinpawo/` runtime directory or generated state.

The default template enables the Trigger Plugin with no Triggers. A Trigger runs
its Pet in its owner Channel, so create the Channel and that Pet instance first.
Then add the Trigger with the instance's `petId` and `channelId` to `.pinpawo/studio.json`.
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
The [Pet ownership upgrade limit](../../docs/studio/configuration.md#pet-instance-setup)
requires a fresh database or an earlier database with no Pet rows; populated
pre-ownership databases remain on the previous version.

## Operate a running Host

The same Node.js CLI provides HTTP operator commands. These commands do not
start a Host, open Console, or connect an exclusive TUI client:

```sh
pinpawo-studio channels list
pinpawo-studio channels create --title "Release"
# Use channel.channelId from the result as CHANNEL_ID.
pinpawo-studio pets definitions
pinpawo-studio pets create executor --definition executor --name Executor --channel CHANNEL_ID
pinpawo-studio pets create reviewer --definition reviewer --name Reviewer --channel CHANNEL_ID
pinpawo-studio channels read CHANNEL_ID --after 0 --limit 50
pinpawo-studio channels members CHANNEL_ID
# alice must already be a registered, active Studio client.
pinpawo-studio channels add-member CHANNEL_ID --member human:alice
pinpawo-studio channels send CHANNEL_ID --file message.md --mention PARTICIPANT_ID
pinpawo-studio channels sessions CHANNEL_ID
pinpawo-studio queues
pinpawo-studio pets list
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

The local Host token is required to list definitions or create instances. Client
keys may use Channel commands and live-only `pets list`. Each Pet has one immutable
owner Channel; reuse its definition with a new `petId` for another Channel.
`channels add-member` manages humans.

Close is temporary; Reopen restores the same identity, owner, sessions and
credentials. Remove is permanent and never permits id reuse. After explicit
consent to stop current work and cancel unstarted queued tasks, use:

```sh
pinpawo-studio pets close executor --confirm-stop
pinpawo-studio pets records
pinpawo-studio pets reopen executor
# Permanent removal; alternatively use channels remove-member with --confirm-stop.
pinpawo-studio pets remove executor --confirm-stop
```

For a resident instance, both Close and Remove require this stop confirmation.
The backend stops business work, then saves the final state in the same operation.
Failed or uncertain stop is not success; neither operation answers or resumes
pending reviews. Both retain history. Normal Studio restart restores only open,
unremoved instances. `pets records` is local-authority-only and includes closed
and removed identities; closed-session inspection remains deferred.

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
