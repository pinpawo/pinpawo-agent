# Workspace Runtime Config Design

> **Status: proposal.** Workspace registry and protocol additions described
> here are not a current contract. For shipped workdir behavior, see
> [Workdir configuration](../../reference/runtime/workdir.md).

## Context

`workdir` is currently the lowest common denominator for local execution. It is passed into chat prompts, local-machine Toolkit execution scopes, checkpoints, Studio config, Studio wiki, due-run state, and capability artifacts. That made the local runtime workdir-scoped, but it still leaves two product-level gaps:

- Chat and Studio do not know which user-facing project they belong to. They only see a path.
- App-driven flows cannot reliably focus a conversation on a specific project without starting a separate local-agent process with a different `--workdir`.

This document introduces a Workspace layer above `workdir`. The goal is not to remove `workdir`; the goal is to make it the root path of an explicit runtime scope.

## Goals

- Give Chat and Studio a shared project/workspace identity.
- Keep user and machine secrets in global config.
- Keep project-specific runtime state under the workspace root.
- Preserve the current `--workdir` behavior while adding a clearer abstraction for App and Studio.
- Make future multi-workspace support possible without relying on process-global mutable workdir state.

## Non-Goals

- Do not move API tokens, LLM keys, browser sessions, or plugin installs into workspace directories.
- Do not require multi-workspace concurrency in the first iteration.
- Do not break existing `--workdir`, `PINPAWO_WORKDIR`, or stored `workdir` behavior.
- Do not silently infer remote repository identity or hosted app project IDs from local paths in the first iteration.

## Terminology

- **Global config**: User/machine-level configuration stored in `~/.pinpawo/config.json` and environment variables.
- **Workspace**: A user-facing project scope. It has an id, display name, and root path.
- **Runtime config**: The fully resolved local paths used by one agent runtime invocation.
- **Workdir**: The workspace root path used for relative local file, git, shell, artifact, checkpoint, and Studio state.

## Config Layers

### Global Config

Global config remains the source of truth for identity, credentials, default models, global review policy, capability directories, browser backend, and default workdir fallback.

```text
~/.pinpawo/
├── config.json
├── .env
├── local-server-token
├── capabilities/
├── plugins/
└── sessions/
```

Global config should not contain per-workspace Studio topology or chat checkpoints.

### Workspace Registry

The registry maps stable workspace ids to local roots. It is global because users need to reopen projects from the App or desktop companion.

```text
~/.pinpawo/workspaces.json
```

Proposed shape:

```ts
type WorkspaceRegistryEntry = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  lastOpenedAt?: string;
  metadata?: {
    repoRemote?: string;
    defaultBranch?: string;
    summary?: string;
  };
};
```

The first implementation can derive a local id from `rootPath` for backwards compatibility, then add explicit registry persistence once App workspace selection lands.

### Workspace State Root

Workspace-owned config and runtime state stays under the workspace root:

```text
<workspace.rootPath>/.pinpawo/
├── workspace.json
├── studio.json
├── pets/
├── studio-curator.md
├── studio-wiki/
├── studio-run-queue.json
├── studio-due-runs.json
├── capability-artifacts/
├── checkpoints-capability-v2/
├── checkpoints-tui-capability-v2/
└── tui-sessions-capability-v2.json
```

The runtime config keeps `.json` checkpoint anchor names, while `FileSaver`
maps them to extensionless content-addressed directories. The runtime reads only
the current manifest/object/ref/writes layout and does not scan legacy monolith
or shard checkpoint files. The `capability-v2` suffix is the explicit
checkpoint contract boundary for the unified `capability:<name>` lane model.

`workspace.json` is optional at first. When present, it can hold display metadata and project background that should be injected into future chat/studio context.

## Runtime Shape

`LocalAgentRuntimeConfig` remains the execution contract. It gains an optional `workspace` identity:

```ts
type LocalAgentWorkspaceConfig = {
  id: string;
  name: string;
  rootPath: string;
};

type LocalAgentRuntimeConfig = {
  workdir: string;
  workspace?: LocalAgentWorkspaceConfig;
  stateRoot: string;
  studioConfigPath: string;
  studioDueRunsPath: string;
  petsDir: string;
  studioWikiBaseDir: string;
  checkpointPath: string;
  tuiCheckpointPath: string;
  tuiSessionPath: string;
  capabilityArtifactRoot: string;
};
```

Resolution order for a runtime:

