# Studio Configuration

[简体中文](../zh-CN/studio/configuration.md)

> **Status: current local-host configuration.** The schemas are in
> [`packages/studio/src/configSchema.ts`](../../packages/studio/src/configSchema.ts)
> and Host assembly is in
> [`packages/studio/src/host/buildStudio.ts`](../../packages/studio/src/host/buildStudio.ts).

One workdir has one Studio configuration at
`<workdir>/.pinpawo/studio.json`. Pet files live beside it in
`<workdir>/.pinpawo/pets/<petId>.json`. Each Pet owns a conventional
Capability collection at
`<workdir>/.pinpawo/pets/<petId>/capabilities/`. A Pet can also define stable,
cross-Capability behavior in `<workdir>/.pinpawo/pets/<petId>/PET.md`.

## `studio.json`

```json
{
  "studioId": "content-studio",
  "name": "Content Studio",
  "description": "A drafting and review workflow",
  "entryPetId": "writer",
  "pets": ["writer", "reviewer"],
  "plugins": [
    { "id": "@pinpawo-plugin/studio-http", "options": { "port": 3211 } },
    { "id": "@pinpawo-plugin/channel" },
    { "id": "@pinpawo-plugin/project-files", "options": { "wikiDirectory": "/home/user/.pinpawo/studios/example-uuid/wiki" } }
  ]
}
```

| Field | Required | Meaning |
|---|---:|---|
| `studioId` | Yes | Stable name for this Studio instance. |
| `entryPetId` | Yes | Default target for an external request. It has no other privilege. |
| `pets` | Yes | Non-empty ordered list of referenced pet IDs. |
| `name`, `description` | No | Display metadata. |
| `plugins` | No | Explicit plugin list; order is plugin start order. |
| `plugins[].id` | When a Plugin is listed | Installed Plugin package name resolved by `StudioPluginResolver`. |
| `plugins[].options` | No | Opaque object passed to that Plugin resolver. |
| `storage` | No | Where Plugins keep data. Default `{ "kind": "sqlite", "path": ".pinpawo/studio/studio.sqlite" }` (path relative to the workdir). Postgres: `{ "kind": "postgres", "urlEnv": "PINPAWO_STUDIO_DATABASE_URL" }` or `{ "kind": "postgres", "url": "postgres://…" }`. See [Studio storage](../design/studio/storage.md). |
| `credentials` | No | `{ "keyFile": "/abs/path/credentials.key" }`: the key (32 bytes, base64, mode 0600) that encrypts Pet credentials. `pinpawo-studio init` creates it in the Studio data directory. Without it Pet credentials are locked. See [Pet credentials](../design/studio/pet-credentials.md). |

The configuration rejects an empty or duplicate `pets` list, an entry pet that
is not listed, or a referenced pet file that is missing. A configured Plugin
fails fast when no resolver is installed or the resolver cannot resolve it.
`plugins` may be omitted for manual host dispatch, but no plugin will then drive
workflow progress. Extra legacy fields are not a migration mechanism and should
be removed; in particular, do not use `plannerPetId`, `agents`, queue, retry,
or scheduler fields.

The same Plugin ID may appear more than once with different options. Each
resolved Plugin instance must still expose a unique `name`, because that name
is its lifecycle and event-source identity inside Studio.

## Pet configuration

```json
{
  "petId": "writer",
  "name": "Writer",
  "modelProfileId": "qwen-max",
  "defaultCapabilityName": "drafting"
}
```

`petId` and `name` are required. `petId` must be one safe path segment because
it also identifies the Pet's Capability directory. `general` is the default
Capability only when `defaultCapabilityName` is omitted; an explicit default
selects from that Pet's Capability directory instead.
`modelProfileId` selects a host model profile when present. The old inline
`model` field and the old `capabilities` name list are rejected explicitly.
`defaultCapabilityName` marks one available Capability as the preferred default
in the Supervisor's compact routing manifest. Its complete document still uses the
same discovery path as every other Capability, and the setting does not bypass
availability or Toolkit binding.

The former `personality`, `species` and `stage` fields are rejected with guidance
to move their authored content into `PET.md`. `serverBinding` is also rejected:
there is no active cloud Pet synchronization consumer. The implicit Pet Profile
Toolkit and cloud memory/history hydration have been removed. Conversation
history remains owned by session checkpoints. The former `role` and
`serviceSummary` fields are removed; no consumer ever read them.

