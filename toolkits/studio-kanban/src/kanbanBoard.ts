/**
 * 看板的领域模型。
 *
 * 它**只属于这个插件** —— studio 不认识 task、依赖、进度这些概念。
 *
 * 术语上用项目管理的通用词(task / done / blocked),不用看板专有的
 * 呈现词(card / column / swimlane):pet 接到的是**任务**,完成的是
 * **任务**;它在看板上长成一张卡,是上层怎么呈现的事,pet 不该知道。
 */

import { randomUUID } from 'node:crypto';

export type KanbanTaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'blocked';

export type KanbanTask = {
  taskId: string;
  /** 交给谁做。 */
  petId: string;
  /** 自然语言描述 —— 这就是 dispatch 出去的 request。 */
  brief: string;
  status: KanbanTaskStatus;
  /** 依赖的其他 taskId;全部 done 之后本任务才可派发。 */
  deps: string[];
  /** 完成时 pet 给出的结果;blocked 时是卡住的原因。 */
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type KanbanBoardSnapshot = {
  tasks: KanbanTask[];
};

/**
 * 看板状态。纯内存 + 可选落盘由调用方决定 —— 这里只管状态转移。
 */
export class KanbanBoard {
  private readonly tasks = new Map<string, KanbanTask>();
  private readonly listeners = new Set<(task: KanbanTask) => void>();

  private copy(task: KanbanTask): KanbanTask {
    return { ...task, deps: [...task.deps] };
  }

  subscribe(listener: (task: KanbanTask) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(task: KanbanTask): void {
    for (const listener of this.listeners) listener(this.copy(task));
  }

  add(input: { petId: string; brief: string; deps?: string[] }): KanbanTask {
    const now = new Date().toISOString();
    const task: KanbanTask = {
      taskId: randomUUID(),
      petId: input.petId,
      brief: input.brief,
      status: 'todo',
      deps: [...(input.deps ?? [])],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    this.emit(task);
    return this.copy(task);
  }

  list(): KanbanTask[] {
    return [...this.tasks.values()].map((task) => this.copy(task));
  }

  get(taskId: string): KanbanTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? this.copy(task) : undefined;
  }

  /**
   * 依赖已满足且尚未派发的任务。
   *
   * 注意它**不做**"队首阻塞则整体停止"的判断 —— 一个任务排不上不该
   * 连累其他已就绪的任务。
   */
  ready(): KanbanTask[] {
    return this.list().filter((task) => (
      task.status === 'todo'
      && task.deps.every((depId) => this.tasks.get(depId)?.status === 'done')
    ));
  }

  markDispatched(taskId: string): void {
    this.update(taskId, (task) => ({ ...task, status: 'doing' }));
  }

  complete(taskId: string, note?: string): KanbanTask {
    return this.update(taskId, (task) => ({
      ...task,
      status: 'done',
      ...(note !== undefined ? { note } : {}),
    }));
  }

  wait(taskId: string, reason: string): KanbanTask {
    return this.update(taskId, (task) => ({ ...task, status: 'waiting', note: reason }));
  }

  block(taskId: string, reason: string): KanbanTask {
    return this.update(taskId, (task) => ({ ...task, status: 'blocked', note: reason }));
  }

  snapshot(): KanbanBoardSnapshot {
    return { tasks: this.list().map((task) => ({ ...task })) };
  }

  restore(snapshot: KanbanBoardSnapshot): void {
    this.tasks.clear();
    for (const task of snapshot.tasks) {
      if (this.tasks.has(task.taskId)) {
        throw new Error(`kanban: duplicate taskId "${task.taskId}" in snapshot`);
      }
      // 进程已经不在了,任何 doing 都不可能还在跑 —— 恢复为 blocked
      // 而不是悄悄回到 todo:重来与否是人的判断。
      this.tasks.set(task.taskId, task.status === 'doing'
        ? {
            ...task,
            deps: [...task.deps],
            status: 'blocked',
            note: task.note ?? 'interrupted by restart',
          }
        : { ...task, deps: [...task.deps] });
    }
  }

  private update(taskId: string, patch: (task: KanbanTask) => KanbanTask): KanbanTask {
    const current = this.tasks.get(taskId);
    if (!current) {
      throw new Error(`kanban: unknown taskId "${taskId}"`);
    }
    const next = { ...patch(current), updatedAt: new Date().toISOString() };
    this.tasks.set(taskId, next);
    this.emit(next);
    return this.copy(next);
  }
}
