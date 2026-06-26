import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService } from "../src/jobs.js";
import { AutopilotService, NullAutopilotNotifier } from "../src/manager.js";
import { NullTaskNotifier } from "../src/notifications.js";
import { DATA_DIR, PROJECT_PILOT_LIVE_ROOT, dataPath } from "../src/paths.js";
import { ProjectRegistry } from "../src/projects.js";
import { StateStore } from "../src/state.js";
import { getProjectStatus } from "../src/status.js";
import type { AutopilotRunRecord, ProjectMaintenanceConfig, ProjectRecord } from "../src/types.js";

const FILES: string[] = [];
const DIRS: string[] = [];

afterEach(async () => {
  await Promise.allSettled(FILES.splice(0).map((file) => fs.unlink(file)));
  await Promise.allSettled(DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("maintenance execution isolation", () => {
  it("persists explicit maintenance configuration and reads it back through project views", async () => {
    const { service, registry, liveRoot, executionRoot } = await serviceWithPlainProject();

    const configured = await service.configureMaintenanceExecution({
      projectId: "project-pilot-maintenance",
      enabled: true,
      liveRoot,
      executionRoot,
      baseBranch: "main",
      expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
    });
    const readback = await registry.getProject("project-pilot-maintenance");
    const status = service.maintenanceStatus(readback);

    expect(readback.executionRoot).toBe(executionRoot);
    expect(readback.maintenance).toMatchObject({
      enabled: true,
      liveRoot,
      baseBranch: "main",
      expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
    });
    expect(configured).toMatchObject({ preflight: { ok: true } });
    expect(status).toMatchObject({
      enabled: true,
      mode: "maintenance/self-improvement",
      liveRoot,
      executionRoot,
      expectedBranch: "feature/self-improvement-dashboard-workflow-v1",
      branchHandling: {
        baseBranch: "main",
        expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
      },
      worktreeHandling: {
        isolatedWorktreeRequired: true,
        liveRootMutationAllowed: false
      },
      manualHandoff: {
        required: true
      },
      canStart: true,
      cannotStartReason: null
    });
    expect(String(status.operatorMessage)).toMatch(/self-improvement mode/i);
    expect(String((status.manualHandoff as { message?: unknown }).message)).toMatch(/manual/i);
  });

  it("accepts a valid isolated worktree only through the dedicated configuration operation", async () => {
    const { service, registry, executionRoot } = await serviceWithPlainProject();

    await service.configureMaintenanceExecution({
      projectId: "project-pilot-maintenance",
      enabled: true,
      liveRoot: (await registry.getProject("project-pilot-maintenance")).path,
      executionRoot,
      baseBranch: "main",
      expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
    });

    await expect(registry.getProject("project-pilot-maintenance")).resolves.toMatchObject({
      executionRoot,
      maintenance: {
        enabled: true,
        expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
      }
    });
  });

  it("rejects live-root execution before writing task artifacts or launching a worker", async () => {
    const { service, liveRoot, spawnJob } = await serviceWithMaintenanceProject({ executionRoot: "live" });

    const result = await service.startBuild(taskInput());
    const tasks = await service.listTasks();

    expect(result.status).toBe("blocked");
    expect(spawnJob).not.toHaveBeenCalled();
    expect(tasks.tasks[0]?.buildSummary).toMatch(/distinct from the registered project root/);
    await expectLiveRootUnchanged(liveRoot);
  });

  it("rejects live-root equivalent maintenance configuration before saving", async () => {
    const { service, registry, liveRoot } = await serviceWithPlainProject();

    await expect(
      service.configureMaintenanceExecution({
        projectId: "project-pilot-maintenance",
        enabled: true,
        liveRoot,
        executionRoot: liveRoot,
        baseBranch: "main",
        expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
      })
    ).rejects.toThrow(/distinct from the registered project root|live Project Pilot checkout/i);
    await expect(registry.getProject("project-pilot-maintenance")).resolves.toMatchObject({ maintenance: undefined });
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

  it("rejects invalid expected branch and invalid worktree configuration before saving", async () => {
    const branchMismatch = await serviceWithPlainProject({
      gitRunner: validMaintenanceGitRunner("wrong-branch")
    });
    await expect(
      branchMismatch.service.configureMaintenanceExecution({
        projectId: "project-pilot-maintenance",
        enabled: true,
        liveRoot: branchMismatch.liveRoot,
        executionRoot: branchMismatch.executionRoot,
        baseBranch: "main",
        expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
      })
    ).rejects.toThrow(/expected feature\/self-improvement-dashboard-workflow-v1/);

    const invalidWorktree = await serviceWithPlainProject({
      gitRunner: (args, cwd) => {
        if (args[0] === "rev-parse") return `${cwd}\n`;
        if (args[0] === "branch") return "feature/self-improvement-dashboard-workflow-v1\n";
        if (args[0] === "show-ref") return "";
        if (args[0] === "merge-base") return "";
        if (args[0] === "worktree") return `worktree ${invalidWorktree.liveRoot}\nHEAD abc\n`;
        if (args[0] === "status") return "";
        return "";
      }
    });
    await expect(
      invalidWorktree.service.configureMaintenanceExecution({
        projectId: "project-pilot-maintenance",
        enabled: true,
        liveRoot: invalidWorktree.liveRoot,
        executionRoot: invalidWorktree.executionRoot,
        baseBranch: "main",
        expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
      })
    ).rejects.toThrow(/not listed by git worktree/);
  });

  it("blocks invalid Git preflight before worker launch", async () => {
    const { service, executionRoot, liveRoot, spawnJob } = await serviceWithMaintenanceProject({
      gitRunner: (args) => {
        if (args[0] === "rev-parse") return executionRoot;
        if (args[0] === "branch") return "feature/self-improvement-dashboard-workflow-v1\n";
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

  it("refuses Autopilot before worker launch when maintenance config is absent for the live root", async () => {
    const stateFile = dataPath(`maintenance-autopilot-state-${FILES.length}.json`);
    const registryFile = dataPath(`maintenance-autopilot-projects-${FILES.length}.json`);
    FILES.push(stateFile, registryFile);
    const registry = new ProjectRegistry(registryFile, () => "2026-06-24T05:00:00.000Z");
    await registry.registerProject({
      id: "project-pilot-maintenance",
      name: "Project Pilot Maintenance",
      path: PROJECT_PILOT_LIVE_ROOT,
      gitRemoteName: "origin",
      buildCommand: "npm run build",
      testCommand: "npm test",
      checkCommand: "npm run check",
      defaultBranchName: "main",
      allowedGitBehavior: "isolated maintenance worktree only"
    });
    const store = new StateStore(stateFile);
    const jobs = new JobService(store, new NullTaskNotifier(), { projects: registry });
    const autopilot = new AutopilotService({
      store,
      projects: registry,
      jobs,
      notifier: new NullAutopilotNotifier(),
      autoSchedule: false,
      config: {
        configured: true,
        managerModel: "test-manager",
        maxManagerDecisionsPerRun: 1,
        maxTasksPerRun: 1,
        maxFixAttemptsPerTask: 0,
        maxManagerRuntimeMs: 60_000
      }
    });
    const brief = await autopilot.createProjectBrief({
      projectId: "project-pilot-maintenance",
      title: "Maintenance brief",
      productSummary: "Project Pilot",
      requirements: "Improve Project Pilot.",
      constraints: "Use isolated worktree.",
      decisions: [],
      definitionOfDone: ["No live-root mutation."]
    });

    await expect(autopilot.startAutopilot({ projectId: "project-pilot-maintenance", briefId: brief.briefId })).rejects.toThrow(
      /Maintenance configuration is required/
    );
    await expect(store.listAutopilotRuns()).resolves.toHaveLength(0);
  });

  it("reports read-only maintenance blockers when configuration is absent or invalid", async () => {
    const liveStateFile = dataPath(`maintenance-status-live-state-${FILES.length}.json`);
    const liveRegistryFile = dataPath(`maintenance-status-live-projects-${FILES.length}.json`);
    FILES.push(liveStateFile, liveRegistryFile);
    const liveRegistry = new ProjectRegistry(liveRegistryFile, () => "2026-06-24T05:00:00.000Z");
    const liveProject = await liveRegistry.registerProject({
      id: "project-pilot-maintenance",
      name: "Project Pilot Maintenance",
      path: PROJECT_PILOT_LIVE_ROOT,
      gitRemoteName: "origin",
      buildCommand: "npm run build",
      testCommand: "npm test",
      checkCommand: "npm run check",
      defaultBranchName: "main",
      allowedGitBehavior: "isolated maintenance worktree only"
    });
    const liveService = new JobService(new StateStore(liveStateFile), new NullTaskNotifier(), {
      projects: liveRegistry,
      spawnJob: vi.fn()
    });

    const absentStatus = liveService.maintenanceStatus(liveProject);

    expect(absentStatus).toMatchObject({
      status: "blocked",
      readOnly: true,
      canStart: false,
      preflight: {
        ok: false,
        diagnostics: {
          projectId: "project-pilot-maintenance",
          maintenanceMode: false
        }
      }
    });
    expect(absentStatus.cannotStartReason).toMatch(/Maintenance configuration is required/);

    const { service, registry } = await serviceWithMaintenanceProject({ executionRoot: "missing" });
    const invalidProject = await registry.getProject("project-pilot-maintenance");
    const invalidStatus = service.maintenanceStatus(invalidProject);

    expect(invalidStatus).toMatchObject({
      status: "blocked",
      readOnly: true,
      canStart: false,
      preflight: {
        ok: false,
        diagnostics: {
          projectId: "project-pilot-maintenance",
          maintenanceMode: true
        }
      }
    });
    expect(invalidStatus.cannotStartReason).toMatch(/executionRoot is not configured/);
  });

  it("keeps status reads read-only while reporting blocked run diagnostics", async () => {
    const { service, registry, store, liveRoot, executionRoot, spawnJob } = await serviceWithMaintenanceProject({
      executionRoot: "missing"
    });
    await registry.setActiveProject("project-pilot-maintenance");
    const autopilot = autopilotForMaintenance({ service, registry, store });
    const run = blockedRun({ status: "blocked", phase: "paused", projectId: "project-pilot-maintenance" });
    await store.addAutopilotRun(run);

    const before = await store.read();
    const status = await autopilot.getAutopilotStatus(run.id);
    const list = await autopilot.listAutopilotRuns();
    const projectStatus = await getProjectStatus(store, registry);
    const after = await store.read();

    expect(status).toMatchObject({
      id: run.id,
      status: "blocked",
      maintenance: {
        status: "blocked",
        readOnly: true,
        canStart: false
      }
    });
    expect(status.maintenance.cannotStartReason).toMatch(/executionRoot is not configured/);
    expect(list.runs[0]?.maintenance).toMatchObject({ status: "blocked", readOnly: true });
    expect(projectStatus).toMatchObject({
      maintenance: {
        status: "blocked",
        readOnly: true,
        canStart: false
      }
    });
    expect(after).toEqual(before);
    expect(spawnJob).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(executionRoot, "TASK.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectLiveRootUnchanged(liveRoot);
  });

  it("resumes a valid isolated dirty-artifact maintenance run through the scheduler gate", async () => {
    const dirtyReason = "Expected Project Pilot task/report artifacts for autopilot-2026-06-26T02-00-03-717Z-0a7f1928.";
    const { service, registry, store, executionRoot, spawnJob } = await serviceWithMaintenanceProject({
      maintenance: {
        allowDirtyWorkingTree: true,
        dirtyWorkingTreeReason: dirtyReason
      },
      gitRunner: validMaintenanceGitRunner("feature/self-improvement-dashboard-workflow-v1", undefined, undefined, () =>
        " M TASK.md\n?? .project-pilot/logs/task.build.jsonl\n?? .project-pilot/reports/task/BUILD_REPORT.md\n"
      )
    });
    const autopilot = autopilotForMaintenance({ service, registry, store });
    const brief = await autopilot.createProjectBrief({
      projectId: "project-pilot-maintenance",
      title: "Maintenance brief",
      productSummary: "Project Pilot",
      requirements: "Resume a valid isolated maintenance run.",
      constraints: "Do not touch the live checkout.",
      decisions: [],
      definitionOfDone: ["Worker launches only in the isolated root."]
    });
    const run = blockedRun({
      briefId: brief.briefId,
      status: "blocked",
      phase: "paused",
      projectId: "project-pilot-maintenance",
      queue: [queueItem()]
    });
    await store.addAutopilotRun(run);

    const resumed = await autopilot.resumeAutopilot(run.id);
    await autopilot.tick(run.id);
    await waitUntil(() => spawnJob.mock.calls.length === 1);
    const status = await autopilot.getAutopilotStatus(run.id);

    expect(resumed.status).toBe("running");
    expect(spawnJob).toHaveBeenCalledTimes(1);
    expect(spawnJob.mock.calls[0][0]).toMatchObject({ projectRoot: executionRoot });
    expect(status.scheduler?.dispatchStatus).toBe("dispatched");
    expect(status.maintenance).toMatchObject({
      status: "ready",
      canStart: true,
      preflight: {
        ok: true,
        diagnostics: {
          dirtyFileCount: 3,
          dirtyWorkingTreeReason: dirtyReason
        }
      }
    });
  });

  it("blocks resume for missing or unsafe execution metadata without worker dispatch", async () => {
    const missing = await serviceWithMaintenanceProject({ executionRoot: "missing" });
    const missingAutopilot = autopilotForMaintenance({ service: missing.service, registry: missing.registry, store: missing.store });
    const missingRun = blockedRun({
      status: "blocked",
      phase: "paused",
      projectId: "project-pilot-maintenance",
      queue: [queueItem()]
    });
    await missing.store.addAutopilotRun(missingRun);

    const missingResume = await missingAutopilot.resumeAutopilot(missingRun.id);

    expect(missingResume).toMatchObject({
      status: "blocked",
      scheduler: {
        dispatchStatus: "resume-preflight-blocked"
      }
    });
    expect(missingResume.pauseReason).toMatch(/executionRoot is not configured/);
    expect(missing.spawnJob).not.toHaveBeenCalled();

    const unsafe = await serviceWithMaintenanceProject({ executionRoot: "live" });
    const unsafeAutopilot = autopilotForMaintenance({ service: unsafe.service, registry: unsafe.registry, store: unsafe.store });
    const unsafeRun = blockedRun({
      status: "blocked",
      phase: "paused",
      projectId: "project-pilot-maintenance",
      queue: [queueItem()]
    });
    await unsafe.store.addAutopilotRun(unsafeRun);

    const unsafeResume = await unsafeAutopilot.resumeAutopilot(unsafeRun.id);

    expect(unsafeResume.status).toBe("blocked");
    expect(unsafeResume.pauseReason).toMatch(/distinct from the registered project root|live Project Pilot checkout/i);
    expect(unsafe.spawnJob).not.toHaveBeenCalled();
    await expectLiveRootUnchanged(unsafe.liveRoot);
  });

  it("keeps blocked diagnostics structured and redacts secret-like text", async () => {
    const secretLikeReason = "temporary artifact exception sk-secret123456";
    const { service, registry } = await serviceWithMaintenanceProject({
      maintenance: {
        allowDirtyWorkingTree: true,
        dirtyWorkingTreeReason: secretLikeReason
      },
      gitRunner: validMaintenanceGitRunner("feature/self-improvement-dashboard-workflow-v1", undefined, undefined, () => " M TASK.md\n")
    });
    const project = await registry.getProject("project-pilot-maintenance");
    const status = service.maintenanceStatus(project);
    const text = JSON.stringify(status);

    expect(status).toMatchObject({
      status: "ready",
      readOnly: true,
      preflight: {
        ok: true,
        diagnostics: {
          dirtyFileCount: 1
        }
      }
    });
    expect(text).not.toMatch(/sk-secret123456/);
    expect(text).toMatch(/\[REDACTED_OPENAI_KEY\]/);
  });

  it("routes Autopilot queued work to the configured execution root after valid configuration", async () => {
    const { service, registry, store, spawnJob, executionRoot } = await serviceWithPlainProject();
    await service.configureMaintenanceExecution({
      projectId: "project-pilot-maintenance",
      enabled: true,
      liveRoot: (await registry.getProject("project-pilot-maintenance")).path,
      executionRoot,
      baseBranch: "main",
      expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
    });
    const autopilot = new AutopilotService({
      store,
      projects: registry,
      jobs: service,
      manager: {
        decide: async () => ({
          action: "create_ordered_tasks",
          summary: "Queue maintenance task",
          reason: null,
          taskId: null,
          tasks: [taskInput()],
          fixTask: null
        })
      },
      notifier: new NullAutopilotNotifier(),
      autoSchedule: false,
      config: {
        configured: true,
        managerModel: "test-manager",
        maxManagerDecisionsPerRun: 3,
        maxTasksPerRun: 3,
        maxFixAttemptsPerTask: 0,
        maxManagerRuntimeMs: 60_000
      }
    });
    const brief = await autopilot.createProjectBrief({
      projectId: "project-pilot-maintenance",
      title: "Maintenance brief",
      productSummary: "Project Pilot",
      requirements: "Improve Project Pilot.",
      constraints: "Use isolated worktree.",
      decisions: [],
      definitionOfDone: ["No live-root mutation."]
    });
    const run = await autopilot.startAutopilot({ projectId: "project-pilot-maintenance", briefId: brief.briefId });

    await autopilot.tick(run.runId);
    await autopilot.tick(run.runId);
    await waitUntil(() => spawnJob.mock.calls.length === 1);
    await waitUntil(async () => (await store.listTasks()).some((task) => task.build.status === "passed"));

    expect(spawnJob.mock.calls[0][0]).toMatchObject({ projectRoot: executionRoot });
    const runs = await store.listAutopilotRuns();
    expect(runs[0]?.workers?.[0]?.reportPath).toBe(
      path.join(executionRoot, ".project-pilot", "reports", String(runs[0]?.workers?.[0]?.taskId), "BUILD_REPORT.md")
    );
  });

  it("exposes dashboard-safe maintenance status without leaking secrets", async () => {
    const { service, registry, executionRoot } = await serviceWithPlainProject();
    await expect(
      service.configureMaintenanceExecution({
        projectId: "project-pilot-maintenance",
        enabled: true,
        liveRoot: (await registry.getProject("project-pilot-maintenance")).path,
        executionRoot,
        baseBranch: "main",
        expectedBranch: "feature/self-improvement-dashboard-workflow-v1",
        allowDirtyWorkingTree: true,
        dirtyWorkingTreeReason: "sk-secret123456"
      })
    ).rejects.toThrow(/must not contain secrets/);

    await service.configureMaintenanceExecution({
      projectId: "project-pilot-maintenance",
      enabled: true,
      liveRoot: (await registry.getProject("project-pilot-maintenance")).path,
      executionRoot,
      baseBranch: "main",
      expectedBranch: "feature/self-improvement-dashboard-workflow-v1"
    });
    const status = service.maintenanceStatus(await registry.getProject("project-pilot-maintenance"));

    expect(status).toMatchObject({
      enabled: true,
      liveRoot: expect.any(String),
      executionRoot: expect.any(String),
      expectedBranch: "feature/self-improvement-dashboard-workflow-v1",
      canStart: true
    });
    expect(JSON.stringify(status)).not.toMatch(/sk-secret|dirtyWorkingTreeReason/);
  });
});

async function serviceWithMaintenanceProject(options: {
  executionRoot?: "isolated" | "live" | "missing";
  maintenance?: Partial<ProjectMaintenanceConfig>;
  gitRunner?: (args: string[], cwd: string) => string;
  spawnOutput?: (prompt: string) => string;
} = {}) {
  const index = FILES.length;
  const stateFile = dataPath(`maintenance-state-${index}.json`);
  const registryFile = dataPath(`maintenance-projects-${index}.json`);
  FILES.push(stateFile, registryFile);

  const liveRoot = path.join(DATA_DIR, `maintenance-live-${index}`);
  const isolatedRoot = path.join(DATA_DIR, `maintenance-worktree-${index}`);
  const executionRoot = options.executionRoot === "live" ? liveRoot : options.executionRoot === "missing" ? undefined : isolatedRoot;
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
      baseBranch: "main",
      expectedBranch: "feature/self-improvement-dashboard-workflow-v1",
      ...options.maintenance
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
      if (args[0] === "branch") return "feature/self-improvement-dashboard-workflow-v1\n";
      if (args[0] === "show-ref") return "";
      if (args[0] === "merge-base") return "";
      if (args[0] === "worktree") return `worktree ${liveRoot}\nHEAD abc\n\nworktree ${executionRoot ?? isolatedRoot}\nHEAD def\n`;
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

  return { service, registry, project: project as ProjectRecord, liveRoot, executionRoot: executionRoot ?? isolatedRoot, spawnJob, store };
}

async function serviceWithPlainProject(options: {
  gitRunner?: (args: string[], cwd: string) => string;
} = {}) {
  const index = FILES.length;
  const stateFile = dataPath(`maintenance-plain-state-${index}.json`);
  const registryFile = dataPath(`maintenance-plain-projects-${index}.json`);
  FILES.push(stateFile, registryFile);

  const liveRoot = path.join(DATA_DIR, `maintenance-plain-live-${index}`);
  const executionRoot = path.join(DATA_DIR, `maintenance-plain-worktree-${index}`);
  DIRS.push(liveRoot, executionRoot);
  await fs.mkdir(liveRoot, { recursive: true });
  await fs.mkdir(executionRoot, { recursive: true });

  const registry = new ProjectRegistry(registryFile, () => "2026-06-24T05:00:00.000Z");
  await registry.registerProject({
    id: "project-pilot-maintenance",
    name: "Project Pilot Maintenance",
    path: liveRoot,
    gitRemoteName: "origin",
    buildCommand: "npm run build",
    testCommand: "npm test",
    checkCommand: "npm run check",
    defaultBranchName: "main",
    allowedGitBehavior: "isolated maintenance worktree only"
  });

  const spawnJob = vi.fn((spawnOptions: {
    prompt: string;
    onClose?: (exitCode: number | null, signal: NodeJS.Signals | null, stdoutText: string) => void;
  }) => {
    setTimeout(() => spawnOptions.onClose?.(0, null, ""), 5);
    return fakeChild(6262);
  });
  const store = new StateStore(stateFile);
  const service = new JobService(store, new NullTaskNotifier(), {
    projects: registry,
    spawnJob,
    gitRunner: options.gitRunner ?? validMaintenanceGitRunner("feature/self-improvement-dashboard-workflow-v1", liveRoot, executionRoot),
    processExists: (pid) => pid === 6262,
    now: () => "2026-06-24T05:10:00.000Z"
  });

  return { service, registry, liveRoot, executionRoot, spawnJob, store };
}

function validMaintenanceGitRunner(branch: string, liveRoot?: string, executionRoot?: string, statusOutput?: () => string) {
  return (args: string[], cwd: string) => {
    if (args[0] === "rev-parse") return `${cwd}\n`;
    if (args[0] === "branch") return `${branch}\n`;
    if (args[0] === "show-ref") return "";
    if (args[0] === "merge-base") return "";
    if (args[0] === "worktree") return `worktree ${liveRoot ?? path.dirname(cwd)}\nHEAD abc\n\nworktree ${executionRoot ?? cwd}\nHEAD def\n`;
    if (args[0] === "status") return statusOutput?.() ?? "";
    return "";
  };
}

function autopilotForMaintenance(options: { service: JobService; registry: ProjectRegistry; store: StateStore }) {
  return new AutopilotService({
    store: options.store,
    projects: options.registry,
    jobs: options.service,
    autoSchedule: false,
    manager: {
      decide: async () => ({
        action: "pause_for_blocker",
        summary: "No manager dispatch needed.",
        reason: "Test paused.",
        taskId: null,
        tasks: null,
        fixTask: null
      })
    },
    notifier: new NullAutopilotNotifier(),
    config: {
      configured: true,
      managerModel: "test-manager",
      maxManagerDecisionsPerRun: 3,
      maxTasksPerRun: 3,
      maxFixAttemptsPerTask: 0,
      maxManagerRuntimeMs: 60_000
    }
  });
}

function blockedRun(overrides: Partial<AutopilotRunRecord> = {}): AutopilotRunRecord {
  return {
    id: `autopilot-2026-06-24T05-00-00-000Z-${String(Math.random()).slice(2, 10).padEnd(8, "0")}`,
    projectId: "project-pilot-maintenance",
    briefId: "brief-2026-06-24T05-00-00-000Z-test0000",
    status: "blocked",
    phase: "paused",
    createdAt: "2026-06-24T05:00:00.000Z",
    updatedAt: "2026-06-24T05:00:00.000Z",
    startedAt: "2026-06-24T05:00:00.000Z",
    pausedAt: "2026-06-24T05:01:00.000Z",
    pauseReason: "Blocked in test.",
    activeRuntimeMs: 0,
    activeRuntimeStartedAt: undefined,
    nextAction: null,
    decisionsUsed: 0,
    tasksStarted: 0,
    fixAttemptsByTaskId: {},
    recoveryAttemptsByTaskId: {},
    queue: [],
    decisions: [],
    timeline: [{ at: "2026-06-24T05:00:00.000Z", kind: "status", summary: "Test run created." }],
    codexThreads: {},
    limits: {
      maxManagerDecisions: 3,
      maxTasks: 3,
      maxFixAttemptsPerTask: 0,
      maxRuntimeMs: 60_000
    },
    scheduler: {
      dispatchStatus: "test-blocked"
    },
    workers: [],
    ...overrides
  };
}

function queueItem() {
  return {
    id: `queue-${String(Math.random()).slice(2, 10).padEnd(8, "0")}`,
    title: "Maintenance task",
    requirements: "Resume and continue safely.",
    acceptanceCriteria: ["Worker launches only in isolated root."],
    source: "manager" as const,
    status: "queued" as const,
    createdAt: "2026-06-24T05:00:00.000Z",
    updatedAt: "2026-06-24T05:00:00.000Z"
  };
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