## Per-Pet root document

`PET.md` is the conventional, optional root document for one Pet:

```text
<workdir>/.pinpawo/pets/writer/PET.md
```

Studio owns this per-Pet location. The ordinary single-Pet Chat Host resolves
the same document contract from `<workdir>/PET.md`; the agent receives a
`PetDocument` and does not interpret either filesystem convention.

PET.md defines identity, responsibilities, principles and durable conventions;
CAPABILITY.md owns executable responsibilities and Toolkit dependencies, JSON owns
machine settings, and repository AGENTS.md owns project development rules.
The full model-scope contract is in [Pet root document](../design/pet-document.md).
Studio snapshots PET.md at startup; restart after edits. Tools and Capabilities
still come from the compiled registry, and framework security remains authoritative.

## Per-Pet Capability directory

The Pet directory selects its own Capabilities. Configured Plugins may also
supply shared Capability definitions to the Host. No additional directory
configuration or name allowlist is required:

```text
<workdir>/.pinpawo/pets/writer/capabilities/
├── explore/
│   └── CAPABILITY.md
└── drafting/
    └── CAPABILITY.md
```

Every immediate child must be a valid Capability directory. Invalid documents
or duplicate Capability names fail Host startup. Directory symlinks are allowed,
so multiple Pets can select one shared Capability without copying it. Capability
names are scoped per Pet: two Pets may load different definitions with the same
name, while duplicates inside one Pet remain an error. The Host merges Plugin
Capabilities into each Pet's catalog. A Pet-local definition with the same name
takes precedence, preserving existing customizations. Conflicting Plugin names
and attempts to replace the Host's `general` Capability fail startup. These
shared definitions still use the Agent's normal Toolkit binding and execution.

The Host merges normal Toolkits and Toolkits defined by configured Studio Plugins
into its unified Toolkit inventory. Each loaded Capability's `uses` declaration
selects the tools available to that Pet. A Toolkit such as `channel` is therefore
named in `CAPABILITY.md` under `uses`, never in Pet JSON.

Run `pinpawo-studio init --workdir <directory>` to create the initial layout in
a selected project. The default Studio data root is `~/.pinpawo/studios`. A non-Git
home workdir may use this default; otherwise the data root must be outside the workdir.
If the default is inside a workdir, use `--studio-data-root <directory>` to choose a
parent outside it. The selected absolute Wiki path is stored in the configuration; the
option is only needed at initialization. The package ships its source template under
`packages/studio/templates/default/`; it is not itself a runnable workdir.

The default template includes Issuer, Executor, Reviewer and Wiki definitions in
`studio.json`'s `definitions` list. Their JSON files use the existing
`pets/<definitionId>.json` layout; each role's PET.md and dedicated Capabilities
live in `pets/<definitionId>/`. Issuer uses `studio_issue` as its default and
retains the shared files, shell, web, git, github and channel Toolkits.

Loading a definition does not create a Pet instance or add it to a Channel.
Create an instance explicitly, for example
`pinpawo-studio pets create issuer --definition issuer --name Issuer`, then add
it to the intended Channel. Existing workdirs are not upgraded by initialization;
copy missing definitions and merge the `definitions` list while preserving local
customizations, then restart the Host. Role definitions do not grant Issue write
permissions or configure a polling schedule.

## Plugin assembly

`@pinpawo/studio-core` declares a `StudioPluginResolver` port but contains no concrete
Plugin registry and imports no concrete Plugin. The standalone CLI resolves an
explicit package name from `plugins[].id` and requires that installed package to
export `createStudioPlugin(options, environment)`. Embedded callers can replace
that resolver entirely. Options pass through unchanged for the Plugin to validate.
Installing the complete `@pinpawo/studio` distribution automatically installs
its six foundational Plugin dependencies. Additional configured Plugins must be
installed separately; configuration does not download packages at startup.