```text
request.workspaceId
> request.workspaceRoot
> CLI --workspace / --workdir
> PINPAWO_WORKDIR
> ~/.pinpawo/config.json#workdir
> process.cwd()
> homedir()
```

`workdir` is still the path captured when a Host creates its local-machine
Toolkit definitions. The same snapshot is used for relative paths, default cwd,
Agent prompts, and review. `workspace` is the stable identity used by UI, session
binding, scheduler trace, and future project background.

## Chat Behavior

Chat should bind a session to one workspace at creation time.

Required changes:

- Extend `chat_request` and `new_session` with optional `workspaceId`.
- Resolve `workspaceId` in the local server before building chat setup.
- Include workspace identity in `/runtime`, snapshots, and session metadata.
- Include workspace id in chat thread identity to avoid cross-project checkpoint reuse.

Current thread shape:

```text
chat:<petId>:user:<userId>
```

Target shape:

```text
chat:<workspaceId>:pet:<petId>:user:<userId>
```

Existing sessions without a workspace id should keep using the legacy key until the user starts a new workspace-bound session.

## Studio Behavior

Studio should resolve config from the active workspace:

```text
<workspace.rootPath>/.pinpawo/studio.json
<workspace.rootPath>/.pinpawo/pets/
<workspace.rootPath>/.pinpawo/studio-wiki/
```

The runtime does not probe `~/.pinpawo/studio.json` as a fallback. In workspace-aware mode, missing workspace Studio config should produce an explicit "Studio not configured for this workspace" error naming the canonical path. Users who need historical data must copy it before upgrading rather than relying on a resident runtime migration path.

Studio run identity and due-run trace should include workspace id as well as workdir:

```ts
type StudioRunIdentity = {
  runId: string;
  conversationId: string;
  idempotencyKey: string;
  workspaceId?: string;
  workdir: string;
};
```

## Local-machine Toolkit Runtime

The current local-machine Toolkit implementations use process-global mutable workdir. That is an implementation limitation, not a valid Host/Toolkit contract. The canonical target is defined in [Host / Agent / Capability / Toolkit relationships](../host-agent-capability-toolkit.md).

Target:

```ts
toolkitRuntimeManager.resolve({
  execution: {
    workdir: runtimeConfig.workdir,
    threadId,
    runId,
    delegationId,
  },
});
```

Every Chat/Studio invocation uses its Host's workspace-bound workdir for the Agent
prompt and review context. Local-machine Toolkit definitions capture that same
workdir when the Host inventory is assembled, without a module-level variable or
process-wide Toolkit singleton. Toolkit Runtime resolution also receives the
execution scope when a Toolkit-owned live resource needs it. Supporting another
workspace means selecting or creating the corresponding Host runtime; concurrent
Hosts therefore remain isolated without changing Tool inputs.

## Protocol Additions

Client messages:

```ts
type WorkspaceRequestScope = {
  workspaceId?: string;
  workspaceRoot?: string;
};

type ChatRequestMessage = {
  type: 'chat_request';
  requestId: string;
  message: string;
  userId?: string;
} & WorkspaceRequestScope;

type StudioRequestMessage = {
  type: 'studio_request';
  requestId: string;
  userRequest: string;
  runId?: string;
  conversationId?: string;
} & WorkspaceRequestScope;
```

Server/runtime responses should expose:

```json
{
  "workdir": "/repo",
  "workspace_id": "local-...",
  "workspace_name": "pinpawo-agent",
  "workspace_root": "/repo"
}
```

## Migration Plan

1. Attach workspace metadata to `LocalAgentRuntimeConfig` while preserving existing `workdir` behavior.
2. Expose workspace metadata in `/runtime` and TUI/app snapshots.
3. Add a `WorkspaceRegistry` backed by `~/.pinpawo/workspaces.json`.
4. Extend local protocol to accept `workspaceId` for chat and studio requests.
5. Bind chat sessions/checkpoints to workspace id.
6. Make Studio legacy config fallback opt-in or migration-only.
7. Replace global local-tool workdir with Host-scoped local Toolkit definitions.
8. Add App/Desktop UI for selecting, opening, and registering workspaces.

## Validation

- Runtime config tests verify stable workspace identity over existing workdir paths.
- `/runtime` endpoint tests verify workspace metadata is visible to clients.
- Chat tests should cover workspace-bound thread ids before protocol fields become active.
- Studio tests should cover workspace config lookup, missing config errors, and legacy migration hints.
- Tool tests should cover two concurrent invocation contexts resolving the same relative path against different workdirs.
