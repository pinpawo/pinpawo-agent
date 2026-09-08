# Kanban task graph (draft)

## Problem

`dependsOn` mixes two different concerns: a planner's statement that two
deliverables are related, and a scheduler's decision to prevent a person from
starting work.  The latter makes a board hard to correct and prevents useful
parallel work such as preparation or review.

The board also has no supported way to remove a task that was created by
mistake.

## Proposed model

A Kanban snapshot is a small knowledge graph:

- A task is a node with its own lifecycle and optional assignee.
- A relationship is an undirected `related` edge between two existing task nodes.
  `sourceTaskId` and `targetTaskId` are retained as endpoint field names, but
  carry no direction: storage sorts the IDs lexically and keeps one edge per pair.
- Relationships are descriptive only.  They never change a task's status and
  never gate assignment, start, completion, or recovery.

The first release intentionally has one relationship kind.  This keeps the
planner-facing API direct (`relatedTaskIds` when creating a task, or an
explicit link operation) without prematurely turning the board into a project
management taxonomy.  More edge kinds can be added only after a concrete
consumer needs them.

## Mutation rules

The Planner presents a draft in conversation and waits for user confirmation,
including after draft revisions. Only then does it call the existing per-task
creation tool. There is no persisted draft, batch API, or service-side approval
gate. Independent problems determine task boundaries; actual connections
determine relationships. Neither implies the other.

`relatedTaskIds` is optional and references already-created tasks. For two
confirmed tasks, create A, then create B with `relatedTaskIds: [A.taskId]`.
Creating B and its relationships is atomic; creating A and B together is not.
Do not pass draft labels or create duplicate reverse links.

- Creating or linking validates that both endpoints exist and rejects
  self-links and duplicate links.
- Deleting a task deletes its incident relationships and its lifecycle event
  history in the same transaction.  It never deletes neighboring tasks.
- Deletion publishes `task.deleted` after commit so external observers can
  refresh their graph.  Historic events are deliberately removed with a
  deleted task; the board is an operational view, not an immutable audit log.

## Migration

Schema version 6 replaces `kanban_task_dependencies` with
`kanban_task_relationships`.  Existing dependency rows become `related`
edges, removing the old assignment gate. Schema v7 normalizes both endpoints
and collapses reverse duplicates. It upgrades v6 databases as well as older
databases through the existing migration chain.
Legacy JSON import remains compatible because it is a one-time import format;
its `deps` values are imported as graph relationships.

## API boundary

`GET /kanban` returns `tasks` and `relationships`.  The planner toolkit can
add, link, unlink, and remove tasks; execution tools retain only lifecycle
updates.  The HTTP control route exposes user-controlled assignment and task
deletion.

Console reads snapshot relationships from either endpoint and permits assignment
of any `todo` task regardless of neighbor status. It no longer reads `task.deps`.
Link/unlink currently have no history event or live notification; a refreshed
snapshot is authoritative. Deletion removes history and has a live notification
only, so the event feed alone cannot reconstruct deletions after disconnect.
Deleting a task does not cancel previously dispatched execution.

The three-turn Qwen evaluation verifies no writes during draft/revision and one
creation after confirmation. It does not validate production PET context assembly
or overall draft quality; the observed draft added unrequested requirements.
In the latest run the initial draft also split a fix and its regression tests;
the user revision merged them before confirmation. The passing gate check does
not imply consistently good task decomposition.