`@pinpawo-plugin/channel` owns Channels, their members, message history and fixed
Channel/Pet sessions. Its data lives in the Studio database (`storage`);
Channels stored by earlier versions in `channels.sqlite` or `channels-v2.sqlite` are not migrated or shown.
`@pinpawo-plugin/scheduler` also keeps its schedules in the Studio database and no longer takes a
`databasePath` option; schedules in an earlier `scheduler.sqlite` are not migrated.
Its [current design](../design/studio/channel-addressing-and-execution.md) specifies
unified message addressing, Reply defaults, server-assigned source envelopes and limits.
A Channel may have a public collaboration prompt, separate from its description.
Configure it through the Channel create/update API or Console. Current members can
read it. Only Studio authority can set a non-empty prompt on creation or modify
or clear it later; ordinary clients can create Channels without a prompt. A
non-member Studio authority can update the prompt alone, without gaining access
to messages or permission to edit other metadata. Each Channel-scoped
Pet run receives the Plugin's common instructions, Channel title and description,
and any configured announcement in its system prompt. This does not change
the Pet's `PET.md`; a prompt
edit applies to a subsequent dispatch, not to a run already in progress or its
approval continuation. Use it to describe the current team's roles and how members
collaborate. The routing model can also see it; routing still only considers human
messages with no @. It does not grant permissions or override Host / PET safety
rules, and does not guarantee model compliance. A Pet can still use `channel_read_context`
to inspect messages; the prompt does not automatically include conversation history.
Existing workdir templates are not rewritten by this setting. See the
[Channel prompt design](../design/studio/channel-collaboration-prompt.md).

For example, a Channel that coordinates project issues and delivery could use the
following instructions. This is an example, not a default: it is never applied
automatically. Adapt the purpose and roles to the actual Channel members.

```text
本 Channel 围绕项目事项协调进度和交付，帮助人类和成员对齐意图与结果。

Issuer 关注 Issue 的意图、状态和与人类的沟通；Executor 负责实现和自验；
Reviewer 独立判断交付是否符合意图；Wiki 关注项目知识与实际变化是否一致。

结合当前上下文和事实判断如何协作，不预设固定顺序。优先处理自己职责和能力
范围内的事；即使具备工具，也不要默认代替其他角色承担其主要工作。可以适度
协助，但不替代其他角色的判断或人类授权。需要其他成员行动时，明确接收人并
说明事项和必要背景；超出能力范围、缺少信息或涉及未确定的产品、架构和权限
取舍时，说明情况并向合适的参与者或人类寻求帮助与决定。
```

The Channel Plugin owns the common context-reading and addressing instructions.
It also supplies one shared `channel_context` Capability for a separate analysis
subtask that returns a summary to the main Pet. PET.md defines only the Pet's own
role and boundaries; the Channel announcement defines team roles and collaboration.
The Host still saves and delivers public replies through its existing event path.

Existing workdirs are not rewritten. Remove obsolete per-Pet `channel_context`
copies only after preserving any local customizations; otherwise those copies
continue to override the Plugin's shared definition. Compare PET.md and dedicated
Capabilities for duplicated Channel rules before upgrading. Restart the Host
after changing these files or Plugin definitions; editing a Channel announcement
uses the next-run behavior described above.

A human's message that addresses nobody is stored and wakes no Pet. Setting the Channel
Plugin option `routing.enabled` to `true` lets one model call choose a single Pet, or
nobody, for such a message:

```json
{ "id": "@pinpawo-plugin/channel", "options": { "routing": {
  "enabled": true,
  "decider": { "kind": "llm", "modelProfileId": "deepseek-v4-flash" },
  "pets": { "executor": "Runs code, commands and delivery requests." }
} } }
```

`modelProfileId` names a Host model profile (omit it for the Host default); `threshold`
(default 0.5), `timeoutMs` (default 10000) and `historyLimit` (default 20) are optional.
See [Channel routing](../design/studio/channel-routing.md).

`@pinpawo-plugin/trigger` binds an HTTP, signed GitHub webhook or Studio event source
to a Pet request. Static strings and logic-free templates remain supported; source
credentials, template projection, deduplication and endpoints are documented once in
[Automation Plugins](../design/studio/automation-plugins.md). Every rule names the
`channelId` its Pet runs in, so the default template ships no rules: create the Channel,
then add the rule. Deliveries live in the Studio database and the
Plugin no longer takes a `databasePath` option; deliveries in an earlier `trigger.sqlite` are not migrated.

