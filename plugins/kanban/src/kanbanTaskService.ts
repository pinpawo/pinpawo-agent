import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type KanbanTaskStatus = 'todo' | 'assigned' | 'doing' | 'waiting' | 'done' | 'blocked';

export type KanbanTask = {
  taskId: string;
  /** A user-selected opaque execution target. Kanban never resolves this identifier. */
  assigneeId?: string;
  title: string;
  detail: string;
  status: KanbanTaskStatus;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

/** An undirected edge, stored with lexically ordered endpoints. Never gates execution. */
export type KanbanTaskRelationship = {
  sourceTaskId: string;
  targetTaskId: string;
  type: 'related';
};

export type KanbanTaskEvent = {
  sequence: number;
  taskId: string;
  eventType: 'created' | 'imported' | 'assigned' | 'started' | 'waiting' | 'completed' | 'blocked' | 'recovered';
  fromStatus?: KanbanTaskStatus;
  toStatus: KanbanTaskStatus;
  note?: string;
  occurredAt: string;
};

export type KanbanTaskSnapshot = {
  tasks: KanbanTask[];
  relationships: KanbanTaskRelationship[];
  lastEventSequence: number;
};

export type KanbanTaskMutation = {
  task: KanbanTask;
  event: KanbanTaskEvent;
};

export type KanbanTaskDeletion = {
  task: KanbanTask;
  removedRelationships: KanbanTaskRelationship[];
};

export type CreateKanbanTaskInput = {
  title: string;
  detail: string;
  relatedTaskIds?: readonly string[];
};

/** Strictly validated input for the one-way legacy JSON migration. */
export type LegacyKanbanTask = {
  taskId: string;
  assigneeId: string;
  title: string;
  detail: string;
  status: KanbanTaskStatus;
  deps: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type KanbanTaskRepository = {
  init: () => Promise<void>;
  close: () => Promise<void>;
  readSnapshot: () => Promise<KanbanTaskSnapshot>;
  getTask: (taskId: string) => Promise<KanbanTask | null>;
  createTask: (input: CreateKanbanTaskInput) => Promise<KanbanTaskMutation>;
  linkTasks: (sourceTaskId: string, targetTaskId: string) => Promise<KanbanTaskRelationship>;
  unlinkTasks: (sourceTaskId: string, targetTaskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<KanbanTaskDeletion>;
  assignTask: (taskId: string, assigneeId: string, assignmentNote?: string) => Promise<KanbanTaskMutation>;
  startAssignedTask: (taskId: string) => Promise<KanbanTaskMutation>;
  completeTask: (taskId: string, result: string) => Promise<KanbanTaskMutation>;
  blockTask: (taskId: string, reason: string) => Promise<KanbanTaskMutation>;
  recoverInterruptedTasks: () => Promise<KanbanTaskMutation[]>;
  listTaskEvents: (afterSequence?: number, limit?: number) => Promise<KanbanTaskEvent[]>;
};

const TASK_STATUSES = new Set<KanbanTaskStatus>([
  'todo', 'assigned', 'doing', 'waiting', 'done', 'blocked',
]);
const SCHEMA_VERSION = 7;
const MAX_TASK_TITLE_LENGTH = 160;
const MAX_ASSIGNMENT_NOTE_LENGTH = 1_000;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1_000;

type TaskRow = {
  task_id: string;
  assignee_id: string | null;
  title: string;
  detail: string;
  status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  sequence: number;
  task_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  occurred_at: string;
};

type RelationshipRow = {
  source_task_id: string;
  target_task_id: string;
  relationship_type: string;
};

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Kanban ${label} must not be empty.`);
  return normalized;
}

function requireTaskTitle(value: string): string {
  const title = requireNonEmpty(value, 'title').replace(/\s+/g, ' ');
  if (title.length > MAX_TASK_TITLE_LENGTH) {
    throw new Error(`Kanban title must not exceed ${MAX_TASK_TITLE_LENGTH.toString()} characters.`);
  }
  return title;
}

function normalizeAssignmentNote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const note = value.trim();
  if (note.length > MAX_ASSIGNMENT_NOTE_LENGTH) {
    throw new Error(`Kanban assignment note must not exceed ${MAX_ASSIGNMENT_NOTE_LENGTH.toString()} characters.`);
  }
  return note || undefined;
}

function titleFromLegacyBrief(brief: string): string {
  const firstLine = brief.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? brief.trim();
  const title = firstLine.replace(/\s+/g, ' ');
  return title.length <= MAX_TASK_TITLE_LENGTH
    ? title
    : `${title.slice(0, MAX_TASK_TITLE_LENGTH - 1).trimEnd()}…`;
}

function requireStatus(value: string): KanbanTaskStatus {
  if (!TASK_STATUSES.has(value as KanbanTaskStatus)) {
    throw new Error(`Kanban database contains unsupported task status "${value}".`);
  }
  return value as KanbanTaskStatus;
}

function taskFromRow(row: TaskRow): KanbanTask {
  return {
    taskId: row.task_id,
    ...(row.assignee_id === null ? {} : { assigneeId: row.assignee_id }),
    title: row.title,
    detail: row.detail,
    status: requireStatus(row.status),
    ...(row.note === null ? {} : { note: row.note }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): KanbanTaskEvent {
  const eventTypes = new Set<KanbanTaskEvent['eventType']>([
    'created', 'imported', 'assigned', 'started', 'waiting', 'completed', 'blocked', 'recovered',
  ]);
  if (!eventTypes.has(row.event_type as KanbanTaskEvent['eventType'])) {
    throw new Error(`Kanban database contains unsupported event type "${row.event_type}".`);
  }
  return {
    sequence: row.sequence,
    taskId: row.task_id,
    eventType: row.event_type as KanbanTaskEvent['eventType'],
    ...(row.from_status === null ? {} : { fromStatus: requireStatus(row.from_status) }),
    toStatus: requireStatus(row.to_status),
    ...(row.note === null ? {} : { note: row.note }),
    occurredAt: row.occurred_at,
  };
}

function relationshipFromRow(row: RelationshipRow): KanbanTaskRelationship {
  if (row.relationship_type !== 'related') {
    throw new Error(`Kanban database contains unsupported relationship type "${row.relationship_type}".`);
  }
  return {
    sourceTaskId: row.source_task_id,
    targetTaskId: row.target_task_id,
    type: 'related',
  };
}

function normalizeRelatedTaskIds(taskId: string, relatedTaskIds: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const relatedTaskId of relatedTaskIds ?? []) {
    const normalizedTaskId = requireNonEmpty(relatedTaskId, 'related taskId');
    if (normalizedTaskId === taskId) throw new Error('Kanban task cannot relate to itself.');
    if (seen.has(normalizedTaskId)) throw new Error(`Kanban task repeats related task "${normalizedTaskId}".`);
    seen.add(normalizedTaskId);
    normalized.push(normalizedTaskId);
  }
  return normalized;
}

/**
 * SQLite persistence owned by the Kanban domain. It intentionally has no Studio,
 * HTTP, Toolkit, or Pet dependency.
 */
export class SqliteKanbanTaskRepository implements KanbanTaskRepository {
  private readonly database: DatabaseSync;
  private initialized = false;
  private closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:' && !path.isAbsolute(databasePath)) {
      throw new Error('Kanban SQLite database path must be absolute or :memory:.');
    }
    if (databasePath !== ':memory:') {
      const directory = path.dirname(databasePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
  }

  async init(): Promise<void> {
    if (this.closed) throw new Error('Kanban SQLite repository is closed.');
    if (this.initialized) return;
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.database.exec('PRAGMA synchronous = FULL;');
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec('PRAGMA trusted_schema = OFF;');
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    let schemaVersion = version.user_version;
    if (schemaVersion > SCHEMA_VERSION) {
      throw new Error(`Kanban database schema ${schemaVersion.toString()} is newer than supported.`);
    }
    if (schemaVersion === 0) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE kanban_tasks (
          task_id TEXT PRIMARY KEY,
          assignee_id TEXT,
          title TEXT NOT NULL,
          detail TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('todo', 'assigned', 'doing', 'waiting', 'done', 'blocked')),
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE kanban_task_relationships (
          source_task_id TEXT NOT NULL,
          target_task_id TEXT NOT NULL,
          relationship_type TEXT NOT NULL CHECK (relationship_type = 'related'),
          PRIMARY KEY (source_task_id, target_task_id, relationship_type),
          CHECK (source_task_id <> target_task_id),
          FOREIGN KEY (source_task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE,
          FOREIGN KEY (target_task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE
        );
        CREATE TABLE kanban_task_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          note TEXT,
          occurred_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE RESTRICT
        );
        CREATE INDEX kanban_tasks_status_created ON kanban_tasks(status, created_at, task_id);
        CREATE INDEX kanban_relationships_target
          ON kanban_task_relationships(target_task_id, source_task_id);
        CREATE INDEX kanban_task_events_task_sequence
          ON kanban_task_events(task_id, sequence);
        PRAGMA user_version = 6;
        COMMIT;
      `);
      schemaVersion = 6;
    }
    if (schemaVersion === 1) {
      this.database.exec(`BEGIN IMMEDIATE; ALTER TABLE kanban_tasks ADD COLUMN continuation_json TEXT; PRAGMA user_version = 2; COMMIT;`);
      schemaVersion = 2;
    }
    if (schemaVersion === 2) {
      this.database.exec('BEGIN IMMEDIATE; ALTER TABLE kanban_tasks DROP COLUMN continuation_json; PRAGMA user_version = 3; COMMIT;');
      schemaVersion = 3;
    }
    if (schemaVersion >= 1 && schemaVersion <= 3) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE kanban_tasks ADD COLUMN title TEXT NOT NULL DEFAULT '';
        ALTER TABLE kanban_tasks ADD COLUMN detail TEXT NOT NULL DEFAULT '';
      `);
      try {
        const legacyRows = this.database.prepare(
          'SELECT task_id, brief FROM kanban_tasks',
        ).all() as Array<{ task_id: string; brief: string }>;
        const update = this.database.prepare(
          'UPDATE kanban_tasks SET title = ?, detail = ? WHERE task_id = ?',
        );
        for (const row of legacyRows) {
          update.run(titleFromLegacyBrief(row.brief), row.brief, row.task_id);
        }
        this.database.exec('ALTER TABLE kanban_tasks DROP COLUMN brief; PRAGMA user_version = 4; COMMIT;');
        schemaVersion = 4;
      } catch (error) {
        this.database.exec('ROLLBACK;');
        throw error;
      }
    }
    if (schemaVersion === 4) {
      this.database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        CREATE TABLE kanban_tasks_next (
          task_id TEXT PRIMARY KEY,
          assignee_id TEXT,
          title TEXT NOT NULL,
          detail TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('todo', 'assigned', 'doing', 'waiting', 'done', 'blocked')),
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO kanban_tasks_next(
          task_id, assignee_id, title, detail, status, note, created_at, updated_at
        )
        SELECT task_id, CASE WHEN status = 'todo' THEN NULL ELSE assignee_id END, title, detail, status, note, created_at, updated_at
        FROM kanban_tasks;
        DROP TABLE kanban_tasks;
        ALTER TABLE kanban_tasks_next RENAME TO kanban_tasks;
        CREATE INDEX kanban_tasks_status_created ON kanban_tasks(status, created_at, task_id);
        PRAGMA user_version = 5;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
      schemaVersion = 5;
    }
    if (schemaVersion === 5) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE kanban_task_relationships (
          source_task_id TEXT NOT NULL,
          target_task_id TEXT NOT NULL,
          relationship_type TEXT NOT NULL CHECK (relationship_type = 'related'),
          PRIMARY KEY (source_task_id, target_task_id, relationship_type),
          CHECK (source_task_id <> target_task_id),
          FOREIGN KEY (source_task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE,
          FOREIGN KEY (target_task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE
        );
        INSERT INTO kanban_task_relationships(source_task_id, target_task_id, relationship_type)
        SELECT task_id, depends_on_task_id, 'related' FROM kanban_task_dependencies;
        DROP TABLE kanban_task_dependencies;
        CREATE INDEX kanban_relationships_target
          ON kanban_task_relationships(target_task_id, source_task_id);
        PRAGMA user_version = 6;
        COMMIT;
      `);
      schemaVersion = 6;
    }
    if (schemaVersion === 6) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE kanban_relationships_next (
            source_task_id TEXT NOT NULL,
            target_task_id TEXT NOT NULL,
            relationship_type TEXT NOT NULL CHECK (relationship_type = 'related'),
            PRIMARY KEY (source_task_id, target_task_id, relationship_type),
            CHECK (source_task_id < target_task_id),
            FOREIGN KEY (source_task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE,
            FOREIGN KEY (target_task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE
          );
          INSERT INTO kanban_relationships_next
          SELECT MIN(source_task_id, target_task_id), MAX(source_task_id, target_task_id), relationship_type
          FROM kanban_task_relationships WHERE 1
          ON CONFLICT (source_task_id, target_task_id, relationship_type) DO NOTHING;
          DROP TABLE kanban_task_relationships;
          ALTER TABLE kanban_relationships_next RENAME TO kanban_task_relationships;
          CREATE INDEX kanban_relationships_target ON kanban_task_relationships(target_task_id, source_task_id);
          PRAGMA user_version = 7;
        `);
      });
    }
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  async readSnapshot(): Promise<KanbanTaskSnapshot> {
    this.assertReady();
    const tasks = (this.database.prepare(
      'SELECT task_id, assignee_id, title, detail, status, note, created_at, updated_at FROM kanban_tasks ORDER BY created_at, task_id',
    ).all() as TaskRow[]).map((row) => taskFromRow(row));
    const relationships = this.readRelationships();
    const sequence = this.database.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM kanban_task_events',
    ).get() as { sequence: number };
    return { tasks, relationships, lastEventSequence: sequence.sequence };
  }

  async getTask(taskId: string): Promise<KanbanTask | null> {
    this.assertReady();
    const row = this.database.prepare(
      'SELECT task_id, assignee_id, title, detail, status, note, created_at, updated_at FROM kanban_tasks WHERE task_id = ?',
    ).get(taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  async createTask(input: CreateKanbanTaskInput): Promise<KanbanTaskMutation> {
    this.assertReady();
    const taskId = randomUUID();
    const title = requireTaskTitle(input.title);
    const detail = requireNonEmpty(input.detail, 'detail');
    const relatedTaskIds = normalizeRelatedTaskIds(taskId, input.relatedTaskIds);
    return this.transaction(() => {
      for (const relatedTaskId of relatedTaskIds) {
        const found = this.database.prepare('SELECT 1 FROM kanban_tasks WHERE task_id = ?').get(relatedTaskId);
        if (!found) throw new Error(`Kanban related task "${relatedTaskId}" does not exist.`);
      }
      const now = new Date().toISOString();
      this.database.prepare(
        `INSERT INTO kanban_tasks(task_id, assignee_id, title, detail, status, created_at, updated_at)
         VALUES (?, NULL, ?, ?, 'todo', ?, ?)`,
      ).run(taskId, title, detail, now, now);
      const insertRelationship = this.database.prepare(
        "INSERT INTO kanban_task_relationships(source_task_id, target_task_id, relationship_type) VALUES (?, ?, 'related')",
      );
      for (const relatedTaskId of relatedTaskIds) insertRelationship.run(...[taskId, relatedTaskId].sort());
      return this.mutationFor(taskId, 'created', undefined, 'todo', undefined, now);
    });
  }

  async linkTasks(sourceTaskId: string, targetTaskId: string): Promise<KanbanTaskRelationship> {
    this.assertReady();
    const [source, target] = [requireNonEmpty(sourceTaskId, 'source taskId'), requireNonEmpty(targetTaskId, 'target taskId')].sort() as [string, string];
    if (source === target) throw new Error('Kanban task cannot relate to itself.');
    return this.transaction(() => {
      for (const taskId of [source, target]) {
        if (!this.database.prepare('SELECT 1 FROM kanban_tasks WHERE task_id = ?').get(taskId)) {
          throw new Error(`Kanban task "${taskId}" does not exist.`);
        }
      }
      try {
        this.database.prepare(
          "INSERT INTO kanban_task_relationships(source_task_id, target_task_id, relationship_type) VALUES (?, ?, 'related')",
        ).run(source, target);
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          throw new Error(`Kanban tasks "${source}" and "${target}" are already related.`);
        }
        throw error;
      }
      return { sourceTaskId: source, targetTaskId: target, type: 'related' };
    });
  }

  async unlinkTasks(sourceTaskId: string, targetTaskId: string): Promise<void> {
    this.assertReady();
    const [source, target] = [requireNonEmpty(sourceTaskId, 'source taskId'), requireNonEmpty(targetTaskId, 'target taskId')].sort() as [string, string];
    this.transaction(() => {
      const result = this.database.prepare(
        "DELETE FROM kanban_task_relationships WHERE source_task_id = ? AND target_task_id = ? AND relationship_type = 'related'",
      ).run(source, target);
      if (result.changes !== 1) throw new Error(`Kanban tasks "${source}" and "${target}" are not related.`);
    });
  }

  async deleteTask(taskId: string): Promise<KanbanTaskDeletion> {
    this.assertReady();
    const normalizedTaskId = requireNonEmpty(taskId, 'taskId');
    return this.transaction(() => {
      const row = this.database.prepare(
        'SELECT task_id, assignee_id, title, detail, status, note, created_at, updated_at FROM kanban_tasks WHERE task_id = ?',
      ).get(normalizedTaskId) as TaskRow | undefined;
      if (!row) throw new Error(`Kanban task "${normalizedTaskId}" does not exist.`);
      const removedRelationships = this.database.prepare(`
        SELECT source_task_id, target_task_id, relationship_type
        FROM kanban_task_relationships
        WHERE source_task_id = ? OR target_task_id = ?
        ORDER BY source_task_id, target_task_id
      `).all(normalizedTaskId, normalizedTaskId) as RelationshipRow[];
      this.database.prepare('DELETE FROM kanban_task_events WHERE task_id = ?').run(normalizedTaskId);
      this.database.prepare('DELETE FROM kanban_tasks WHERE task_id = ?').run(normalizedTaskId);
      return {
        task: taskFromRow(row),
        removedRelationships: removedRelationships.map(relationshipFromRow),
      };
    });
  }

  async assignTask(taskId: string, assigneeId: string, assignmentNote?: string): Promise<KanbanTaskMutation> {
    this.assertReady();
    const normalizedTaskId = requireNonEmpty(taskId, 'taskId');
    const normalizedAssigneeId = requireNonEmpty(assigneeId, 'assigneeId');
    const normalizedAssignmentNote = normalizeAssignmentNote(assignmentNote);
    return this.transaction(() => {
      const row = this.database.prepare(
        'SELECT task_id, assignee_id, title, detail, status, note, created_at, updated_at FROM kanban_tasks WHERE task_id = ?',
      ).get(normalizedTaskId) as TaskRow | undefined;
      if (!row) throw new Error(`Kanban task "${normalizedTaskId}" does not exist.`);
      const current = requireStatus(row.status);
      if (current !== 'todo') {
        throw new Error(`Kanban task "${normalizedTaskId}" is ${current}, not assignable.`);
      }
      const now = new Date().toISOString();
      const result = this.database.prepare(
        "UPDATE kanban_tasks SET assignee_id = ?, status = 'assigned', note = NULL, updated_at = ? WHERE task_id = ? AND status = 'todo'",
      ).run(normalizedAssigneeId, now, normalizedTaskId);
      if (result.changes !== 1) {
        throw new Error(`Kanban task "${normalizedTaskId}" could not be assigned.`);
      }
      return this.mutationFor(normalizedTaskId, 'assigned', current, 'assigned', normalizedAssignmentNote, now);
    });
  }

  async startAssignedTask(taskId: string): Promise<KanbanTaskMutation> {
    return this.transition(taskId, ['assigned'], 'doing', 'started');
  }

  async completeTask(taskId: string, result: string): Promise<KanbanTaskMutation> {
    // A recovered execution is conservatively marked blocked because Kanban
    // cannot inspect Agent checkpoint state. A later explicit Agent report is
    // still authoritative and may close that task without any checkpoint coupling.
    return this.transition(taskId, ['doing', 'waiting', 'blocked'], 'done', 'completed', result);
  }

  async blockTask(taskId: string, reason: string): Promise<KanbanTaskMutation> {
    return this.transition(taskId, ['assigned', 'doing', 'waiting'], 'blocked', 'blocked', reason);
  }

  async recoverInterruptedTasks(): Promise<KanbanTaskMutation[]> {
    this.assertReady();
    return this.transaction(() => {
      const tasks = this.database.prepare(
        "SELECT task_id FROM kanban_tasks WHERE status = 'doing' ORDER BY created_at, task_id",
      ).all() as Array<{ task_id: string }>;
      const mutations: KanbanTaskMutation[] = [];
      for (const { task_id: taskId } of tasks) {
        const note = 'interrupted by restart';
        const now = new Date().toISOString();
        this.database.prepare(
          "UPDATE kanban_tasks SET status = 'blocked', note = ?, updated_at = ? WHERE task_id = ?",
        ).run(note, now, taskId);
        mutations.push(this.mutationFor(taskId, 'recovered', 'doing', 'blocked', note, now));
      }
      return mutations;
    });
  }

  /**
   * Import is intentionally repository-only: normal adapters must use commands.
   * The destination must be empty so a repeated migration cannot duplicate work.
   */
  async importLegacyTasks(tasks: readonly LegacyKanbanTask[]): Promise<KanbanTaskMutation[]> {
    this.assertReady();
    return this.transaction(() => {
      const existing = this.database.prepare(
        'SELECT (SELECT COUNT(*) FROM kanban_tasks) AS tasks, (SELECT COUNT(*) FROM kanban_task_events) AS events',
      ).get() as { tasks: number; events: number };
      if (existing.tasks !== 0 || existing.events !== 0) {
        throw new Error('Kanban SQLite migration target is not empty.');
      }
      const taskIds = new Set<string>();
      for (const task of tasks) {
        if (taskIds.has(task.taskId)) throw new Error(`Kanban legacy snapshot repeats taskId "${task.taskId}".`);
        taskIds.add(task.taskId);
      }
      for (const task of tasks) {
        for (const dependencyId of task.deps) {
          if (!taskIds.has(dependencyId)) {
            throw new Error(`Kanban legacy task "${task.taskId}" depends on missing task "${dependencyId}".`);
          }
        }
        this.database.prepare(`
          INSERT INTO kanban_tasks(task_id, assignee_id, title, detail, status, note, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          task.taskId,
          task.status === 'todo' ? null : task.assigneeId,
          task.title,
          task.detail,
          task.status,
          task.note ?? null,
          task.createdAt,
          task.updatedAt,
        );
      }
      const insertRelationship = this.database.prepare(
        "INSERT INTO kanban_task_relationships(source_task_id, target_task_id, relationship_type) VALUES (?, ?, 'related') ON CONFLICT (source_task_id, target_task_id, relationship_type) DO NOTHING",
      );
      for (const task of tasks) {
        for (const relatedTaskId of task.deps) insertRelationship.run(...[task.taskId, relatedTaskId].sort());
      }
      return tasks.map((task) => this.mutationFor(
        task.taskId,
        'imported',
        undefined,
        task.status,
        task.note,
        task.updatedAt,
      ));
    });
  }

  async listTaskEvents(afterSequence = 0, limit = DEFAULT_EVENT_LIMIT): Promise<KanbanTaskEvent[]> {
    this.assertReady();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error('Kanban event cursor must be a non-negative integer.');
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_EVENT_LIMIT) {
      throw new Error(`Kanban event limit must be an integer from 1 to ${MAX_EVENT_LIMIT.toString()}.`);
    }
    const rows = this.database.prepare(`
      SELECT sequence, task_id, event_type, from_status, to_status, note, occurred_at
      FROM kanban_task_events
      WHERE sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(afterSequence, limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  private async transition(
    taskId: string,
    allowed: readonly KanbanTaskStatus[],
    target: KanbanTaskStatus,
    eventType: KanbanTaskEvent['eventType'],
    note?: string,
  ): Promise<KanbanTaskMutation> {
    this.assertReady();
    const normalizedTaskId = requireNonEmpty(taskId, 'taskId');
    const normalizedNote = note === undefined ? undefined : requireNonEmpty(note, 'task note');
    return this.transaction(() => {
      const row = this.database.prepare(
        'SELECT status FROM kanban_tasks WHERE task_id = ?',
      ).get(normalizedTaskId) as { status: string } | undefined;
      if (!row) throw new Error(`Kanban task "${normalizedTaskId}" does not exist.`);
      const current = requireStatus(row.status);
      if (!allowed.includes(current)) {
        throw new Error(`Kanban task "${normalizedTaskId}" is ${current}, not active.`);
      }
      const now = new Date().toISOString();
      this.database.prepare(
        'UPDATE kanban_tasks SET status = ?, note = ?, updated_at = ? WHERE task_id = ?',
      ).run(target, normalizedNote ?? null, now, normalizedTaskId);
      return this.mutationFor(normalizedTaskId, eventType, current, target, normalizedNote, now);
    });
  }

  private readRelationships(): KanbanTaskRelationship[] {
    const rows = this.database.prepare(`
      SELECT source_task_id, target_task_id, relationship_type
      FROM kanban_task_relationships
      ORDER BY source_task_id, target_task_id, relationship_type
    `).all() as RelationshipRow[];
    return rows.map(relationshipFromRow);
  }

  private mutationFor(
    taskId: string,
    eventType: KanbanTaskEvent['eventType'],
    fromStatus: KanbanTaskStatus | undefined,
    toStatus: KanbanTaskStatus,
    note: string | undefined,
    occurredAt: string,
  ): KanbanTaskMutation {
    const inserted = this.database.prepare(`
      INSERT INTO kanban_task_events(task_id, event_type, from_status, to_status, note, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, eventType, fromStatus ?? null, toStatus, note ?? null, occurredAt);
    const task = this.database.prepare(
      'SELECT task_id, assignee_id, title, detail, status, note, created_at, updated_at FROM kanban_tasks WHERE task_id = ?',
    ).get(taskId) as TaskRow | undefined;
    if (!task) throw new Error(`Kanban task "${taskId}" disappeared during mutation.`);
    return {
      task: taskFromRow(task),
      event: {
        sequence: Number(inserted.lastInsertRowid),
        taskId,
        eventType,
        ...(fromStatus ? { fromStatus } : {}),
        toStatus,
        ...(note ? { note } : {}),
        occurredAt,
      },
    };
  }

  private transaction<T>(run: () => T): T {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = run();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  private assertReady(): void {
    if (!this.initialized || this.closed) {
      throw new Error('Kanban SQLite repository is not available. Call init() before use.');
    }
  }
}

