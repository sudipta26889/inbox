import type {
  Label,
  Project,
  TaskState,
  WorkspaceMember,
} from "@/utils/taskpilot/types";

interface Entry<T> {
  expiresAt: number;
  value: T;
}

export interface TaskpilotCacheOptions {
  ttlMs: number;
}

export class TaskpilotCache {
  private readonly ttlMs: number;
  private readonly projects = new Map<string, Entry<Project[]>>();
  private readonly labels = new Map<string, Entry<Label[]>>();
  private readonly states = new Map<string, Entry<TaskState[]>>();
  private readonly members = new Map<string, Entry<WorkspaceMember[]>>();

  constructor(opts: TaskpilotCacheOptions) {
    this.ttlMs = opts.ttlMs;
  }

  async getProjects(
    userId: string,
    loader: () => Promise<Project[]>,
  ): Promise<Project[]> {
    return this.getOrLoad(this.projects, userId, loader);
  }

  async getLabels(
    userId: string,
    projectId: string,
    loader: () => Promise<Label[]>,
  ): Promise<Label[]> {
    return this.getOrLoad(this.labels, `${userId}:${projectId}`, loader);
  }

  async getStates(
    userId: string,
    projectId: string,
    loader: () => Promise<TaskState[]>,
  ): Promise<TaskState[]> {
    return this.getOrLoad(this.states, `${userId}:${projectId}`, loader);
  }

  async getMembers(
    userId: string,
    loader: () => Promise<WorkspaceMember[]>,
  ): Promise<WorkspaceMember[]> {
    return this.getOrLoad(this.members, userId, loader);
  }

  invalidateUser(userId: string): void {
    this.projects.delete(userId);
    this.members.delete(userId);
    const prefix = `${userId}:`;
    for (const key of this.labels.keys()) {
      if (key.startsWith(prefix)) this.labels.delete(key);
    }
    for (const key of this.states.keys()) {
      if (key.startsWith(prefix)) this.states.delete(key);
    }
  }

  private async getOrLoad<T>(
    store: Map<string, Entry<T>>,
    key: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = await loader();
    store.set(key, { expiresAt: now + this.ttlMs, value });
    return value;
  }
}

export const taskpilotCache = new TaskpilotCache({ ttlMs: 60 * 60 * 1000 });
