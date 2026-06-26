import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService } from "../src/jobs.js";
import { NullTaskNotifier } from "../src/notifications.js";
import { dataPath, taskBuildReportFile, taskReportsDir, taskReviewReportFile } from "../src/paths.js";
import { ProjectRegistry } from "../src/projects.js";
import { StateStore } from "../src/state.js";
const TASK_ID = "task-2026-06-24T02-00-00-000Z-cccccccc";
const BUILD_LOG = dataPath("task-2026-06-24T02-00-00-000Z-cccccccc.build.jsonl");
const REVIEW_LOG = dataPath("task-2026-06-24T02-00-00-000Z-cccccccc.review.jsonl");
const STATE_FILES = [];
const LOG_FILES = [BUILD_LOG, REVIEW_LOG];
afterEach(async () => {
    vi.useRealTimers();
    await Promise.allSettled([...STATE_FILES.splice(0), ...LOG_FILES].map((file) => fs.rm(file, { force: true, recursive: true })));
});
describe("job lifecycle reconciliation", () => {
    it("records review spawn failure as blocked with exit metadata", async () => {
        const { service, store } = await serviceWithTask(passedBuildTask(), {
            spawnJob: () => {
                throw new Error("spawn denied");
            }
        });
        const result = await service.runReview(TASK_ID);
        const saved = await store.getTask(TASK_ID);
        expect(result.taskStatus).toBe("blocked");
        expect(saved?.review?.status).toBe("blocked");
        expect(saved?.review?.result).toBe("blocked");
        expect(saved?.review?.exitCode).toBeNull();
        expect(saved?.review?.endedAt).toBeDefined();
        expect(saved?.review?.error).toMatch(/spawn denied/);
    });
    it("persists structured passed command results when a build worker completes", async () => {
        const projectPath = dataPath("lifecycle-build-complete-project");
        const registryFile = dataPath("lifecycle-build-complete-projects.json");
        STATE_FILES.push(projectPath, registryFile);
        await fs.mkdir(projectPath, { recursive: true });
        const projects = new ProjectRegistry(registryFile, () => "2026-06-24T02:10:00.000Z");
        await projects.registerProject({
            id: "lifecycle-build-complete-project",
            name: "Lifecycle Build Complete Project",
            path: projectPath,
            buildCommand: "npm run build",
            testCommand: "npm test",
            checkCommand: "npm run check",
            defaultBranchName: "main",
            allowedGitBehavior: "feature branches and local commits"
        });
        let onClose;
        const spawnJob = vi.fn((options) => {
            onClose = options.onClose;
            return fakeChild(2222);
        });
        const stateFile = await writeState({ tasks: [] });
        const store = new StateStore(stateFile);
        const service = new JobService(store, new NullTaskNotifier(), {
            projects,
            spawnJob,
            processExists: () => true,
            now: () => "2026-06-24T02:10:00.000Z"
        });
        const started = await service.startBuild({
            projectId: "lifecycle-build-complete-project",
            title: "Persist build verification",
            requirements: "Exercise build completion.",
            acceptanceCriteria: ["Structured verification is stored."]
        });
        await waitFor(() => expect(spawnJob).toHaveBeenCalledTimes(1));
        await fs.mkdir(taskReportsDir(projectPath, started.taskId), { recursive: true });
        await fs.writeFile(taskBuildReportFile(projectPath, started.taskId), buildReportFor(started.taskId, projectPath, taskBuildReportFile(projectPath, started.taskId)), "utf8");
        onClose?.(0, null, "");
        await waitFor(async () => {
            const saved = await store.getTask(started.taskId);
            expect(saved?.build.status).toBe("passed");
            expect(saved?.verification?.every((record) => record.status === "passed")).toBe(true);
        });
        const saved = await store.getTask(started.taskId);
        expect(saved?.verification).toHaveLength(3);
        expect(saved?.verification?.every((record) => record.evidence?.source === "build-worker")).toBe(true);
        expect(saved?.verificationEvents?.[0]).toMatchObject({
            kind: "verification-recorded",
            source: "build-worker",
            status: "passed"
        });
    });
    it("reconciles an active review with no PID as blocked", async () => {
        const { service, store } = await serviceWithTask({
            ...passedBuildTask(),
            status: "reviewing",
            review: {
                status: "running",
                logPath: REVIEW_LOG,
                startedAt: "2026-06-24T02:00:03.000Z"
            }
        });
        await service.listTasks();
        const saved = await store.getTask(TASK_ID);
        expect(saved?.status).toBe("blocked");
        expect(saved?.review?.status).toBe("blocked");
        expect(saved?.review?.exitCode).toBeNull();
        expect(saved?.review?.error).toMatch(/never persisted a child process ID/);
    });
    it("reconciles an active build whose tracked PID is gone as blocked", async () => {
        const { service, store } = await serviceWithTask({
            ...baseTask(),
            status: "building",
            build: {
                status: "running",
                logPath: BUILD_LOG,
                pid: 99999,
                startedAt: "2026-06-24T02:00:01.000Z"
            }
        }, {
            processExists: () => false
        });
        await service.getBuildStatus(TASK_ID);
        const saved = await store.getTask(TASK_ID);
        expect(saved?.status).toBe("blocked");
        expect(saved?.build.status).toBe("blocked");
        expect(saved?.build.exitCode).toBeNull();
        expect(saved?.build.error).toMatch(/PID 99999 is no longer running/);
    });
    it("times out a tracked review, kills only that PID, and records log tail", async () => {
        const child = fakeChild(4242);
        const killProcess = vi.fn();
        await fs.writeFile(REVIEW_LOG, "first line\nlast review line\n", "utf8");
        const { service, store } = await serviceWithTask(passedBuildTask(), {
            spawnJob: () => child,
            processExists: (pid) => pid === 4242,
            killProcess,
            reviewTimeoutMs: 1
        });
        const pending = service.runReview(TASK_ID);
        const result = await pending;
        const saved = await store.getTask(TASK_ID);
        expect(killProcess).toHaveBeenCalledWith(4242);
        expect(result.taskStatus).toBe("blocked");
        expect(saved?.review?.status).toBe("blocked");
        expect(saved?.review?.error).toMatch(/timed out/);
        expect(saved?.review?.error).toMatch(/last review line/);
    });
    it("recovers unfinished review state after restart without starting a duplicate job", async () => {
        const stateFile = await writeState({
            tasks: [
                {
                    ...passedBuildTask(),
                    status: "reviewing",
                    review: {
                        status: "running",
                        logPath: REVIEW_LOG,
                        pid: 31337,
                        startedAt: "2026-06-24T02:00:03.000Z"
                    }
                }
            ]
        });
        const spawnJob = vi.fn(() => fakeChild(1111));
        const restarted = new JobService(new StateStore(stateFile), new NullTaskNotifier(), {
            spawnJob,
            processExists: () => false
        });
        await restarted.reconcileUnfinishedTasks();
        const saved = await new StateStore(stateFile).getTask(TASK_ID);
        expect(saved?.status).toBe("blocked");
        expect(saved?.review?.error).toMatch(/PID 31337 is no longer running/);
        expect(spawnJob).not.toHaveBeenCalled();
    });
    it("skips a task that disappears during background reconciliation without weakening direct task operations", async () => {
        const { service, store } = await serviceWithTask(passedBuildTask());
        vi.spyOn(store, "getTask").mockResolvedValue(undefined);
        await expect(service.reconcileUnfinishedTasks()).resolves.toBeUndefined();
        await expect(service.approveTask(TASK_ID)).rejects.toThrow(`Unknown taskId: ${TASK_ID}`);
    });
    it("reconciles a completed review worker from reports after restart", async () => {
        const projectPath = dataPath("lifecycle-project-restart");
        const registryFile = dataPath("lifecycle-projects-restart.json");
        STATE_FILES.push(projectPath, registryFile);
        await fs.mkdir(projectPath, { recursive: true });
        await fs.mkdir(taskReportsDir(projectPath, TASK_ID), { recursive: true });
        await fs.writeFile(taskBuildReportFile(projectPath, TASK_ID), buildReportFor(TASK_ID, projectPath, taskBuildReportFile(projectPath, TASK_ID)), "utf8");
        await fs.writeFile(taskReviewReportFile(projectPath, TASK_ID), reviewReportFor(TASK_ID, projectPath, taskReviewReportFile(projectPath, TASK_ID)), "utf8");
        const projects = new ProjectRegistry(registryFile, () => "2026-06-24T02:10:00.000Z");
        await projects.registerProject({
            id: "lifecycle-project",
            name: "Lifecycle Project",
            path: projectPath,
            buildCommand: "npm run build",
            testCommand: "npm test",
            checkCommand: "npm run check",
            defaultBranchName: "main",
            allowedGitBehavior: "feature branches and local commits"
        });
        const stateFile = await writeState({
            tasks: [
                {
                    ...passedBuildTask(),
                    projectId: "lifecycle-project",
                    status: "reviewing",
                    review: {
                        status: "running",
                        logPath: REVIEW_LOG,
                        pid: 31337,
                        startedAt: "2026-06-24T02:00:03.000Z"
                    }
                }
            ]
        });
        const spawnJob = vi.fn(() => fakeChild(1111));
        const restarted = new JobService(new StateStore(stateFile), new NullTaskNotifier(), {
            projects,
            spawnJob,
            processExists: () => false,
            now: () => "2026-06-24T02:10:00.000Z"
        });
        await restarted.reconcileUnfinishedTasks();
        const saved = await new StateStore(stateFile).getTask(TASK_ID);
        expect(saved?.status).toBe("completed");
        expect(saved?.review?.status).toBe("passed");
        expect(saved?.review?.result).toBe("pass");
        expect(saved?.verification?.every((record) => record.status === "passed")).toBe(true);
        expect(spawnJob).not.toHaveBeenCalled();
    });
    it("prevents duplicate review retry while a reviewer PID is active", async () => {
        const spawnJob = vi.fn(() => fakeChild(5151));
        const { service } = await serviceWithTask({
            ...passedBuildTask(),
            status: "reviewing",
            review: {
                status: "running",
                logPath: REVIEW_LOG,
                pid: 5151,
                startedAt: "2026-06-24T02:00:03.000Z",
                result: "blocked"
            }
        }, {
            spawnJob,
            processExists: (pid) => pid === 5151
        });
        await expect(service.retryReview(TASK_ID)).rejects.toThrow(/active tracked review PID 5151/);
        expect(spawnJob).not.toHaveBeenCalled();
    });
});
async function serviceWithTask(task, options = {}) {
    const stateFile = await writeState({ tasks: [task] });
    const store = new StateStore(stateFile);
    const service = new JobService(store, new NullTaskNotifier(), {
        now: () => "2026-06-24T02:10:00.000Z",
        ...options
    });
    return { service, store };
}
async function writeState(state) {
    const stateFile = dataPath(`lifecycle-${STATE_FILES.length}.json`);
    STATE_FILES.push(stateFile);
    await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return stateFile;
}
function baseTask() {
    return {
        id: TASK_ID,
        title: "Lifecycle test",
        requirements: "Exercise lifecycle handling.",
        acceptanceCriteria: ["Lifecycle state is correct."],
        status: "queued",
        createdAt: "2026-06-24T02:00:00.000Z",
        updatedAt: "2026-06-24T02:00:00.000Z",
        build: {
            status: "queued",
            logPath: BUILD_LOG
        }
    };
}
function passedBuildTask() {
    return {
        ...baseTask(),
        status: "build-passed",
        build: {
            status: "passed",
            logPath: BUILD_LOG,
            pid: 1000,
            startedAt: "2026-06-24T02:00:01.000Z",
            endedAt: "2026-06-24T02:00:02.000Z",
            exitCode: 0
        }
    };
}
function fakeChild(pid) {
    return {
        pid,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: {
            end: vi.fn()
        },
        kill: vi.fn()
    };
}
function buildReportFor(taskId, executionRoot, reportPath) {
    return [
        "# Build Report",
        "",
        "Report Type: build",
        `Task ID: ${taskId}`,
        "Run ID: none",
        `Execution Root: ${executionRoot}`,
        "Branch: main",
        "Timestamp: 2026-06-24T02:10:00.000Z",
        `Report Path: ${reportPath}`,
        "",
        "## Commands Run and Results",
        "",
        'PROJECT_PILOT_COMMAND_RESULT {"command":"npm test","attempt":1,"status":"passed","exitCode":0}',
        'PROJECT_PILOT_COMMAND_RESULT {"command":"npm run check","attempt":1,"status":"passed","exitCode":0}',
        'PROJECT_PILOT_COMMAND_RESULT {"command":"npm run build","attempt":1,"status":"passed","exitCode":0}',
        "",
        "Final Status: passed"
    ].join("\n");
}
function reviewReportFor(taskId, executionRoot, reportPath) {
    return [
        "# Review Report",
        "",
        "Report Type: review",
        `Task ID: ${taskId}`,
        "Run ID: none",
        `Execution Root: ${executionRoot}`,
        "Branch: main",
        "Timestamp: 2026-06-24T02:10:00.000Z",
        `Report Path: ${reportPath}`,
        "Result: pass",
        "",
        "- Review passed."
    ].join("\n");
}
async function waitFor(assertion) {
    const deadline = Date.now() + 1000;
    let lastError;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        }
        catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    if (lastError) {
        throw lastError;
    }
}