/** Application API and committed-event boundary for all Kanban adapters. */
export class KanbanTaskService {
  private readonly listeners = new Set<(change: KanbanTaskMutation | KanbanTaskDeletion) => void>();
  private initialized = false;

  constructor(private readonly repository: KanbanTaskRepository) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.repository.init();
    this.initialized = true;
    for (const mutation of await this.repository.recoverInterruptedTasks()) this.publish(mutation);
  }

  async close(): Promise<void> {
    this.listeners.clear();
    await this.repository.close();
    this.initialized = false;
  }

  subscribe(listener: (change: KanbanTaskMutation | KanbanTaskDeletion) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async readSnapshot(): Promise<KanbanTaskSnapshot> {
    this.assertReady();
    return this.repository.readSnapshot();
  }

  async getTask(taskId: string): Promise<KanbanTask | null> {
    this.assertReady();
    return this.repository.getTask(taskId);
  }

  async createTask(input: CreateKanbanTaskInput): Promise<KanbanTaskMutation> {
    return this.publish(await this.repository.createTask(input));
  }

  async linkTasks(sourceTaskId: string, targetTaskId: string): Promise<KanbanTaskRelationship> {
    this.assertReady();
    return this.repository.linkTasks(sourceTaskId, targetTaskId);
  }

  async unlinkTasks(sourceTaskId: string, targetTaskId: string): Promise<void> {
    this.assertReady();
    return this.repository.unlinkTasks(sourceTaskId, targetTaskId);
  }

  async deleteTask(taskId: string): Promise<KanbanTaskDeletion> {
    return this.publish(await this.repository.deleteTask(taskId));
  }

  async assignTask(taskId: string, assigneeId: string, assignmentNote?: string): Promise<KanbanTaskMutation> {
    return this.publish(await this.repository.assignTask(taskId, assigneeId, assignmentNote));
  }

  async startAssignedTask(taskId: string): Promise<KanbanTaskMutation> {
    return this.publish(await this.repository.startAssignedTask(taskId));
  }

  async completeTask(taskId: string, result: string): Promise<KanbanTaskMutation> {
    return this.publish(await this.repository.completeTask(taskId, result));
  }

  async blockTask(taskId: string, reason: string): Promise<KanbanTaskMutation> {
    return this.publish(await this.repository.blockTask(taskId, reason));
  }

  async listTaskEvents(afterSequence?: number, limit?: number): Promise<KanbanTaskEvent[]> {
    this.assertReady();
    return this.repository.listTaskEvents(afterSequence, limit);
  }

  private publish<T extends KanbanTaskMutation | KanbanTaskDeletion>(change: T): T {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error(
          '[kanban] committed domain-event listener failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }
    return change;
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error('Kanban task service is not initialized.');
  }
}

export function createInMemoryKanbanTaskService(): KanbanTaskService {
  return new KanbanTaskService(new SqliteKanbanTaskRepository(':memory:'));
}
