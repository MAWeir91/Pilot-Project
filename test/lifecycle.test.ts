import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService } from "../src/jobs.js";
import { NullTaskNotifier } from "../src/notifications.js";
import { dataPath } from "../src/paths.js";
import { ProjectRegistry } from "../src/projects.js";
import { StateStore } from "../src/state.js";
import type { TaskRecord, TaskState } from "../src/types.js";

const TASK_ID = "task-2026-06-24T02-00-00-000Z-cccccccc";
const BUILD_LOG = dataPath("task-2026-06-24T02-00-00-000Z-cccccccc.build.jsonl");
const REVIEW_LOG = dataPath("task-2026-06-24T02-00-00-000Z-cccccccc.review.jsonl");
const STATE_FILES: string[] = [];
const LOG_FILES = [BUILD_LOG, REVIEW_LOG];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled([...STATE_FILES.splice(0), ...LOG_FILES].map((file) => fs.rm(file, { force: true, recursive: true })));
});

describe("job lifecycle reconciliation", () => {
  it("records review spawn failure as blocked with exit metadata", async () => {
    const { service, store } = await serviceWithTask(
      passedBuildTask(),
      {
        spawnJob: () => {
          throw new Error("spawn denied");
        }
      }
    );

    const result = await service.runReview(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result.taskStatus).toBe("blocked");
    expect(saved?.review?.status).toBe("blocked");
    expect(saved?.review?.result).toBe("blocked");
    expect(saved?.review?.exitCode).toBeNull();
    expect(saved?.review?.endedAt).toBeDefined();
    expect(saved?.review?.error).toMatch(/spawn denied/);
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
    const { service, store } = await serviceWithTask(
      {
        ...baseTask(),
        status: "building",
        build: {
          status: "running",
          logPath: BUILD_LOG,
          pid: 99999,
          startedAt: "2026-06-24T02:00:01.000Z"
        }
      },
      {
        processExists: () => false
      }
    );

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
      processExists: (pid: number) => pid === 4242,
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

  it("reconciles a completed review worker from reports after restart", async () => {
    const projectPath = dataPath("lifecycle-project-restart");
    const registryFile = dataPath("lifecycle-projects-restart.json");
    STATE_FILES.push(projectPath, registryFile);
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      `${projectPath}\\BUILD_REPORT.md`,
      [
        "# Build Report",
        "",
        "## Commands Run and Results",
        "",
        "- `npm test`",
        "  - Result: passed; tests passed.",
        "- `npm run check`",
        "  - Result: passed; checks passed.",
        "- `npm run build`",
        "  - Result: passed; build passed."
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      `${projectPath}\\REVIEW_REPORT.md`,
      ["# Review Report", "", `Task ID: ${TASK_ID}`, "Result: pass", "", "- Review passed."].join("\n"),
      "utf8"
    );
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
    const { service } = await serviceWithTask(
      {
        ...passedBuildTask(),
        status: "reviewing",
        review: {
          status: "running",
          logPath: REVIEW_LOG,
          pid: 5151,
          startedAt: "2026-06-24T02:00:03.000Z",
          result: "blocked"
        }
      },
      {
        spawnJob,
        processExists: (pid: number) => pid === 5151
      }
    );

    await expect(service.retryReview(TASK_ID)).rejects.toThrow(/active tracked review PID 5151/);
    expect(spawnJob).not.toHaveBeenCalled();
  });
});

async function serviceWithTask(task: TaskRecord, options = {}) {
  const stateFile = await writeState({ tasks: [task] });
  const store = new StateStore(stateFile);
  const service = new JobService(store, new NullTaskNotifier(), {
    now: () => "2026-06-24T02:10:00.000Z",
    ...options
  });
  return { service, store };
}

async function writeState(state: TaskState): Promise<string> {
  const stateFile = dataPath(`lifecycle-${STATE_FILES.length}.json`);
  STATE_FILES.push(stateFile);
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return stateFile;
}

function baseTask(): TaskRecord {
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

function passedBuildTask(): TaskRecord {
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

function fakeChild(pid: number) {
  return {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      end: vi.fn()
    },
    kill: vi.fn()
  } as never;
}
