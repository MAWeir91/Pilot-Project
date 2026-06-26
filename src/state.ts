import fs from "node:fs/promises";
import { DurableJsonFile, type JsonFileHealth } from "./durable-json.js";
import { DATA_DIR, STATE_FILE, assertAllowedPath } from "./paths.js";
import type { AutopilotRunRecord, PlanRecord, ProjectBriefRecord, TaskRecord, TaskState } from "./types.js";

const EMPTY_STATE: TaskState = { tasks: [], plans: [], projectBriefs: [], autopilotRuns: [] };

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(assertAllowedPath(DATA_DIR), { recursive: true });
}

export class StateStore {
  private readonly stateFile: string;
  private readonly file: DurableJsonFile<TaskState>;

  constructor(stateFile = STATE_FILE) {
    this.stateFile = assertAllowedPath(stateFile);
    this.file = new DurableJsonFile(this.stateFile, () => cloneState(EMPTY_STATE), normalizeTaskState);
  }

  async read(): Promise<TaskState> {
    await ensureDataDir();
    return await this.file.read();
  }

  async write(state: TaskState): Promise<void> {
    await ensureDataDir();
    await this.file.write(state);
  }

  async transaction<R>(updater: (state: TaskState) => R | Promise<R | { state: TaskState; result: R }>): Promise<R> {
    await ensureDataDir();
    return await this.file.update(updater);
  }

  async health(): Promise<JsonFileHealth> {
    return await this.file.health();
  }

  async addTask(task: TaskRecord): Promise<void> {
    await this.transaction((state) => {
      state.tasks.unshift(task);
    });
  }

  async updateTask(taskId: string, updater: (task: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    return await this.transaction((state) => {
      const index = state.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) {
        throw new Error(`Unknown taskId: ${taskId}`);
      }

      const updated = updater(state.tasks[index]);
      updated.updatedAt = new Date().toISOString();
      state.tasks[index] = updated;
      return updated;
    });
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    const state = await this.read();
    return state.tasks.find((task) => task.id === taskId);
  }

  async listTasks(): Promise<TaskRecord[]> {
    const state = await this.read();
    return [...state.tasks].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async latestTask(): Promise<TaskRecord | undefined> {
    const tasks = await this.listTasks();
    return tasks[0];
  }

  async addPlan(plan: PlanRecord): Promise<void> {
    await this.transaction((state) => {
      state.plans = state.plans ?? [];
      state.plans.unshift(plan);
    });
  }

  async updatePlan(planId: string, updater: (plan: PlanRecord) => PlanRecord): Promise<PlanRecord> {
    return await this.transaction((state) => {
      state.plans = state.plans ?? [];
      const index = state.plans.findIndex((plan) => plan.id === planId);
      if (index < 0) {
        throw new Error(`Unknown planId: ${planId}`);
      }

      const updated = updater(state.plans[index]);
      updated.updatedAt = new Date().toISOString();
      state.plans[index] = updated;
      return updated;
    });
  }

  async getPlan(planId: string): Promise<PlanRecord | undefined> {
    const state = await this.read();
    return (state.plans ?? []).find((plan) => plan.id === planId);
  }

  async listPlans(): Promise<PlanRecord[]> {
    const state = await this.read();
    return [...(state.plans ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async addProjectBrief(brief: ProjectBriefRecord): Promise<void> {
    await this.transaction((state) => {
      state.projectBriefs = state.projectBriefs ?? [];
      state.projectBriefs.unshift(brief);
    });
  }

  async getProjectBrief(briefId: string): Promise<ProjectBriefRecord | undefined> {
    const state = await this.read();
    return (state.projectBriefs ?? []).find((brief) => brief.id === briefId);
  }

  async listProjectBriefs(): Promise<ProjectBriefRecord[]> {
    const state = await this.read();
    return [...(state.projectBriefs ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async addAutopilotRun(run: AutopilotRunRecord): Promise<void> {
    await this.transaction((state) => {
      state.autopilotRuns = state.autopilotRuns ?? [];
      state.autopilotRuns.unshift(run);
    });
  }

  async updateAutopilotRun(
    runId: string,
    updater: (run: AutopilotRunRecord) => AutopilotRunRecord
  ): Promise<AutopilotRunRecord> {
    return await this.transaction((state) => {
      state.autopilotRuns = state.autopilotRuns ?? [];
      const index = state.autopilotRuns.findIndex((run) => run.id === runId);
      if (index < 0) {
        throw new Error(`Unknown autopilot runId: ${runId}`);
      }

      const updated = updater(state.autopilotRuns[index]);
      updated.updatedAt = new Date().toISOString();
      state.autopilotRuns[index] = updated;
      return updated;
    });
  }

  async getAutopilotRun(runId: string): Promise<AutopilotRunRecord | undefined> {
    const state = await this.read();
    return (state.autopilotRuns ?? []).find((run) => run.id === runId);
  }

  async listAutopilotRuns(): Promise<AutopilotRunRecord[]> {
    const state = await this.read();
    return [...(state.autopilotRuns ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

function normalizeTaskState(value: unknown): TaskState {
  const parsed = (value ?? {}) as Partial<TaskState>;
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    plans: Array.isArray(parsed.plans) ? parsed.plans : [],
    projectBriefs: Array.isArray(parsed.projectBriefs) ? parsed.projectBriefs : [],
    autopilotRuns: Array.isArray(parsed.autopilotRuns) ? parsed.autopilotRuns : []
  };
}

function cloneState(state: TaskState): TaskState {
  return JSON.parse(JSON.stringify(state)) as TaskState;
}
