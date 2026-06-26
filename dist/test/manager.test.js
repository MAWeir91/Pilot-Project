import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutopilotService, NullAutopilotNotifier, managerModeConfig, validateManagerDecision } from "../src/manager.js";
import { dataPath } from "../src/paths.js";
import { ProjectRegistry } from "../src/projects.js";
import { StateStore } from "../src/state.js";
const FILES = [];
afterEach(async () => {
    await Promise.allSettled(FILES.splice(0).map((file) => fs.unlink(file)));
});
describe("manager mode", () => {
    it("validates manager decisions and rejects arbitrary command output", () => {
        expect(validateManagerDecision(decision("stop", "Done"))).toMatchObject({ action: "stop" });
        expect(() => validateManagerDecision({ action: "run_shell", command: "npm test" })).toThrow();
    });
    it("pauses when the manager API fails", async () => {
        const { service, store } = await harness({
            manager: { decide: async () => { throw new Error("api unavailable"); } },
            configured: true
        });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("blocked");
        expect(status.pauseReason).toMatch(/api unavailable/);
    });
    it("records malformed manager decision diagnostics and accepts one correction attempt", async () => {
        const manager = fakeManager([
            { action: "complete_task" },
            decision("pause_for_blocker", "Corrected decision", { reason: "Need input" })
        ]);
        const { service, jobs } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(manager.decide).toHaveBeenCalledTimes(2);
        expect(status.status).toBe("blocked");
        expect(status.timeline.some((entry) => entry.summary.includes("manager_decision_invalid"))).toBe(true);
        expect(status.timeline.some((entry) => entry.summary.includes("manager_decision_corrected"))).toBe(true);
        expect(jobs.startBuild).not.toHaveBeenCalled();
    });
    it("rejects unknown approve_task action with readable diagnostics", async () => {
        const invalid = { ...decision("stop", "Bad"), action: "approve_task" };
        const manager = fakeManager([invalid, invalid]);
        const { service, jobs } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.pauseReason).toMatch(/manager_decision_invalid/);
        expect(status.pauseReason).toMatch(/action/);
        expect(status.timeline.some((entry) => entry.summary.includes("action=approve_task"))).toBe(true);
        expect(jobs.startBuild).not.toHaveBeenCalled();
    });
    it("rejects missing summary with readable diagnostics", async () => {
        const invalid = { action: "stop", reason: null, taskId: null, tasks: null, fixTask: null };
        const manager = fakeManager([invalid, invalid]);
        const { service } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.pauseReason).toMatch(/manager_decision_invalid/);
        expect(status.pauseReason).toMatch(/summary/);
        expect(status.timeline.some((entry) => entry.summary.includes("missing=summary"))).toBe(true);
    });
    it("rejects nested wrongly extracted response payloads", async () => {
        const invalid = { decision: decision("stop", "Nested") };
        const manager = fakeManager([invalid, invalid]);
        const { service, jobs } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.pauseReason).toMatch(/manager_decision_invalid/);
        expect(status.timeline.some((entry) => entry.summary.includes("missing=action, summary"))).toBe(true);
        expect(jobs.startBuild).not.toHaveBeenCalled();
    });
    it("blocks repeated malformed manager decisions without launching a worker", async () => {
        const manager = fakeManager([{ action: "complete_task" }, { action: "run_shell", summary: "" }]);
        const { service, jobs } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("blocked");
        expect(status.pauseReason).toMatch(/manager_decision_invalid/);
        expect(status.pauseReason).not.toMatch(/usage/i);
        expect(jobs.startBuild).not.toHaveBeenCalled();
    });
    it("keeps manager quota errors distinct from schema errors", async () => {
        const quotaError = new Error("429 You exceeded your current quota");
        quotaError.status = 429;
        const { service, store } = await harness({
            manager: { decide: async () => { throw quotaError; } },
            configured: true
        });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("blocked");
        expect(status.pauseReason).toMatch(/manager_api_quota_error/);
        expect(status.pauseReason).not.toMatch(/manager_decision_invalid/);
    });
    it("pauses when Manager Mode is not configured", async () => {
        const { service } = await harness({ configured: false });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("blocked");
        expect(status.pauseReason).toMatch(/OPENAI_API_KEY is not configured/);
    });
    it("does not count paused wall-clock time against active runtime", async () => {
        let now = Date.parse("2026-06-24T06:00:00.000Z");
        const manager = fakeManager([decision("finalize_project", "Done")]);
        const { service, store } = await harness({
            manager,
            configured: true,
            now: () => new Date(now).toISOString()
        });
        const run = await createStartedRun(service, { maxRuntimeMs: 1_000 });
        now += 60 * 60 * 1000;
        await service.pauseAutopilot(run.runId, "Waiting for user.");
        now += 60 * 60 * 1000;
        await service.resumeAutopilot(run.runId);
        await waitUntil(async () => (await service.getAutopilotStatus(run.runId)).status === "completed");
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("completed");
        expect(status.activeRuntimeMs ?? 0).toBeLessThanOrEqual(1_000);
    });
    it("does not count blocked quota-wait time against active runtime", async () => {
        let now = Date.parse("2026-06-24T06:00:00.000Z");
        const quotaError = new Error("429 quota");
        quotaError.status = 429;
        const manager = fakeManagerWithImplementation(async () => {
            if (manager.decide.mock.calls.length === 1) {
                throw quotaError;
            }
            return decision("finalize_project", "Done");
        });
        const { service, store } = await harness({
            manager,
            configured: true,
            now: () => new Date(now).toISOString()
        });
        const run = await createStartedRun(service, { maxRuntimeMs: 1_000 });
        await service.tick(run.runId);
        now += 60 * 60 * 1000;
        await service.resumeAutopilot(run.runId);
        await waitUntil(async () => (await service.getAutopilotStatus(run.runId)).status === "completed");
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("completed");
        expect(status.pauseReason).toBeUndefined();
    });
    it("does not double-count active runtime on server restart", async () => {
        const { service, store } = await harness({ configured: true });
        const run = await createStartedRun(service);
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            status: "running",
            phase: "building",
            activeRuntimeMs: 1_000,
            activeRuntimeStartedAt: "2026-06-24T06:00:00.000Z"
        }));
        await service.reconcileAndResume();
        await waitUntil(async () => (await service.getAutopilotStatus(run.runId)).status !== "running");
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.activeRuntimeMs).toBe(1_000);
        expect(status.activeRuntimeStartedAt).toBeUndefined();
    });
    it("repeated resume attempts do not double-count active runtime", async () => {
        let now = Date.parse("2026-06-24T06:00:00.000Z");
        const manager = fakeManager([decision("pause_for_blocker", "Need input", { reason: "Need input" })]);
        const { service, store } = await harness({
            manager,
            configured: true,
            now: () => new Date(now).toISOString()
        });
        const run = await createStartedRun(service, { maxRuntimeMs: 10_000 });
        await service.tick(run.runId);
        const first = await service.getAutopilotStatus(run.runId);
        now += 60 * 60 * 1000;
        await service.resumeAutopilot(run.runId);
        await service.resumeAutopilot(run.runId);
        await waitUntil(async () => (await service.getAutopilotStatus(run.runId)).status === "stopped");
        const after = await service.getAutopilotStatus(run.runId);
        expect((after.activeRuntimeMs ?? 0) - (first.activeRuntimeMs ?? 0)).toBeLessThanOrEqual(10_000);
    });
    it("updates a paused run's limits without creating duplicate work", async () => {
        const { service, store, jobs } = await harness({ configured: true });
        const run = await createStartedRun(service);
        await service.pauseAutopilot(run.runId, "Waiting.");
        const before = await store.read();
        const updated = await service.updateAutopilotLimits({
            runId: run.runId,
            maxRuntimeMs: 28_800_000,
            maxManagerDecisions: 100,
            maxTasks: 10,
            maxFixAttemptsPerTask: 2,
            reason: "User approved a longer local run."
        });
        const after = await store.read();
        expect(updated.limits.maxRuntimeMs).toBe(28_800_000);
        expect(after.autopilotRuns).toHaveLength(before.autopilotRuns?.length ?? 0);
        expect(after.tasks).toHaveLength(before.tasks.length);
        expect(jobs.startBuild).not.toHaveBeenCalled();
        expect(updated.timeline.at(-1)?.data).toMatchObject({
            reason: "User approved a longer local run."
        });
    });
    it("blocks only after active runtime exceeds the configured limit", async () => {
        let now = Date.parse("2026-06-24T06:00:00.000Z");
        const manager = fakeManager([decision("pause_for_blocker", "Still under", { reason: "Still under" })]);
        const { service, store } = await harness({
            manager,
            configured: true,
            now: () => new Date(now).toISOString()
        });
        const run = await createStartedRun(service, { maxRuntimeMs: 1_000 });
        await service.pauseAutopilot(run.runId, "Waiting.");
        now += 60 * 60 * 1000;
        await service.resumeAutopilot(run.runId);
        await waitUntil(async () => (await service.getAutopilotStatus(run.runId)).status === "blocked");
        const under = await service.getAutopilotStatus(run.runId);
        expect(under.pauseReason).not.toMatch(/runtime budget/);
        await service.updateAutopilotLimits({ runId: run.runId, maxRuntimeMs: 1, reason: "Test small active budget." });
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            status: "paused",
            activeRuntimeMs: 2,
            activeRuntimeStartedAt: undefined
        }));
        await service.resumeAutopilot(run.runId);
        await waitUntil(async () => (await service.getAutopilotStatus(run.runId)).status === "usage-limited");
        const limited = await service.getAutopilotStatus(run.runId);
        expect(limited.pauseReason).toMatch(/runtime budget/);
    });
    it("repairs a completed-task run without rerunning completed work", async () => {
        const taskId = "task-2026-06-24T06-00-00-000Z-donework";
        const { service, store, jobs } = await harness({ configured: true });
        const run = await createStartedRun(service);
        await store.addTask({
            ...readyTask(taskId),
            status: "completed",
            completedAt: "2026-06-24T06:03:00.000Z"
        });
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            status: "usage-limited",
            phase: "paused",
            pauseReason: "Manager runtime budget reached.",
            lastCompletedTaskId: taskId,
            queue: [
                {
                    id: "queue-done",
                    title: "Done work",
                    requirements: "Done.",
                    acceptanceCriteria: ["Done."],
                    source: "manager",
                    taskId,
                    status: "completed",
                    createdAt: "2026-06-24T06:00:00.000Z",
                    updatedAt: "2026-06-24T06:03:00.000Z"
                }
            ]
        }));
        await service.updateAutopilotLimits({ runId: run.runId, maxRuntimeMs: 28_800_000, reason: "Repair existing run." });
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("paused");
        expect(status.lastCompletedTaskId).toBe(taskId);
        expect(status.queue[0].status).toBe("completed");
        expect(jobs.startBuild).not.toHaveBeenCalled();
        expect(jobs.runReview).not.toHaveBeenCalled();
    });
    it("dispatches queued recovery without another manager decision or restart", async () => {
        const manager = fakeManager([decision("finalize_project", "Should not be used")]);
        const { service, store, jobs } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        const originalTaskId = "task-2026-06-24T06-00-00-000Z-original";
        await store.addTask(blockedLostWorkerTask(originalTaskId));
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            currentTaskId: originalTaskId,
            phase: "fixing",
            queue: [
                {
                    id: "queue-recovery",
                    title: "Revalidate storage",
                    requirements: "Operational recovery.",
                    acceptanceCriteria: ["Build passes."],
                    source: "recovery",
                    fixAttemptForTaskId: originalTaskId,
                    status: "queued",
                    createdAt: "2026-06-24T06:00:00.000Z",
                    updatedAt: "2026-06-24T06:00:00.000Z"
                }
            ]
        }));
        await service.tick(run.runId);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(jobs.startBuild).toHaveBeenCalledTimes(1);
        expect(manager.decide).not.toHaveBeenCalled();
        expect(status.recoveryAttemptsByTaskId?.[originalTaskId]).toBe(1);
        expect(status.fixAttemptsByTaskId[originalTaskId]).toBeUndefined();
        expect(status.workers?.some((worker) => worker.attemptType === "recovery")).toBe(true);
    });
    it("does not launch a queued recovery worker before persisting the launch transition", async () => {
        const { service, store, jobs, project } = await harness({ configured: true });
        const run = await createStartedRun(service);
        const originalTaskId = "task-2026-06-24T06-00-00-000Z-persist1";
        const preparedTask = preparedRecoveryTask("task-2026-06-24T06-00-00-000Z-recover1");
        await store.addTask(blockedLostWorkerTask(originalTaskId));
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            queue: [recoveryQueueItem(originalTaskId)]
        }));
        const preparedJobs = jobs;
        preparedJobs.prepareBuild = vi.fn(async (input) => ({
            task: { ...preparedTask, projectId: input.projectId },
            project,
            input,
            logPath: preparedTask.build.logPath
        }));
        preparedJobs.launchPreparedBuild = vi.fn(async () => undefined);
        const originalTransaction = store.transaction.bind(store);
        let failLaunchTransaction = true;
        vi.spyOn(store, "transaction").mockImplementation(async (updater) => {
            if (preparedJobs.prepareBuild.mock.calls.length > 0 && failLaunchTransaction) {
                failLaunchTransaction = false;
                throw new Error("state_store_unavailable test failure");
            }
            return await originalTransaction(updater);
        });
        await expect(service.tick(run.runId)).rejects.toThrow(/state_store_unavailable test failure/);
        expect(preparedJobs.launchPreparedBuild).not.toHaveBeenCalled();
        expect(await store.getTask(preparedTask.id)).toBeUndefined();
    });
    it("does not create duplicate recovery tasks or workers after a state-store retry", async () => {
        const { service, store, jobs, project } = await harness({ configured: true });
        const run = await createStartedRun(service);
        const originalTaskId = "task-2026-06-24T06-00-00-000Z-persist2";
        const preparedTask = preparedRecoveryTask("task-2026-06-24T06-00-00-000Z-recover2");
        await store.addTask(blockedLostWorkerTask(originalTaskId));
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            queue: [recoveryQueueItem(originalTaskId)]
        }));
        const preparedJobs = jobs;
        preparedJobs.prepareBuild = vi.fn(async (input) => ({
            task: { ...preparedTask, projectId: input.projectId },
            project,
            input,
            logPath: preparedTask.build.logPath
        }));
        preparedJobs.launchPreparedBuild = vi.fn(async () => undefined);
        const originalTransaction = store.transaction.bind(store);
        let failLaunchTransaction = true;
        vi.spyOn(store, "transaction").mockImplementation(async (updater) => {
            if (preparedJobs.prepareBuild.mock.calls.length > 0 && failLaunchTransaction) {
                failLaunchTransaction = false;
                throw new Error("state_store_unavailable test failure");
            }
            return await originalTransaction(updater);
        });
        await expect(service.tick(run.runId)).rejects.toThrow(/state_store_unavailable test failure/);
        await service.tick(run.runId);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        const tasks = await store.listTasks();
        expect(preparedJobs.launchPreparedBuild).toHaveBeenCalledTimes(1);
        expect(tasks.filter((task) => task.id === preparedTask.id)).toHaveLength(1);
        expect(status.workers?.filter((worker) => worker.taskId === preparedTask.id)).toHaveLength(1);
    });
    it("single-flight scheduler ticks cannot launch duplicate workers", async () => {
        const { service, store, jobs } = await harness({ configured: true });
        const run = await createStartedRun(service);
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            queue: [
                {
                    id: "queue-slow",
                    title: "Slow task",
                    requirements: "Slow.",
                    acceptanceCriteria: ["Done."],
                    source: "manager",
                    status: "queued",
                    createdAt: "2026-06-24T06:00:00.000Z",
                    updatedAt: "2026-06-24T06:00:00.000Z"
                }
            ]
        }));
        await Promise.all([service.tick(run.runId), service.tick(run.runId), service.tick(run.runId)]);
        expect(jobs.startBuild).toHaveBeenCalledTimes(1);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.queue.filter((item) => item.status === "active")).toHaveLength(1);
    });
    it("queues one operational recovery for a stale blocked current task", async () => {
        const taskId = "task-2026-06-24T06-00-00-000Z-lostpid1";
        const { service, store } = await harness({ configured: true });
        const run = await createStartedRun(service);
        await store.addTask(blockedLostWorkerTask(taskId));
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            currentTaskId: taskId,
            phase: "idle"
        }));
        await service.tick(run.runId);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.queue.filter((item) => item.source === "recovery" && item.fixAttemptForTaskId === taskId)).toHaveLength(1);
        expect(status.currentTaskId).toBeDefined();
    });
    it("rejects malformed runtime environment values", () => {
        expect(() => managerModeConfig({ PROJECT_PILOT_MANAGER_MAX_RUNTIME_MS: "3=72000000" })).toThrow(/Invalid positive integer/);
    });
    it("runs bounded sequential completion through existing job operations", async () => {
        const decisions = fakeManager([
            decision("create_ordered_tasks", "Queue one task", { tasks: [taskSpec("Build screen")] }),
            decision("finalize_project", "Project complete")
        ]);
        const { service, jobs } = await harness({ manager: decisions, configured: true });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        await service.tick(run.runId);
        await service.tick(run.runId);
        await service.tick(run.runId);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(jobs.startBuild).toHaveBeenCalledTimes(1);
        expect(jobs.runReview).toHaveBeenCalledTimes(1);
        expect(jobs.finalizeTask).toHaveBeenCalledTimes(1);
        expect(status.status).toBe("completed");
        expect(status.lastCompletedTaskId).toBeDefined();
    });
    it("handles a valid finalize_current_task decision", async () => {
        const taskId = "task-2026-06-24T06-00-00-000Z-final123";
        const manager = fakeManager([decision("finalize_current_task", "Finalize safe task", { taskId })]);
        const { service, store, jobs } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await store.addTask(readyTask(taskId));
        await store.updateAutopilotRun(run.runId, (existing) => ({ ...existing, currentTaskId: taskId }));
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(jobs.finalizeTask).toHaveBeenCalledWith(taskId);
        expect(status.lastCompletedTaskId).toBe(taskId);
        expect(status.currentTaskId).toBeUndefined();
    });
    it("handles a valid finalize_project decision", async () => {
        const manager = fakeManager([decision("finalize_project", "Project is complete")]);
        const { service } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("completed");
        expect(status.completionSummary).toBe("Project is complete");
    });
    it("pauses when reviewer fix limit is reached", async () => {
        const { service, store } = await harness({ configured: true });
        const run = await createStartedRun(service, { maxFixAttemptsPerTask: 1 });
        const taskId = "task-2026-06-24T06-00-00-000Z-aaaaaaaa";
        await store.addTask(needsFixesTask(taskId));
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            currentTaskId: taskId,
            fixAttemptsByTaskId: { [taskId]: 1 }
        }));
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("blocked");
        expect(status.pauseReason).toMatch(/still needs fixes/);
    });
    it("prevents duplicate worker starts while a tick is active", async () => {
        let resolveDecision = () => undefined;
        const decide = vi.fn(async (_context) => await new Promise((resolve) => {
            resolveDecision = resolve;
        }));
        const manager = {
            decide
        };
        const { service } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        const first = service.tick(run.runId);
        const second = service.tick(run.runId);
        await waitUntil(() => decide.mock.calls.length === 1);
        resolveDecision(decision("pause_for_blocker", "Need input", { reason: "Need input" }));
        await Promise.all([first, second]);
        expect(decide).toHaveBeenCalledTimes(1);
    });
    it("reconciles and resumes active runs without immediately duplicating a running tick", async () => {
        const manager = fakeManager([decision("pause_for_blocker", "Need input", { reason: "Need input" })]);
        const { service } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await service.reconcileAndResume();
        await waitUntil(async () => (await service.getAutopilotStatus(run.runId)).status === "blocked");
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.status).toBe("blocked");
        expect(manager.decide).toHaveBeenCalledTimes(1);
    });
    it("cancels duplicate queued tasks before manager decisions on resume", async () => {
        const manager = fakeManager([decision("pause_for_blocker", "Need input", { reason: "Need input" })]);
        const { service, store, jobs } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await store.addTask({
            id: "task-2026-06-24T06-00-00-000Z-ready123",
            projectId: "trade-journal-lite",
            title: "Set up local Vite + TypeScript foundation",
            requirements: "Foundation complete.",
            acceptanceCriteria: ["Done."],
            status: "ready-for-approval",
            createdAt: "2026-06-24T06:00:00.000Z",
            updatedAt: "2026-06-24T06:03:00.000Z",
            build: { status: "passed", logPath: dataPath("ready.build.jsonl") },
            review: { status: "passed", result: "pass", logPath: dataPath("ready.review.jsonl") }
        });
        await store.addTask({
            id: "task-2026-06-24T06-00-01-000Z-dupe1234",
            projectId: "trade-journal-lite",
            title: "Set up local Vite + TypeScript foundation",
            requirements: "Duplicate foundation work.",
            acceptanceCriteria: ["Done."],
            status: "queued",
            createdAt: "2026-06-24T06:00:01.000Z",
            updatedAt: "2026-06-24T06:00:01.000Z",
            build: { status: "queued", logPath: dataPath("dupe.build.jsonl") }
        });
        await service.tick(run.runId);
        const duplicate = await store.getTask("task-2026-06-24T06-00-01-000Z-dupe1234");
        const status = await service.getAutopilotStatus(run.runId);
        expect(duplicate?.status).toBe("stopped");
        expect(duplicate?.build.error).toMatch(/Cancelled as duplicate/);
        expect(status.timeline.some((entry) => entry.summary.includes("duplicate queued task"))).toBe(true);
        expect(jobs.startBuild).not.toHaveBeenCalled();
    });
    it("resumes an existing blocked run without creating a new run, brief, plan, or duplicate task", async () => {
        const manager = fakeManager([decision("pause_for_blocker", "Need input", { reason: "Need input" })]);
        const { service, store } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            status: "blocked",
            phase: "paused",
            pauseReason: "manager_decision_invalid: previous failure"
        }));
        const before = await store.read();
        await service.resumeAutopilot(run.runId);
        await waitUntil(async () => (await service.getAutopilotStatus(run.runId)).status === "blocked");
        const after = await store.read();
        expect(after.autopilotRuns).toHaveLength(before.autopilotRuns?.length ?? 0);
        expect(after.projectBriefs).toHaveLength(before.projectBriefs?.length ?? 0);
        expect(after.plans).toHaveLength(before.plans?.length ?? 0);
        expect(after.tasks).toHaveLength(before.tasks.length);
    });
    it("finalizes a reviewed local-only foundation task through manager decision", async () => {
        const taskId = "task-2026-06-25T01-36-32-141Z-5873a120";
        const manager = fakeManager([decision("finalize_current_task", "Finalize reviewed local-only foundation task", { taskId })]);
        const { service, store } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await store.addTask(readyTask(taskId));
        await store.updateAutopilotRun(run.runId, (existing) => ({ ...existing, currentTaskId: taskId }));
        await service.tick(run.runId);
        const saved = await store.getTask(taskId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(saved?.status).toBe("completed");
        expect(status.lastCompletedTaskId).toBe(taskId);
    });
    it("review pass reconciliation leaves the reviewing phase without asking the manager", async () => {
        const taskId = "task-2026-06-24T06-00-00-000Z-reviewed";
        const manager = fakeManager([decision("start_next_task", "Should not be used")]);
        const { service, store, jobs } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await store.addTask({
            ...readyTask(taskId),
            status: "reviewing"
        });
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            phase: "reviewing",
            currentTaskId: taskId
        }));
        jobs.reconcileTaskForAutopilot = vi.fn(async (id) => {
            await store.updateTask(id, (task) => ({
                ...task,
                status: "completed",
                completedAt: "2026-06-24T06:03:00.000Z"
            }));
            return (await store.getTask(id));
        });
        await service.tick(run.runId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(status.phase).toBe("idle");
        expect(status.currentTaskId).toBeUndefined();
        expect(status.lastCompletedTaskId).toBe(taskId);
        expect(manager.decide).not.toHaveBeenCalled();
    });
    it("resume does not rerun a task whose build and review already passed", async () => {
        const taskId = "task-2026-06-24T06-00-00-000Z-passedrv";
        const { service, store, jobs } = await harness({ configured: true });
        const run = await createStartedRun(service);
        await store.addTask(readyTask(taskId));
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            phase: "reviewing",
            currentTaskId: taskId
        }));
        jobs.reconcileTaskForAutopilot = vi.fn(async (id) => {
            await store.updateTask(id, (task) => ({
                ...task,
                status: "completed",
                completedAt: "2026-06-24T06:03:00.000Z"
            }));
            return (await store.getTask(id));
        });
        await service.tick(run.runId);
        expect(jobs.startBuild).not.toHaveBeenCalled();
        expect(jobs.runReview).not.toHaveBeenCalled();
        expect(jobs.reconcileTaskForAutopilot).toHaveBeenCalledWith(taskId);
    });
    it("reconciles a current run without creating a new task or Autopilot run", async () => {
        const taskId = "task-2026-06-24T06-00-00-000Z-currentr";
        const { service, store, jobs } = await harness({ configured: true });
        const run = await createStartedRun(service);
        await store.addTask(readyTask(taskId));
        await store.updateAutopilotRun(run.runId, (existing) => ({
            ...existing,
            phase: "reviewing",
            currentTaskId: taskId
        }));
        const before = await store.read();
        jobs.reconcileTaskForAutopilot = vi.fn(async (id) => {
            await store.updateTask(id, (task) => ({
                ...task,
                status: "completed",
                completedAt: "2026-06-24T06:03:00.000Z"
            }));
            return (await store.getTask(id));
        });
        await service.tick(run.runId);
        const after = await store.read();
        expect(after.autopilotRuns).toHaveLength(before.autopilotRuns?.length ?? 0);
        expect(after.tasks).toHaveLength(before.tasks.length);
    });
    it("skips a duplicate foundation task once with an audit record", async () => {
        const taskId = "task-2026-06-25T01-36-16-575Z-5ffeec9f";
        const manager = fakeManager([
            decision("skip_duplicate_task", "Skip duplicate foundation task", {
                taskId,
                reason: "Duplicate of completed foundation task."
            })
        ]);
        const { service, store, jobs } = await harness({ manager, configured: true });
        const run = await createStartedRun(service);
        await store.addTask(readyTask("task-2026-06-25T01-36-32-141Z-5873a120"));
        await store.addTask({
            ...readyTask(taskId),
            status: "queued",
            build: { status: "queued", logPath: dataPath("duplicate-foundation.build.jsonl") },
            review: undefined
        });
        await service.tick(run.runId);
        const saved = await store.getTask(taskId);
        const status = await service.getAutopilotStatus(run.runId);
        expect(jobs.cancelDuplicateQueuedTask).toHaveBeenCalledTimes(1);
        expect(saved?.status).toBe("stopped");
        expect(status.timeline.some((entry) => entry.summary.includes("Skipped duplicate task"))).toBe(true);
    });
});
async function harness(options = {}) {
    const stateFile = dataPath(`manager-${FILES.length}.json`);
    const registryFile = dataPath(`manager-projects-${FILES.length}.json`);
    FILES.push(stateFile, registryFile);
    const store = new StateStore(stateFile);
    const projects = new ProjectRegistry(registryFile, () => "2026-06-24T06:00:00.000Z");
    const project = await projects.getActiveProject();
    const jobs = fakeJobs(store);
    const service = new AutopilotService({
        store,
        projects,
        jobs: jobs,
        manager: options.manager ?? fakeManager([decision("pause_for_blocker", "Need input", { reason: "Need input" })]),
        architect: options.architect ?? { consult: async () => ({ threadId: "thread-1", summary: "Architecture summary" }) },
        notifier: new NullAutopilotNotifier(),
        config: {
            configured: options.configured ?? true,
            managerModel: "test-manager",
            maxManagerDecisionsPerRun: 10,
            maxTasksPerRun: 5,
            maxFixAttemptsPerTask: 1,
            maxManagerRuntimeMs: 60_000
        },
        now: options.now ?? (() => "2026-06-24T06:10:00.000Z"),
        autoSchedule: options.autoSchedule ?? false
    });
    return { service, store, projects, project, jobs };
}
async function createStartedRun(service, limits = {}) {
    const brief = await service.createProjectBrief({
        projectId: "trade-journal-lite",
        title: "Brief",
        productSummary: "Local app",
        requirements: "Build a local feature.",
        constraints: "No external services.",
        decisions: [],
        definitionOfDone: ["Checks pass."]
    });
    return await service.startAutopilot({
        briefId: brief.briefId,
        limits
    });
}
function fakeManager(decisions) {
    const decide = vi.fn(async (_context) => decisions.shift() ?? decision("stop", "Stop"));
    return { decide };
}
function fakeManagerWithImplementation(implementation) {
    const decide = vi.fn(implementation);
    return { decide };
}
function decision(action, summary, overrides = {}) {
    return {
        action,
        summary,
        reason: null,
        taskId: null,
        tasks: null,
        fixTask: null,
        ...overrides
    };
}
function fakeJobs(store) {
    return {
        startBuild: vi.fn(async (input) => {
            const taskId = `task-2026-06-24T06-00-00-000Z-${String(Math.random()).slice(2, 10).padEnd(8, "0")}`;
            await store.addTask({
                id: taskId,
                projectId: input.projectId,
                title: input.title,
                requirements: input.requirements,
                acceptanceCriteria: input.acceptanceCriteria,
                status: "build-passed",
                createdAt: "2026-06-24T06:00:00.000Z",
                updatedAt: "2026-06-24T06:00:00.000Z",
                build: {
                    status: "passed",
                    logPath: dataPath(`${taskId}.build.jsonl`),
                    endedAt: "2026-06-24T06:01:00.000Z",
                    exitCode: 0
                }
            });
            return { taskId, status: "queued" };
        }),
        runReview: vi.fn(async (taskId) => {
            await store.updateTask(taskId, (task) => ({
                ...task,
                status: "ready-for-approval",
                review: {
                    status: "passed",
                    result: "pass",
                    logPath: dataPath(`${taskId}.review.jsonl`),
                    endedAt: "2026-06-24T06:02:00.000Z",
                    exitCode: 0
                }
            }));
            return { taskId, taskStatus: "ready-for-approval" };
        }),
        finalizeTask: vi.fn(async (taskId) => {
            await store.updateTask(taskId, (task) => ({
                ...task,
                status: "completed",
                completedAt: "2026-06-24T06:03:00.000Z"
            }));
            return { taskId, status: "completed" };
        }),
        listTasks: vi.fn(async () => ({
            tasks: (await store.listTasks()).map((task) => taskSummary(task))
        })),
        getTaskDetails: vi.fn(async (taskId) => {
            const task = await store.getTask(taskId);
            if (!task) {
                throw new Error(`Unknown taskId: ${taskId}`);
            }
            return {
                ...taskSummary(task),
                requirements: task.requirements,
                acceptanceCriteria: task.acceptanceCriteria,
                statusHistory: [],
                errors: [],
                buildLog: "",
                reviewLog: "",
                buildReport: task.build.status === "passed" ? "Build passed." : null,
                reviewReport: task.review?.result === "pass" ? "Review passed." : null
            };
        }),
        getPlanDetails: vi.fn(async (planId) => {
            throw new Error(`Unknown planId: ${planId}`);
        }),
        cancelDuplicateQueuedTasks: vi.fn(async (projectId) => {
            const tasks = await store.listTasks();
            const cancelled = [];
            for (const task of tasks) {
                if (projectId && task.projectId !== projectId)
                    continue;
                if (task.status !== "queued" || task.build.status !== "queued")
                    continue;
                const duplicate = tasks.find((candidate) => candidate.id !== task.id &&
                    candidate.projectId === task.projectId &&
                    candidate.title.toLowerCase() === task.title.toLowerCase() &&
                    candidate.status !== "queued");
                if (!duplicate)
                    continue;
                cancelled.push(await store.updateTask(task.id, (existing) => ({
                    ...existing,
                    status: "stopped",
                    build: {
                        ...existing.build,
                        status: "stopped",
                        exitCode: null,
                        endedAt: "2026-06-24T06:10:00.000Z",
                        error: `Cancelled as duplicate of ${duplicate.id}; historical record preserved and no worker was launched.`
                    }
                })));
            }
            return cancelled;
        }),
        cancelDuplicateQueuedTask: vi.fn(async (taskId, reason = "Duplicate queued task.") => {
            const tasks = await store.listTasks();
            const task = tasks.find((candidate) => candidate.id === taskId);
            if (!task)
                throw new Error(`Unknown taskId: ${taskId}`);
            const duplicate = tasks.find((candidate) => candidate.id !== task.id && candidate.projectId === task.projectId && candidate.title === task.title);
            if (!duplicate)
                throw new Error(`Task ${taskId} does not duplicate another task.`);
            return await store.updateTask(task.id, (existing) => ({
                ...existing,
                status: "stopped",
                build: {
                    ...existing.build,
                    status: "stopped",
                    exitCode: null,
                    endedAt: "2026-06-24T06:10:00.000Z",
                    error: `Cancelled as duplicate of ${duplicate.id}; ${reason} Historical record preserved and no worker was launched.`
                }
            }));
        }),
        reconcileTaskForAutopilot: undefined
    };
}
function taskSummary(task) {
    return {
        title: task.title,
        projectId: task.projectId ?? "trade-journal-lite",
        projectName: "Trade Journal Lite",
        taskId: task.id,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        status: task.status === "passed" || task.status === "running" ? "queued" : task.status,
        codexAccessMode: "full local access",
        codexApprovalPolicy: "never",
        codexAccessWarning: "Task can access files and network outside the project folder.",
        approval: {
            mode: "auto_for_safe_tasks",
            status: "eligible",
            eligible: true,
            reasons: [],
            riskFlags: []
        },
        buildSummary: task.build.status === "passed" ? "Build passed." : "Build queued.",
        reviewResult: task.review?.result ?? null,
        latestLogLines: []
    };
}
function taskSpec(title) {
    return {
        title,
        requirements: `Implement ${title}.`,
        acceptanceCriteria: ["Checks pass."]
    };
}
function needsFixesTask(taskId) {
    return {
        id: taskId,
        projectId: "trade-journal-lite",
        title: "Needs fixes",
        requirements: "Fix it.",
        acceptanceCriteria: ["Review passes."],
        status: "needs-fixes",
        createdAt: "2026-06-24T06:00:00.000Z",
        updatedAt: "2026-06-24T06:00:00.000Z",
        build: {
            status: "passed",
            logPath: dataPath(`${taskId}.build.jsonl`)
        },
        review: {
            status: "failed",
            result: "needs-fixes",
            logPath: dataPath(`${taskId}.review.jsonl`)
        }
    };
}
function blockedLostWorkerTask(taskId) {
    return {
        id: taskId,
        projectId: "trade-journal-lite",
        title: "Blocked lost worker",
        requirements: "Recover from lost worker.",
        acceptanceCriteria: ["Recovery is queued."],
        status: "blocked",
        createdAt: "2026-06-24T06:00:00.000Z",
        updatedAt: "2026-06-24T06:01:00.000Z",
        build: {
            status: "blocked",
            logPath: dataPath(`${taskId}.build.jsonl`),
            pid: 24884,
            startedAt: "2026-06-24T06:00:00.000Z",
            endedAt: "2026-06-24T06:01:00.000Z",
            exitCode: null,
            error: "Tracked build process PID 24884 is no longer running. Project Pilot did not observe a terminal event before restart or status read."
        }
    };
}
function recoveryQueueItem(originalTaskId) {
    return {
        id: `queue-recovery-${originalTaskId.slice(-8)}`,
        title: "Revalidate storage",
        requirements: "Operational recovery.",
        acceptanceCriteria: ["Build passes."],
        source: "recovery",
        fixAttemptForTaskId: originalTaskId,
        status: "queued",
        createdAt: "2026-06-24T06:00:00.000Z",
        updatedAt: "2026-06-24T06:00:00.000Z"
    };
}
function preparedRecoveryTask(taskId) {
    return {
        id: taskId,
        projectId: "trade-journal-lite",
        title: "Revalidate storage",
        requirements: "Operational recovery.",
        acceptanceCriteria: ["Build passes."],
        status: "queued",
        createdAt: "2026-06-24T06:00:00.000Z",
        updatedAt: "2026-06-24T06:00:00.000Z",
        build: {
            status: "queued",
            logPath: dataPath(`${taskId}.build.jsonl`)
        }
    };
}
function readyTask(taskId) {
    return {
        id: taskId,
        projectId: "trade-journal-lite",
        title: "Set up local Vite + TypeScript foundation",
        requirements: "Local-only foundation task with no external integration, credentials, deployment, or protected branch operation.",
        acceptanceCriteria: ["Build passes.", "Review passes."],
        status: "ready-for-approval",
        createdAt: "2026-06-24T06:00:00.000Z",
        updatedAt: "2026-06-24T06:02:00.000Z",
        build: {
            status: "passed",
            logPath: dataPath(`${taskId}.build.jsonl`),
            endedAt: "2026-06-24T06:01:00.000Z",
            exitCode: 0
        },
        review: {
            status: "passed",
            result: "pass",
            logPath: dataPath(`${taskId}.review.jsonl`),
            endedAt: "2026-06-24T06:02:00.000Z",
            exitCode: 0
        }
    };
}
async function waitUntil(predicate) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for condition.");
}
