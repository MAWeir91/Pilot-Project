import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService } from "../src/jobs.js";
import { NullTaskNotifier } from "../src/notifications.js";
import { DATA_DIR, dataPath } from "../src/paths.js";
import { ProjectRegistry } from "../src/projects.js";
import { StateStore } from "../src/state.js";
import type { ProjectRecord } from "../src/types.js";

const FILES: string[] = [];
const DIRS: string[] = [];

afterEach(async () => {
  await Promise.allSettled(FILES.splice(0).map((file) => fs.unlink(file)));
  await Promise.allSettled(DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("maintenance execution isolation", () => {
  it("rejects live-root execution before writing task artifacts or launching a worker", async () => {
    const { service, liveRoot, spawnJob } = await serviceWithMaintenanceProject({ executionRoot: "live" });

    const result = await service.startBuild(taskInput());
    const tasks = await service.listTasks();

    expect(result.status).toBe("blocked");
    expect(spawnJob).not.toHaveBeenCalled();
    expect(tasks.tasks[0]?.buildSummary).toMatch(/distinct from the registered project root/);
    await expectLiveRootUnchanged(liveRoot);
  });

  it("routes task artifacts, logs, and Codex execution to a valid isolated worktree", async () => {
    const { service, project, liveRoot, executionRoot, spawnJob, store } = await serviceWithMaintenanceProject();

    const result = await service.startBuild(taskInput());
    await waitUntil(() => spawnJob.mock.calls.length === 1);
    const saved = (await service.listTasks()).tasks[0];

    expect(result.status).toBe("queued");
    expect(spawnJob.mock.calls[0][0]).toMatchObject({
      projectRoot: executionRoot,
      sandbox: "danger-full-access"
    });
    await expect(fs.readFile(path.join(executionRoot, "TASK.md"), "utf8")).resolves.toMatch(/Maintenance task/);
    await expectLiveRootUnchanged(liveRoot);
    expect(saved.latestLogLines).toEqual([]);
    const stored = await service.getBuildStatus(result.taskId);
    expect(String(stored.logTail)).toBe("");
    const record = await store.getTask(result.taskId);
    expect(record?.build.logPath).toBe(path.join(executionRoot, ".project-pilot", "logs", `${result.taskId}.build.jsonl`));
    expect(project.executionRoot).toBe(executionRoot);
  });

  it("blocks invalid Git preflight before worker launch", async () => {
    const { service, executionRoot, liveRoot, spawnJob } = await serviceWithMaintenanceProject({
      gitRunner: (args) => {
        if (args[0] === "rev-parse") return executionRoot;
        if (args[0] === "branch") return "chore/self-maintenance-bootstrap\n";
        if (args[0] === "show-ref") throw new Error("missing base");
        return "";
      }
    });

    const result = await service.startBuild(taskInput());
    const tasks = await service.listTasks();

    expect(result.status).toBe("blocked");
    expect(spawnJob).not.toHaveBeenCalled();
    expect(tasks.tasks[0]?.buildSummary).toMatch(/Base branch is unknown/);
    await expect(fs.stat(path.join(executionRoot, "TASK.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectLiveRootUnchanged(liveRoot);
  });

  it("writes planning reports to the isolated execution root and preserves strict Plan ID validation", async () => {
    const { service, liveRoot, executionRoot, spawnJob } = await serviceWithMaintenanceProject({
      spawnOutput: (prompt) => planOutput(prompt.match(/plan (plan-[a-zA-Z0-9T-]+)/)?.[1] ?? "")
    });

    const result = await service.startPlan({
      projectId: "project-pilot-maintenance",
      title: "Maintenance plan",
      requirements: "Plan self-maintenance changes.",
      constraints: "Do not touch the live checkout."
    });
    const details = await waitForPlanStatus(service, result.planId, "plan-ready");

    expect(details.status).toBe("plan-ready");
    expect(details.reportPath).toBe(path.join(executionRoot, "PLAN_REPORT.md"));
    expect(spawnJob.mock.calls[0][0]).toMatchObject({
      projectRoot: executionRoot,
      sandbox: "read-only"
    });
    await expect(fs.readFile(path.join(executionRoot, "PLAN_REPORT.md"), "utf8")).resolves.toMatch(`Plan ID: ${result.planId}`);
    await expectLiveRootUnchanged(liveRoot);
  });

  it("keeps strict plan mismatches visible", async () => {
    const wrongPlanId = "plan-2026-06-24T05-00-00-000Z-deadbeef";
    const { service } = await serviceWithMaintenanceProject({ spawnOutput: () => planOutput(wrongPlanId) });

    const result = await service.startPlan({
      projectId: "project-pilot-maintenance",
      title: "Mismatch plan",
      requirements: "Plan self-maintenance changes.",
      constraints: "Do not touch the live checkout."
    });
    const details = await waitForPlanStatus(service, result.planId, "plan-blocked");

    expect(details.status).toBe("plan-blocked");
    expect(details.errors.join("\n")).toMatch(new RegExp(`Expected ${result.planId}`));
    expect(details.errors.join("\n")).toMatch(new RegExp(`found ${wrongPlanId}`));
  });
});

async function serviceWithMaintenanceProject(options: {
  executionRoot?: "isolated" | "live";
  gitRunner?: (args: string[], cwd: string) => string;
  spawnOutput?: (prompt: string) => string;
} = {}) {
  const index = FILES.length;
  const stateFile = dataPath(`maintenance-state-${index}.json`);
  const registryFile = dataPath(`maintenance-projects-${index}.json`);
  FILES.push(stateFile, registryFile);

  const liveRoot = path.join(DATA_DIR, `maintenance-live-${index}`);
  const isolatedRoot = path.join(DATA_DIR, `maintenance-worktree-${index}`);
  const executionRoot = options.executionRoot === "live" ? liveRoot : isolatedRoot;
  DIRS.push(liveRoot, isolatedRoot);
  await fs.mkdir(liveRoot, { recursive: true });
  await fs.mkdir(isolatedRoot, { recursive: true });

  const registry = new ProjectRegistry(registryFile, () => "2026-06-24T05:00:00.000Z");
  const project = await registry.registerProject({
    id: "project-pilot-maintenance",
    name: "Project Pilot Maintenance",
    path: liveRoot,
    executionRoot,
    gitRemoteName: "origin",
    buildCommand: "npm run build",
    testCommand: "npm test",
    checkCommand: "npm run check",
    defaultBranchName: "main",
    allowedGitBehavior: "isolated maintenance worktree only",
    maintenance: {
      enabled: true,
      liveRoot,
      baseBranch: "main"
    }
  });

  const spawnJob = vi.fn((spawnOptions: {
    prompt: string;
    onClose?: (exitCode: number | null, signal: NodeJS.Signals | null, stdoutText: string) => void;
  }) => {
    setTimeout(() => spawnOptions.onClose?.(0, null, options.spawnOutput?.(spawnOptions.prompt) ?? ""), 5);
    return fakeChild(6262);
  });

  const gitRunner =
    options.gitRunner ??
    ((args: string[], cwd: string) => {
      if (args[0] === "rev-parse") return `${cwd}\n`;
      if (args[0] === "branch") return "chore/self-maintenance-bootstrap\n";
      if (args[0] === "show-ref") return "";
      if (args[0] === "merge-base") return "";
      if (args[0] === "worktree") return `worktree ${liveRoot}\nHEAD abc\n\nworktree ${executionRoot}\nHEAD def\n`;
      if (args[0] === "status") return "";
      return "";
    });

  const store = new StateStore(stateFile);
  const service = new JobService(store, new NullTaskNotifier(), {
    projects: registry,
    spawnJob,
    gitRunner,
    processExists: (pid) => pid === 6262,
    now: () => "2026-06-24T05:10:00.000Z"
  });

  return { service, project: project as ProjectRecord, liveRoot, executionRoot, spawnJob, store };
}

function taskInput() {
  return {
    projectId: "project-pilot-maintenance",
    title: "Maintenance task",
    requirements: "Bootstrap maintenance safety.",
    acceptanceCriteria: ["No live checkout mutation."]
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

function planOutput(planId: string): string {
  return `PLAN_REPORT_START
# Plan Report

Plan ID: ${planId}

## Summary Of The Request

Plan self-maintenance changes.

## Recommended Architecture

Use the isolated execution root.

## Implementation Phases

1. Update code.

## Files Likely To Change

- src/jobs.ts

## Dependencies Or Services Needed

None.

## Trade-offs And Alternatives

Keep strict validation.

## Risks

Low.

## Test Strategy

Run npm test.

## Questions/Blockers

None.
PLAN_REPORT_END`;
}

async function waitForPlanStatus(service: JobService, planId: string, status: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const details = await service.getPlanDetails(planId);
    if (details.status === status) {
      return details;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return await service.getPlanDetails(planId);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function expectLiveRootUnchanged(liveRoot: string): Promise<void> {
  await expect(fs.stat(path.join(liveRoot, "TASK.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(path.join(liveRoot, "BUILD_REPORT.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(path.join(liveRoot, "REVIEW_REPORT.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(path.join(liveRoot, "PLAN_REPORT.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(path.join(liveRoot, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(path.join(liveRoot, "data"))).rejects.toMatchObject({ code: "ENOENT" });
}
