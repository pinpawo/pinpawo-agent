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
- A relationship is a directed `related` edge between two existing task nodes.
- Relationships are descriptive only.  They never change a task's status and
  never gate assignment, start, completion, or recovery.

The first release intentionally has one relationship kind.  This keeps the
planner-facing API direct (`relatedTaskIds` when creating a task, or an
explicit link operation) without prematurely turning the board into a project
management taxonomy.  More edge kinds can be added only after a concrete
consumer needs them.

## Mutation rules

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
edges, preserving their direction but removing the old assignment gate.
Legacy JSON import remains compatible because it is a one-time import format;
its `deps` values are imported as graph relationships.

## API boundary

`GET /kanban` returns `tasks` and `relationships`.  The planner toolkit can
add, link, unlink, and remove tasks; execution tools retain only lifecycle
updates.  The HTTP control route exposes user-controlled assignment and task
deletion.
