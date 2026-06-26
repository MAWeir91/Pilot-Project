import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService } from "../src/jobs.js";
import { NullTaskNotifier } from "../src/notifications.js";
import { DATA_DIR, dataPath } from "../src/paths.js";
import { ProjectRegistry } from "../src/projects.js";
import { StateStore } from "../src/state.js";
import type { PlanRecord, ProjectRecord, TaskState } from "../src/types.js";

const FILES: string[] = [];
const DIRS: string[] = [];

afterEach(async () => {
  await Promise.allSettled(FILES.splice(0).map((file) => fs.unlink(file)));
  await Promise.allSettled(DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("planning lifecycle", () => {
  it("runs planning in read-only mode and writes PLAN_REPORT.md", async () => {
    const { service, project, spawnJob } = await serviceWithRegisteredProject();

    const result = await service.startPlan({
      projectId: project.id,
      title: "Plan dashboard changes",
      requirements: "Inspect the app and plan changes.",
      constraints: "Do not implement."
    });
    const details = await waitForPlanStatus(service, result.planId, "plan-ready");

    expect(result.status).toBe("queued");
    expect(spawnJob).toHaveBeenCalledTimes(1);
    expect(spawnJob.mock.calls[0][0]).toMatchObject({
      projectRoot: project.path,
      sandbox: "read-only"
    });
    expect(details.status).toBe("plan-ready");
    expect(details.report).toMatch(/Recommended Architecture/);
    await expect(fs.readFile(path.join(project.path, "PLAN_REPORT.md"), "utf8")).resolves.toMatch(
      /Plan dashboard changes|Recommended Architecture/
    );
  });

  it("blocks zero-exit planning when PLAN_REPORT.md is missing or invalid", async () => {
    const { service, project } = await serviceWithRegisteredProject({ planOutput: "No report envelope here." });

    const result = await service.startPlan({
      projectId: project.id,
      title: "Missing report plan",
      requirements: "Create a plan.",
      constraints: "None."
    });
    const details = await waitForPlanStatus(service, result.planId, "plan-blocked");

    expect(details.status).toBe("plan-blocked");
    expect(details.exitCode).toBe(0);
    expect(details.errors.join("\n")).toMatch(/did not emit a PLAN_REPORT_START\/PLAN_REPORT_END envelope/);
    expect(details.errors.join("\n")).toMatch(/PLAN_REPORT\.md is missing or empty/);
  });

  it("reconciles an existing blocked zero-exit plan with a valid PLAN_REPORT.md", async () => {
    const { service, project, store } = await serviceWithRegisteredProject({ autoCompletePlan: false });
    const plan = existingPlan(project);
    await fs.writeFile(path.join(project.path, "PLAN_REPORT.md"), planReport(plan.id), "utf8");
    await writeState(store, { tasks: [], plans: [plan] });

    const details = await service.getPlanDetails(plan.id);
    const saved = await store.getPlan(plan.id);

    expect(details.status).toBe("plan-ready");
    expect(saved?.status).toBe("plan-ready");
    expect(saved?.error).toBeUndefined();
  });

  it("blocks create_task_from_plan until the plan is ready", async () => {
    const { service, project } = await serviceWithRegisteredProject({ autoCompletePlan: false });

    const result = await service.startPlan({
      projectId: project.id,
      title: "Blocked plan",
      requirements: "Create a plan.",
      constraints: "None."
    });

    await expect(service.createTaskFromPlan({ planId: result.planId })).rejects.toThrow(/not plan-ready/);
  });

  it("creates a queued implementation task from a ready plan without starting implementation", async () => {
    const { service, project, spawnJob, store } = await serviceWithRegisteredProject();
    const plan = await service.startPlan({
      projectId: project.id,
      title: "Implement planned work",
      requirements: "Plan first.",
      constraints: "No implementation during planning."
    });
    await waitForPlanStatus(service, plan.planId, "plan-ready");

    const task = await service.createTaskFromPlan({ planId: plan.planId });
    const saved = await store.getTask(task.taskId);

    expect(task.status).toBe("queued");
    expect(task.message).toMatch(/Implementation was not started/);
    expect(saved).toMatchObject({
      projectId: project.id,
      sourcePlanId: plan.planId,
      status: "queued",
      build: { status: "queued" }
    });
    expect(spawnJob).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(project.path, "TASK.md"), "utf8")).resolves.toMatch(/approved plan/);
  });

  it("rejects planning for unregistered projects", async () => {
    const { service } = await serviceWithRegisteredProject();

    await expect(
      service.startPlan({
        projectId: "not-registered",
        title: "Plan",
        requirements: "Nope.",
        constraints: "None."
      })
    ).rejects.toThrow(/Unknown projectId/);
  });
});

async function serviceWithRegisteredProject(options: { autoCompletePlan?: boolean; planOutput?: string } = {}) {
  const stateFile = dataPath(`planning-state-${FILES.length}.json`);
  const registryFile = dataPath(`planning-projects-${FILES.length}.json`);
  FILES.push(stateFile, registryFile);
  const projectPath = path.join(DATA_DIR, `planning-project-${FILES.length}`);
  DIRS.push(projectPath);
  await fs.mkdir(projectPath, { recursive: true });
  const registry = new ProjectRegistry(registryFile, () => "2026-06-24T05:00:00.000Z");
  const project = await registry.registerProject({
    id: `planning-project-${FILES.length}`,
    name: "Planning Project",
    path: projectPath,
    buildCommand: "npm run build",
    testCommand: "npm test",
    checkCommand: "npm run check",
    defaultBranchName: "main",
    allowedGitBehavior: "feature branch work"
  });
  const spawnJob = vi.fn((spawnOptions: {
    prompt: string;
    onClose?: (exitCode: number | null, signal: NodeJS.Signals | null, stdoutText: string) => void;
  }) => {
    if (options.autoCompletePlan !== false) {
      setTimeout(() => {
        const planId = spawnOptions.prompt.match(/plan (plan-[a-zA-Z0-9T-]+)/)?.[1] ?? "plan-2026-06-24T05-00-00-000Z-aaaaaaaa";
        spawnOptions.onClose?.(0, null, options.planOutput ?? planOutput(planId));
      }, 10);
    }
    return fakeChild(6262);
  });
  const store = new StateStore(stateFile);
  const service = new JobService(store, new NullTaskNotifier(), {
    projects: registry,
    spawnJob,
    processExists: (pid) => pid === 6262,
    now: () => "2026-06-24T05:10:00.000Z"
  });

  return { service, project: project as ProjectRecord, spawnJob, store };
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

async function writeState(store: StateStore, state: TaskState): Promise<void> {
  await store.write(state);
}

function existingPlan(project: ProjectRecord): PlanRecord {
  const id = "plan-2026-06-24T05-00-00-000Z-eeeeeeee";
  return {
    id,
    projectId: project.id,
    title: "Existing blocked plan",
    requirements: "Plan architecture.",
    constraints: "Do not implement.",
    status: "plan-blocked",
    createdAt: "2026-06-24T05:00:00.000Z",
    updatedAt: "2026-06-24T05:05:00.000Z",
    logPath: dataPath(`${id}.plan.jsonl`),
    reportPath: path.join(project.path, "PLAN_REPORT.md"),
    pid: 1234,
    startedAt: "2026-06-24T05:01:00.000Z",
    endedAt: "2026-06-24T05:05:00.000Z",
    exitCode: 0
  };
}

function planOutput(planId: string): string {
  return `PLAN_REPORT_START
# Plan Report

Plan ID: ${planId}

## Summary Of The Request

Plan dashboard changes.

## Recommended Architecture

Use existing services.

## Implementation Phases

1. Update code.

## Files Likely To Change

- src/jobs.ts

## Dependencies Or Services Needed

None.

## Trade-offs And Alternatives

Keep it simple.

## Risks

Low.

## Test Strategy

Run npm test.

## Questions/Blockers

None.
PLAN_REPORT_END`;
}

function planReport(planId: string): string {
  return planOutput(planId)
    .replace("PLAN_REPORT_START\n", "")
    .replace("\nPLAN_REPORT_END", "");
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
