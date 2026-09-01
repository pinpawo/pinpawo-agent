import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type KanbanTaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'blocked';

export type KanbanTask = {
  taskId: string;
  /** A Kanban-owned executor identifier. A Studio adapter may map this to a petId. */
  assigneeId: string;
  title: string;
  detail: string;
  status: KanbanTaskStatus;
  deps: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type KanbanTaskEvent = {
  sequence: number;
  taskId: string;
  eventType: 'created' | 'imported' | 'claimed' | 'waiting' | 'completed' | 'blocked' | 'recovered';
  fromStatus?: KanbanTaskStatus;
  toStatus: KanbanTaskStatus;
  note?: string;
  occurredAt: string;
};

export type KanbanTaskSnapshot = {
  tasks: KanbanTask[];
  lastEventSequence: number;
};

export type KanbanTaskMutation = {
  task: KanbanTask;
  event: KanbanTaskEvent;
};

export type CreateKanbanTaskInput = {
  assigneeId: string;
  title: string;
  detail: string;
  dependsOn?: readonly string[];
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
  claimNextReadyTask: (excludedAssigneeIds?: readonly string[]) => Promise<KanbanTaskMutation | null>;
  claimReadyTask: (taskId: string) => Promise<KanbanTaskMutation>;
  completeTask: (taskId: string, result: string) => Promise<KanbanTaskMutation>;
  blockTask: (taskId: string, reason: string) => Promise<KanbanTaskMutation>;
  recoverInterruptedTasks: () => Promise<KanbanTaskMutation[]>;
  listTaskEvents: (afterSequence?: number, limit?: number) => Promise<KanbanTaskEvent[]>;
};

const TASK_STATUSES = new Set<KanbanTaskStatus>([
  'todo', 'doing', 'waiting', 'done', 'blocked',
]);
const SCHEMA_VERSION = 4;
const MAX_TASK_TITLE_LENGTH = 160;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1_000;

type TaskRow = {
  task_id: string;
  assignee_id: string;
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

function taskFromRow(row: TaskRow, deps: string[]): KanbanTask {
  return {
    taskId: row.task_id,
    assigneeId: row.assignee_id,
    title: row.title,
    detail: row.detail,
    status: requireStatus(row.status),
    deps,
    ...(row.note === null ? {} : { note: row.note }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): KanbanTaskEvent {
  const eventTypes = new Set<KanbanTaskEvent['eventType']>([
    'created', 'imported', 'claimed', 'waiting', 'completed', 'blocked', 'recovered',
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

function normalizeDependencies(taskId: string, dependencies: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const dependency of dependencies ?? []) {
    const dependencyId = requireNonEmpty(dependency, 'dependency id');
    if (dependencyId === taskId) throw new Error('Kanban task cannot depend on itself.');
    if (seen.has(dependencyId)) throw new Error(`Kanban task has duplicate dependency "${dependencyId}".`);
    seen.add(dependencyId);
    normalized.push(dependencyId);
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
    if (version.user_version > SCHEMA_VERSION) {
      throw new Error(`Kanban database schema ${version.user_version.toString()} is newer than supported.`);
    }
    if (version.user_version === 0) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE kanban_tasks (
          task_id TEXT PRIMARY KEY,
          assignee_id TEXT NOT NULL,
          title TEXT NOT NULL,
          detail TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'waiting', 'done', 'blocked')),
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE kanban_task_dependencies (
          task_id TEXT NOT NULL,
          depends_on_task_id TEXT NOT NULL,
          PRIMARY KEY (task_id, depends_on_task_id),
          CHECK (task_id <> depends_on_task_id),
          FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE,
          FOREIGN KEY (depends_on_task_id) REFERENCES kanban_tasks(task_id) ON DELETE RESTRICT
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
        CREATE INDEX kanban_dependencies_dependency
          ON kanban_task_dependencies(depends_on_task_id, task_id);
        CREATE INDEX kanban_task_events_task_sequence
          ON kanban_task_events(task_id, sequence);
        PRAGMA user_version = 4;
        COMMIT;
      `);
    }
    if (version.user_version === 1) {
      this.database.exec(`BEGIN IMMEDIATE; ALTER TABLE kanban_tasks ADD COLUMN continuation_json TEXT; PRAGMA user_version = 2; COMMIT;`);
    }
    if (version.user_version === 1 || version.user_version === 2) {
      this.database.exec('BEGIN IMMEDIATE; ALTER TABLE kanban_tasks DROP COLUMN continuation_json; PRAGMA user_version = 3; COMMIT;');
    }
    if (version.user_version >= 1 && version.user_version <= 3) {
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
      } catch (error) {
        this.database.exec('ROLLBACK;');
        throw error;
      }
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
    ).all() as TaskRow[]).map((row) => this.readTask(row));
    const sequence = this.database.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM kanban_task_events',
    ).get() as { sequence: number };
    return { tasks, lastEventSequence: sequence.sequence };
  }

  async getTask(taskId: string): Promise<KanbanTask | null> {
    this.assertReady();
    const row = this.database.prepare(
      'SELECT task_id, assignee_id, title, detail, status, note, created_at, updated_at FROM kanban_tasks WHERE task_id = ?',
    ).get(taskId) as TaskRow | undefined;
    return row ? this.readTask(row) : null;
  }

  async createTask(input: CreateKanbanTaskInput): Promise<KanbanTaskMutation> {
    this.assertReady();
    const taskId = randomUUID();
    const assigneeId = requireNonEmpty(input.assigneeId, 'assigneeId');
    const title = requireTaskTitle(input.title);
    const detail = requireNonEmpty(input.detail, 'detail');
    const dependencies = normalizeDependencies(taskId, input.dependsOn);
    return this.transaction(() => {
      for (const dependencyId of dependencies) {
        const found = this.database.prepare('SELECT 1 FROM kanban_tasks WHERE task_id = ?').get(dependencyId);
        if (!found) throw new Error(`Kanban dependency "${dependencyId}" does not exist.`);
      }
      const now = new Date().toISOString();
      this.database.prepare(
        `INSERT INTO kanban_tasks(task_id, assignee_id, title, detail, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'todo', ?, ?)`,
      ).run(taskId, assigneeId, title, detail, now, now);
      const insertDependency = this.database.prepare(
        'INSERT INTO kanban_task_dependencies(task_id, depends_on_task_id) VALUES (?, ?)',
      );
      for (const dependencyId of dependencies) insertDependency.run(taskId, dependencyId);
      return this.mutationFor(taskId, 'created', undefined, 'todo', undefined, now);
    });
  }

  async claimNextReadyTask(excludedAssigneeIds: readonly string[] = []): Promise<KanbanTaskMutation | null> {
    this.assertReady();
    const excluded = [...new Set(excludedAssigneeIds.map((assigneeId) => (
      requireNonEmpty(assigneeId, 'excluded assignee id')
    )))];
    return this.transaction(() => {
      const exclusionClause = excluded.length > 0
        ? `AND task.assignee_id NOT IN (${excluded.map(() => '?').join(', ')})`
        : '';
      const row = this.database.prepare(`
        SELECT task_id, assignee_id, title, detail, status, note, created_at, updated_at
        FROM kanban_tasks AS task
        WHERE task.status = 'todo'
          ${exclusionClause}
          AND NOT EXISTS (
            SELECT 1
            FROM kanban_task_dependencies AS dependency
            JOIN kanban_tasks AS prerequisite ON prerequisite.task_id = dependency.depends_on_task_id
            WHERE dependency.task_id = task.task_id AND prerequisite.status <> 'done'
          )
        ORDER BY task.created_at, task.task_id
        LIMIT 1
      `).get(...excluded) as TaskRow | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      const result = this.database.prepare(
        "UPDATE kanban_tasks SET status = 'doing', updated_at = ? WHERE task_id = ? AND status = 'todo'",
      ).run(now, row.task_id);
      if (result.changes !== 1) throw new Error(`Kanban task "${row.task_id}" could not be claimed.`);
      return this.mutationFor(row.task_id, 'claimed', 'todo', 'doing', undefined, now);
    });
  }

  async claimReadyTask(taskId: string): Promise<KanbanTaskMutation> {
    this.assertReady();
    const normalizedTaskId = requireNonEmpty(taskId, 'taskId');
    return this.transaction(() => {
      const row = this.database.prepare(
        'SELECT task_id, assignee_id, title, detail, status, note, created_at, updated_at FROM kanban_tasks WHERE task_id = ?',
      ).get(normalizedTaskId) as TaskRow | undefined;
      if (!row) throw new Error(`Kanban task "${normalizedTaskId}" does not exist.`);
      const current = requireStatus(row.status);
      if (current !== 'todo' && current !== 'blocked') {
        throw new Error(`Kanban task "${normalizedTaskId}" is ${current}, not startable.`);
      }
      const incomplete = this.database.prepare(`
        SELECT dependency.depends_on_task_id AS task_id
        FROM kanban_task_dependencies AS dependency
        JOIN kanban_tasks AS prerequisite ON prerequisite.task_id = dependency.depends_on_task_id
        WHERE dependency.task_id = ? AND prerequisite.status <> 'done'
        ORDER BY dependency.depends_on_task_id
        LIMIT 1
      `).get(normalizedTaskId) as { task_id: string } | undefined;
      if (incomplete) {
        throw new Error(
          `Kanban task "${normalizedTaskId}" is waiting for dependency "${incomplete.task_id}".`,
        );
      }
      const now = new Date().toISOString();
      const result = this.database.prepare(
        "UPDATE kanban_tasks SET status = 'doing', note = NULL, updated_at = ? WHERE task_id = ? AND status = ?",
      ).run(now, normalizedTaskId, current);
      if (result.changes !== 1) {
        throw new Error(`Kanban task "${normalizedTaskId}" could not be started.`);
      }
      return this.mutationFor(normalizedTaskId, 'claimed', current, 'doing', undefined, now);
    });
  }

  async completeTask(taskId: string, result: string): Promise<KanbanTaskMutation> {
    // A recovered execution is conservatively marked blocked because Kanban
    // cannot inspect Agent checkpoint state. A later explicit Agent report is
    // still authoritative and may close that task without any checkpoint coupling.
    return this.transition(taskId, ['doing', 'waiting', 'blocked'], 'done', 'completed', result);
  }

  async blockTask(taskId: string, reason: string): Promise<KanbanTaskMutation> {
    return this.transition(taskId, ['todo', 'doing', 'waiting'], 'blocked', 'blocked', reason);
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
          task.assigneeId,
          task.title,
          task.detail,
          task.status,
          task.note ?? null,
          task.createdAt,
          task.updatedAt,
        );
      }
      const insertDependency = this.database.prepare(
        'INSERT INTO kanban_task_dependencies(task_id, depends_on_task_id) VALUES (?, ?)',
      );
      for (const task of tasks) {
        for (const dependencyId of task.deps) insertDependency.run(task.taskId, dependencyId);
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
    note: string,
  ): Promise<KanbanTaskMutation> {
    this.assertReady();
    const normalizedTaskId = requireNonEmpty(taskId, 'taskId');
    const normalizedNote = requireNonEmpty(note, 'task note');
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
      ).run(target, normalizedNote, now, normalizedTaskId);
      return this.mutationFor(normalizedTaskId, eventType, current, target, normalizedNote, now);
    });
  }

  private readTask(row: TaskRow): KanbanTask {
    const dependencyRows = this.database.prepare(
      'SELECT depends_on_task_id FROM kanban_task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id',
    ).all(row.task_id) as Array<{ depends_on_task_id: string }>;
    return taskFromRow(row, dependencyRows.map(({ depends_on_task_id: taskId }) => taskId));
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
      task: this.readTask(task),
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
  private readonly listeners = new Set<(mutation: KanbanTaskMutation) => void>();
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

  subscribe(listener: (mutation: KanbanTaskMutation) => void): () => void {
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

  async claimNextReadyTask(excludedAssigneeIds?: readonly string[]): Promise<KanbanTaskMutation | null> {
    this.assertReady();
    const mutation = await this.repository.claimNextReadyTask(excludedAssigneeIds);
    return mutation ? this.publish(mutation) : null;
  }

  async claimReadyTask(taskId: string): Promise<KanbanTaskMutation> {
    return this.publish(await this.repository.claimReadyTask(taskId));
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

  private publish(mutation: KanbanTaskMutation): KanbanTaskMutation {
    for (const listener of this.listeners) {
      try {
        listener(mutation);
      } catch (error) {
        console.error(
          '[kanban] committed domain-event listener failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }
    return mutation;
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error('Kanban task service is not initialized.');
  }
}

export function createInMemoryKanbanTaskService(): KanbanTaskService {
  return new KanbanTaskService(new SqliteKanbanTaskRepository(':memory:'));
}