`@pinpawo-plugin/project-files` projects Markdown from a configured Wiki root into
`GET /knowledge` and `GET /knowledge/document?path=...` through the HTTP route
hook. New Studio initialization creates `~/.pinpawo/studios/<random-uuid>/wiki/`
and records its absolute path as `options.wikiDirectory`; it does not derive identity
from the project name or worktree. This directory is durable user knowledge and must
be included in backup and migration. Knowledge and the `project_files` Toolkit use
the same root. The Toolkit lists and reads documents and writes with an expected digest
through the existing review policy; a conflict requires re-reading and merging.

For existing configurations, `options.directory` remains a workdir-relative root
(default `wiki`) for compatibility; it is not silently migrated. To move an existing
Wiki, copy it to a separate durable directory, verify every file and configure its
absolute path as `wikiDirectory` (remove `directory` if present). Existing Pet files
are not upgraded automatically: compare the installed Wiki Pet's `PET.md` and
`capabilities/wiki-maintenance/CAPABILITY.md` with the current shipped template, then
**merge** the `project_files` entry into `uses` and the list/read/digest/write workflow
into its instructions while preserving any user customizations and applicable project
rules. Do not replace the user's Pet files wholesale. The write operation retains its
review policy, and conflicts require a fresh read before merging.

Restart the Host, then verify that Knowledge and the Wiki Pet both read the configured
root and that a reviewed Wiki update appears in Knowledge before considering cleanup.
An older Capability that still uses only `files` and refers to workdir `wiki/` will
otherwise continue updating the old copy. Preserve conflicting or changed files and do
not silently delete an existing Wiki. Read/write paths remain constrained to the
configured root; client requests cannot select arbitrary filesystem roots.

Installed Plugins may compose through the opaque `StudioPluginContext.hooks`
broker. Studio matches Plugin and hook names and owns lifecycle cleanup without
importing or interpreting extension contracts. The HTTP Plugin exposes a
`routes` hook; Channel, Scheduler, Trigger, Notice, and Project Files can
contribute their own routes. Each Plugin retains ownership of its stored data:
Plugins on `StudioPluginContext.storage` own their tables and migration history
in the shared Studio database. No Plugin keeps its own SQLite file under
`.pinpawo/studio/` any more.

## Retired Kanban workdirs

The Kanban package, API, tools, task assignment pipeline, and task completion
Wiki Trigger have been retired. Keep existing databases and snapshots as history;
startup does not read, migrate, delete, or clean their schemas.

For an existing workdir, manually compare its files with the shipped template:

1. Remove `@pinpawo-plugin/kanban` from `.pinpawo/studio.json`; install and enable
   `@pinpawo-plugin/channel` when adopting the current Pet template.
2. Remove `dispatch-assigned-kanban-task` and `wiki-on-task-done`. Rewrite any
   external-request prompt that still requires planning into a board.
3. Update Pet `PET.md` and `CAPABILITY.md` documents, preserving local instructions.
   Remove `kanban`, `kanban-planning`, `kanban-execution`, `kanban-reporting`, and
   `kanban-observation` bindings and calls. The old `studio_reporting` Capability
   can be removed: confirmed results now return through the ordinary public reply.
4. Keep the three roles and their valid defaults: `studio_execution`,
   `studio_review`, and `wiki_maintenance`. The template no longer ships a
   `planner` Pet, and the Host no longer provides the `studio-context` Toolkit
   (`studio_pet_list`). Remove the `planner` Pet (and point `entryPetId` and any
   Trigger `petId` at another Pet), or drop `studio-context` from its Capabilities'
   `uses`; a Capability that still names it is unavailable. Explicitly request
   work through a Pet session, generic dispatch, or Channel execution. Request
   Wiki maintenance with the changes and evidence that should be reconciled.
5. Preserve `.pinpawo/kanban/`, any `kanban.json`, existing Wiki, and other user data.
   Restart the Host after reviewing the configuration changes.

`init` refuses to overwrite an existing workdir. No empty compatibility Plugin,
automatic assignment replacement, or implicit Wiki trigger is installed. A
missing configured package reports its name and manual configuration guidance.
A completed invocation is execution evidence, not acceptance of the goal.

The Host first calls `resolveStudioHostConfig()` to read files and resolve Plugins,
then initializes its unified Toolkit inventory, and finally calls `buildStudio()`
to build pet runtime adapters and the filesystem-independent `createStudio()` core.
After a Studio Host has built a Studio for a workdir, it keeps that resident instance;
restart the host to pick up configuration changes.

For dispatch, gate, and event behavior, read the [Studio API](../reference/api/studio.md).
