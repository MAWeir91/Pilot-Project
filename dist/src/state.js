import fs from "node:fs/promises";
import { DurableJsonFile } from "./durable-json.js";
import { DATA_DIR, STATE_FILE, assertAllowedPath } from "./paths.js";
const EMPTY_STATE = { tasks: [], plans: [], projectBriefs: [], autopilotRuns: [] };
export async function ensureDataDir() {
    await fs.mkdir(assertAllowedPath(DATA_DIR), { recursive: true });
}
export class StateStore {
    stateFile;
    file;
    constructor(stateFile = STATE_FILE) {
        this.stateFile = assertAllowedPath(stateFile);
        this.file = new DurableJsonFile(this.stateFile, () => cloneState(EMPTY_STATE), normalizeTaskState);
    }
    async read() {
        await ensureDataDir();
        return await this.file.read();
    }
    async write(state) {
        await ensureDataDir();
        await this.file.write(state);
    }
    async transaction(updater) {
        await ensureDataDir();
        return await this.file.update(updater);
    }
    async health() {
        return await this.file.health();
    }
    async addTask(task) {
        await this.transaction((state) => {
            state.tasks.unshift(task);
        });
    }
    async updateTask(taskId, updater) {
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
    async getTask(taskId) {
        const state = await this.read();
        return state.tasks.find((task) => task.id === taskId);
    }
    async listTasks() {
        const state = await this.read();
        return [...state.tasks].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
    async latestTask() {
        const tasks = await this.listTasks();
        return tasks[0];
    }
    async addPlan(plan) {
        await this.transaction((state) => {
            state.plans = state.plans ?? [];
            state.plans.unshift(plan);
        });
    }
    async updatePlan(planId, updater) {
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
    async getPlan(planId) {
        const state = await this.read();
        return (state.plans ?? []).find((plan) => plan.id === planId);
    }
    async listPlans() {
        const state = await this.read();
        return [...(state.plans ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
    async addProjectBrief(brief) {
        await this.transaction((state) => {
            state.projectBriefs = state.projectBriefs ?? [];
            state.projectBriefs.unshift(brief);
        });
    }
    async getProjectBrief(briefId) {
        const state = await this.read();
        return (state.projectBriefs ?? []).find((brief) => brief.id === briefId);
    }
    async listProjectBriefs() {
        const state = await this.read();
        return [...(state.projectBriefs ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
    async addAutopilotRun(run) {
        await this.transaction((state) => {
            state.autopilotRuns = state.autopilotRuns ?? [];
            state.autopilotRuns.unshift(run);
        });
    }
    async updateAutopilotRun(runId, updater) {
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
    async getAutopilotRun(runId) {
        const state = await this.read();
        return (state.autopilotRuns ?? []).find((run) => run.id === runId);
    }
    async listAutopilotRuns() {
        const state = await this.read();
        return [...(state.autopilotRuns ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
}
function normalizeTaskState(value) {
    const parsed = (value ?? {});
    return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        plans: Array.isArray(parsed.plans) ? parsed.plans : [],
        projectBriefs: Array.isArray(parsed.projectBriefs) ? parsed.projectBriefs : [],
        autopilotRuns: Array.isArray(parsed.autopilotRuns) ? parsed.autopilotRuns : []
    };
}
function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
}
