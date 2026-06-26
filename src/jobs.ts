import fs from "node:fs/promises";
import path from "node:path";
import {
  buildReportFile,
  planReportFile,
  reviewReportFile,
  taskBuildReportFile,
  taskReportsDir,
  taskReviewReportFile,
  taskFile,
  assertAllowedPath
} from "./paths.js";
import {
  CODEX_ACCESS_MODE,
  CODEX_ACCESS_WARNING,
  CODEX_APPROVAL_POLICY,
  assertPlanId,
  buildLogPath,
  buildPlanLogPath,
  createPlanId,
  createTaskId,
  spawnCodexJob,
  assertTaskId,
  type SpawnedCodexJob
} from "./codex.js";
import { readLogTail, readTextIfExists, extractPlanReport, extractReviewReport } from "./logs.js";
import { buildPrompt, planPrompt, renderTaskMarkdown, reviewPrompt } from "./prompts.js";
import { StateStore } from "./state.js";
import {
  maintenanceStatus,
  preflightWorkerLaunch,
  taskArtifactRoot,
  taskLocalLogPath,
  type GitCommandRunner,
  type GitPreflightResult
} from "./execution.js";
import { completeReadyTask, deriveTaskStatus } from "./task-status.js";
import { WindowsTaskNotifier, type TaskNotifier } from "./notifications.js";
import {
  evaluateApprovalPolicy,
  parseStrictBuildVerificationEvidence,
  projectVerificationCommands
} from "./approval-policy.js";
import { DEFAULT_PROJECT_ID, ProjectRegistry, type MaintenanceExecutionUpdateInput, type RegisterProjectInput } from "./projects.js";
import type {
  JobStatus,
  PlanDetails,
  PlanInput,
  PlanRecord,
  PlanSummary,
  PlanStatus,
  PlanStatusHistoryEntry,
  ProjectRecord,
  ReviewResult,
  TaskDetails,
  TaskInput,
  VerificationAuditEvent,
  VerificationDisplayStatus,
  VerificationRecord,
  TaskRecord,
  TaskStatus,
  TaskStatusHistoryEntry,
  TaskSummary
} from "./types.js";

const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_REVIEW_TIMEOUT_MS = 8 * 60 * 1000;

type JobKind = "build" | "review" | "plan";
type SpawnCodexJob = typeof spawnCodexJob;

export interface JobServiceOptions {
  spawnJob?: SpawnCodexJob;
  processExists?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  buildTimeoutMs?: number;
  reviewTimeoutMs?: number;
  now?: () => string;
  gitRunner?: GitCommandRunner;
}

export interface PreparedBuild {
  task: TaskRecord;
  project: ProjectRecord;
  input: TaskInput;
  logPath: string;
  duplicate?: boolean;
}

export class JobService {
  private readonly store: StateStore;
  private readonly projects: ProjectRegistry;
  private readonly notifier: TaskNotifier;
  private readonly spawnJob: SpawnCodexJob;
  private readonly processExists: (pid: number) => boolean;
  private readonly killProcess: (pid: number) => void;
  private readonly buildTimeoutMs: number;
  private readonly reviewTimeoutMs: number;
  private readonly now: () => string;
  private readonly gitRunner?: GitCommandRunner;

  constructor(
    store = new StateStore(),
    notifier: TaskNotifier = new WindowsTaskNotifier(),
    options: JobServiceOptions & { projects?: ProjectRegistry } = {}
  ) {
    this.store = store;
    this.projects = options.projects ?? new ProjectRegistry();
    this.notifier = notifier;
    this.spawnJob = options.spawnJob ?? spawnCodexJob;
    this.processExists = options.processExists ?? defaultProcessExists;
    this.killProcess = options.killProcess ?? ((pid) => process.kill(pid));
    this.buildTimeoutMs = options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    this.reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date().toISOString());
    this.gitRunner = options.gitRunner;
  }

  async startBuild(input: TaskInput): Promise<{ taskId: string; status: TaskStatus }> {
    const prepared = await this.prepareBuild(input);
    if (prepared.duplicate) {
      return { taskId: prepared.task.id, status: deriveTaskStatus(prepared.task) };
    }

    const preflight = this.preflightWorkerLaunch(prepared.project);
    if (!preflight.ok) {
      await this.store.addTask(blockPreparedBuild(prepared.task, preflight.reason ?? "Maintenance Git preflight failed.", this.now()));
      return { taskId: prepared.task.id, status: "blocked" };
    }

    await fs.writeFile(
      assertAllowedPath(taskFile(taskArtifactRoot(prepared.project))),
      renderTaskMarkdown(prepared.task.id, prepared.input),
      "utf8"
    );
    await this.store.addTask(prepared.task);

    this.launchPreparedBuild(prepared);

    return { taskId: prepared.task.id, status: "queued" };
  }

  async prepareBuild(input: TaskInput): Promise<PreparedBuild> {
    const project = input.projectId ? await this.projects.getProject(input.projectId) : await this.projects.getActiveProject();
    const duplicate = await this.findDuplicateTask(project.id, input);
    if (duplicate) {
      return {
        task: duplicate,
        project,
        input,
        logPath: duplicate.build.logPath,
        duplicate: true
      };
    }

    const taskId = createTaskId();
    const now = this.now();
    const logPath = this.workerLogPath(project, taskId, "build");
    const task: TaskRecord = {
      id: taskId,
      projectId: project.id,
      title: input.title,
      requirements: input.requirements,
      acceptanceCriteria: input.acceptanceCriteria,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      build: {
        status: "queued",
        logPath
      }
    };

    return { task, project, input, logPath };
  }

  async launchPreparedBuild(prepared: PreparedBuild): Promise<void> {
    if (prepared.duplicate) {
      return;
    }
    const preflight = this.preflightWorkerLaunch(prepared.project);
    if (!preflight.ok) {
      await this.blockBuild(prepared.task.id, preflight.reason ?? "Maintenance Git preflight failed.");
      return;
    }
    await fs.writeFile(
      assertAllowedPath(taskFile(taskArtifactRoot(prepared.project))),
      renderTaskMarkdown(prepared.task.id, prepared.input),
      "utf8"
    );
    setImmediate(() => {
      void this.launchBuild(prepared.task.id, prepared.project, prepared.logPath);
    });
  }

  async listProjects(): Promise<{ projects: ProjectRecord[]; activeProjectId?: string }> {
    return await this.projects.listProjects();
  }

  async getProject(projectId: string): Promise<ProjectRecord> {
    return await this.projects.getProject(projectId);
  }

  async registerProject(input: RegisterProjectInput): Promise<ProjectRecord> {
    return await this.projects.registerProject(input);
  }

  async configureMaintenanceExecution(input: MaintenanceExecutionUpdateInput): Promise<Record<string, unknown>> {
    const result = await this.projects.configureMaintenanceExecution(input, this.gitRunner);
    return {
      project: result.project,
      maintenance: maintenanceStatus(result.project, this.gitRunner),
      preflight: result.preflight
    };
  }

  async setActiveProject(projectId: string): Promise<ProjectRecord> {
    return await this.projects.setActiveProject(projectId);
  }

  async getActiveProject(): Promise<ProjectRecord> {
    return await this.projects.getActiveProject();
  }

  preflightWorkerLaunch(project: ProjectRecord): GitPreflightResult {
    return preflightWorkerLaunch(project, this.gitRunner);
  }

  maintenanceStatus(project: ProjectRecord): Record<string, unknown> {
    return maintenanceStatus(project, this.gitRunner);
  }

  async getBuildStatus(taskId: string): Promise<Record<string, unknown>> {
    assertTaskId(taskId);
    await this.reconcileTask(taskId);
    const task = await this.requireTask(taskId);
    const project = await this.projectForTask(task);
    const buildEvidence = await this.readBuildEvidence(task, project);
    return {
      taskId,
      status: task.build.status,
      taskStatus: deriveTaskStatus(task),
      startedAt: task.build.startedAt,
      endedAt: task.build.endedAt,
      exitCode: task.build.exitCode,
      error: task.build.error,
      logTail: await readLogTail(task.build.logPath),
      buildReport: buildEvidence.report ?? null,
      buildReportPath: buildEvidence.path,
      canonicalBuildReportPath: taskBuildReportFile(taskArtifactRoot(project), task.id),
      legacyBuildReportPath: buildReportFile(taskArtifactRoot(project)),
      evidenceDiagnostic: buildEvidence.diagnostic
    };
  }

  async listTasks(): Promise<{ tasks: TaskSummary[] }> {
    await this.reconcileUnfinishedTasks();
    const tasks = await this.store.listTasks();
    return {
      tasks: await Promise.all(tasks.map((task) => this.toTaskSummary(task)))
    };
  }

  async approveTask(taskId: string): Promise<{
    taskId: string;
    status: "completed";
    completedAt: string;
    message: string;
    task: TaskSummary;
  }>;
  async approveTask(input: { taskId: string; reason: string; reviewedRiskEvidence?: boolean }): Promise<{
    taskId: string;
    status: "completed";
    completedAt: string;
    message: string;
    task: TaskSummary;
    approval: unknown;
  }>;
  async approveTask(input: string | { taskId: string; reason: string; reviewedRiskEvidence?: boolean }): Promise<{
    taskId: string;
    status: "completed";
    completedAt: string;
    message: string;
    task: TaskSummary;
    approval?: unknown;
  }> {
    const taskId = typeof input === "string" ? input : input.taskId;
    const reason = typeof input === "string" ? "Manual approval." : input.reason.trim();
    const reviewedRiskEvidence = typeof input === "string" ? false : Boolean(input.reviewedRiskEvidence);
    assertTaskId(taskId);
    if (!reason) {
      throw new Error("Approval reason is required.");
    }
    await this.reconcileTask(taskId);
    const approval = await this.evaluateTaskApproval(taskId);
    assertManualApprovalAllowed(approval, reviewedRiskEvidence);
    const completedAt = this.now();
    const run = await this.findRunForTask(taskId);
    const task = await this.updateTaskAndNotify(taskId, (existing) => ({
      ...completeReadyTask(existing, completedAt),
      approvalActions: [
        ...(existing.approvalActions ?? []),
        {
          kind: "approved",
          at: completedAt,
          taskId,
          runId: run?.id,
          reason,
          reviewedRiskEvidence,
          priorRiskFlags: approval.riskFlags,
          riskEvidence: approval.riskEvidence,
          resultingStatus: "completed"
        }
      ]
    }));
    if (run) {
      await this.store.updateAutopilotRun(run.id, (existing) => ({
        ...existing,
        currentTaskId: existing.currentTaskId === taskId ? undefined : existing.currentTaskId,
        lastCompletedTaskId: taskId,
        phase: "paused",
        pauseReason: "Task manually approved; ready for user-controlled resume.",
        timeline: [
          ...existing.timeline,
          {
            at: completedAt,
            kind: "status",
            summary: `Task ${taskId} manually approved. Reason: ${reason}`,
            data: {
              taskId,
              priorRiskFlags: approval.riskFlags,
              reviewedRiskEvidence
            }
          }
        ]
      }));
    }
    return {
      taskId,
      status: "completed",
      completedAt,
      message: `Task ${taskId} marked completed.`,
      approval,
      task: await this.toTaskSummary(task)
    };
  }

  async declineTaskApproval(input: { taskId: string; reason: string }): Promise<Record<string, unknown>> {
    const taskId = input.taskId;
    const reason = input.reason.trim();
    assertTaskId(taskId);
    if (!reason) {
      throw new Error("Decline reason is required.");
    }
    await this.reconcileTask(taskId);
    const task = await this.requireTask(taskId);
    if (deriveTaskStatus(task) !== "ready-for-approval") {
      throw new Error(`Task ${taskId} is ${deriveTaskStatus(task)}, not ready-for-approval.`);
    }
    const approval = await this.evaluateTaskApproval(taskId);
    const at = this.now();
    const run = await this.findRunForTask(taskId);
    const updated = await this.store.updateTask(taskId, (existing) => ({
      ...existing,
      approvalActions: [
        ...(existing.approvalActions ?? []),
        {
          kind: "declined",
          at,
          taskId,
          runId: run?.id,
          reason,
          reviewedRiskEvidence: false,
          priorRiskFlags: approval.riskFlags,
          riskEvidence: approval.riskEvidence,
          resultingStatus: deriveTaskStatus(existing)
        }
      ]
    }));
    if (run) {
      await this.store.updateAutopilotRun(run.id, (existing) => ({
        ...existing,
        status: "paused",
        phase: "paused",
        pausedAt: at,
        pauseReason: `Task approval declined: ${reason}`,
        timeline: [
          ...existing.timeline,
          {
            at,
            kind: "status",
            summary: `Task ${taskId} approval declined. Reason: ${reason}`,
            data: { taskId, priorRiskFlags: approval.riskFlags }
          }
        ]
      }));
    }
    return {
      taskId,
      status: deriveTaskStatus(updated),
      runId: run?.id,
      message: `Task ${taskId} remains paused for approval.`,
      approval,
      task: await this.toTaskSummary(updated)
    };
  }

  async finalizeTask(taskId: string): Promise<Record<string, unknown>> {
    assertTaskId(taskId);
    await this.reconcileTaskForAutopilot(taskId, false);
    const decision = await this.evaluateTaskApproval(taskId);
    if (!decision.eligible) {
      return {
        taskId,
        status: "manual_approval_required",
        approval: decision,
        reasons: decision.reasons,
        riskFlags: decision.riskFlags
      };
    }

    const completed = await this.completeTask(taskId, "Task auto-completed by approval policy.");
    return {
      taskId,
      status: "completed",
      completedAt: completed.completedAt,
      message: `Task ${taskId} auto-completed by approval policy.`,
      approval: completed.task.approval,
      task: completed.task
    };
  }

  async getTaskDetails(taskId: string): Promise<TaskDetails> {
    assertTaskId(taskId);
    await this.reconcileTaskForAutopilot(taskId, false);
    const task = await this.requireTask(taskId);
    const project = await this.projectForTask(task);
    const approval = await this.evaluateTaskApproval(taskId);
    const buildEvidence = await this.readBuildEvidence(task, project);
    const reviewEvidence = await this.readReviewEvidence(task, project);
    return {
      ...(await this.toTaskSummary(task)),
      requirements: task.requirements,
      acceptanceCriteria: task.acceptanceCriteria,
      statusHistory: buildStatusHistory(task),
      errors: collectErrors(task),
      buildLog: (await readTextIfExists(task.build.logPath)) ?? "",
      reviewLog: task.review?.logPath ? (await readTextIfExists(task.review.logPath)) ?? "" : "",
      buildReport: buildEvidence.report ?? null,
      reviewReport: reviewEvidence.report ?? null,
      verification: task.verification ?? [],
      verificationEvents: task.verificationEvents ?? [],
      approvalActions: task.approvalActions ?? [],
      evidencePaths: {
        buildReport: buildEvidence.path,
        reviewReport: reviewEvidence.path,
        canonicalBuildReport: taskBuildReportFile(taskArtifactRoot(project), task.id),
        canonicalReviewReport: taskReviewReportFile(taskArtifactRoot(project), task.id),
        legacyBuildReport: buildReportFile(taskArtifactRoot(project)),
        legacyReviewReport: reviewReportFile(taskArtifactRoot(project))
      },
      verificationIdentity: {
        taskId: task.id,
        runId: (await this.findRunForTask(task.id))?.id ?? null,
        executionRoot: taskArtifactRoot(project),
        branch: this.branchForEvidence(project),
        buildEvidenceDiagnostic: buildEvidence.diagnostic,
        reviewEvidenceDiagnostic: reviewEvidence.diagnostic
      },
      approval
    };
  }

  async runReview(taskId: string): Promise<Record<string, unknown>> {
    assertTaskId(taskId);
    await this.reconcileTask(taskId);
    await this.assertNoActiveReview(taskId);
    const task = await this.requireTask(taskId);
    const project = await this.projectForTask(task);
    const preflight = this.preflightWorkerLaunch(project);
    if (!preflight.ok) {
      await this.blockReview(taskId, preflight.reason ?? "Maintenance Git preflight failed.");
      return {
        taskId,
        taskStatus: "blocked",
        result: "blocked",
        error: preflight.reason ?? "Maintenance Git preflight failed."
      };
    }
    const logPath = this.workerLogPath(project, taskId, "review");
    const now = this.now();
    await this.updateTaskAndNotify(taskId, (existing) => ({
      ...existing,
      status: "reviewing",
      review: {
        status: "queued",
        logPath,
        startedAt: now
      }
    }));

    return await new Promise((resolve) => {
      void this.launchReview(taskId, project, logPath, resolve);
    });
  }

  async retryReview(taskId: string): Promise<Record<string, unknown>> {
    assertTaskId(taskId);
    await this.reconcileTask(taskId);
    await this.assertRetryReviewAllowed(taskId);
    return await this.runReview(taskId);
  }

  async startPlan(input: PlanInput): Promise<{ planId: string; status: "queued" }> {
    const project = await this.projects.getProject(input.projectId);
    const planId = createPlanId();
    const now = this.now();
    const logPath = this.planLogPath(project, planId);
    const preflight = this.preflightWorkerLaunch(project);
    const plan: PlanRecord = {
      id: planId,
      projectId: project.id,
      title: input.title,
      requirements: input.requirements,
      constraints: input.constraints,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      logPath,
      reportPath: planReportFile(taskArtifactRoot(project))
    };

    await this.store.addPlan(plan);
    if (!preflight.ok) {
      await this.blockPlan(planId, preflight.reason ?? "Maintenance Git preflight failed.");
      return { planId, status: "queued" };
    }
    setImmediate(() => {
      void this.launchPlan(planId, project, input, logPath);
    });

    return { planId, status: "queued" };
  }

  async listPlans(): Promise<{ plans: PlanSummary[] }> {
    await this.reconcileUnfinishedTasks();
    const plans = await this.store.listPlans();
    return {
      plans: await Promise.all(plans.map((plan) => this.toPlanSummary(plan)))
    };
  }

  async getPlanStatus(planId: string): Promise<Record<string, unknown>> {
    assertPlanId(planId);
    await this.reconcilePlan(planId);
    const plan = await this.requirePlan(planId);
    const logTail = await readLogTail(plan.logPath, 20);
    return {
      planId,
      status: plan.status,
      pid: plan.pid,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      startedAt: plan.startedAt,
      endedAt: plan.endedAt,
      exitCode: plan.exitCode,
      error: plan.error,
      logTail,
      latestLogLines: logTail ? logTail.split(/\r?\n/) : []
    };
  }

  async getPlanDetails(planId: string): Promise<PlanDetails> {
    assertPlanId(planId);
    await this.reconcilePlan(planId);
    const plan = await this.requirePlan(planId);
    const report = await readTextIfExists(plan.reportPath);
    return {
      ...(await this.toPlanSummary(plan)),
      requirements: plan.requirements,
      constraints: plan.constraints,
      pid: plan.pid,
      startedAt: plan.startedAt,
      endedAt: plan.endedAt,
      exitCode: plan.exitCode,
      statusHistory: buildPlanStatusHistory(plan),
      errors: collectPlanErrors(plan),
      logTail: await readLogTail(plan.logPath, 40),
      report: report ? normalizePlanReportText(report) : null,
      log: (await readTextIfExists(plan.logPath)) ?? ""
    };
  }

  async createTaskFromPlan(input: {
    planId: string;
    title?: string;
    requirements?: string;
    acceptanceCriteria?: string[];
  }): Promise<{ taskId: string; status: TaskStatus; message: string; task: TaskSummary }> {
    assertPlanId(input.planId);
    await this.reconcilePlan(input.planId);
    const plan = await this.requirePlan(input.planId);
    if (plan.status !== "plan-ready") {
      throw new Error(`Plan ${input.planId} is ${plan.status}, not plan-ready.`);
    }
    const project = await this.projects.getProject(plan.projectId);
    const taskId = createTaskId();
    const report = (await readTextIfExists(plan.reportPath)) ?? "";
    const taskInput: TaskInput = {
      projectId: project.id,
      title: input.title?.trim() || plan.title,
      requirements: input.requirements?.trim() || planTaskRequirements(plan, report),
      acceptanceCriteria:
        input.acceptanceCriteria && input.acceptanceCriteria.length > 0
          ? input.acceptanceCriteria
          : ["Implementation follows the approved plan.", "Configured project checks pass.", "Independent review passes."]
    };
    const preflight = this.preflightWorkerLaunch(project);
    if (!preflight.ok) {
      throw new Error(`Cannot create task from plan until maintenance Git preflight passes: ${preflight.reason ?? "Git preflight failed."}`);
    }
    const duplicate = await this.findDuplicateTask(project.id, taskInput);
    if (duplicate) {
      return {
        taskId: duplicate.id,
        status: deriveTaskStatus(duplicate),
        message: `Existing task ${duplicate.id} already covers this task scope. No duplicate implementation task was created.`,
        task: await this.toTaskSummary(duplicate)
      };
    }

    const task: TaskRecord = {
      id: taskId,
      projectId: project.id,
      sourcePlanId: plan.id,
      title: taskInput.title,
      requirements: taskInput.requirements,
      acceptanceCriteria: taskInput.acceptanceCriteria,
      status: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
      build: {
        status: "queued",
        logPath: this.workerLogPath(project, taskId, "build")
      }
    };

    await fs.writeFile(assertAllowedPath(taskFile(taskArtifactRoot(project))), renderTaskMarkdown(taskId, taskInput), "utf8");
    await this.store.addTask(task);

    return {
      taskId,
      status: "queued",
      message: `Task ${taskId} created from plan ${plan.id}. Implementation was not started.`,
      task: await this.toTaskSummary(task)
    };
  }

  async stopTask(taskId: string): Promise<Record<string, unknown>> {
    assertTaskId(taskId);
    await this.reconcileTask(taskId);
    const task = await this.requireTask(taskId);
    const active = activeJob(task);
    if (!active || active.record.pid === undefined || !this.processExists(active.record.pid)) {
      throw new Error(`Task ${taskId} has no tracked active build or review process.`);
    }

    try {
      this.killProcess(active.record.pid);
    } catch (error) {
      throw new Error(`Failed to stop tracked ${active.kind} process ${active.record.pid}: ${errorMessage(error)}`);
    }

    const stopped = await this.updateTaskAndNotify(taskId, (existing) =>
      active.kind === "review"
        ? {
            ...existing,
            status: "stopped",
            review: {
              ...existing.review!,
              status: "stopped",
              exitCode: null,
              endedAt: this.now(),
              error: `Stopped by user request. Terminated tracked review PID ${active.record.pid}.`
            }
          }
        : {
            ...existing,
            status: "stopped",
            build: {
              ...existing.build,
              status: "stopped",
              exitCode: null,
              endedAt: this.now(),
              error: `Stopped by user request. Terminated tracked build PID ${active.record.pid}.`
            }
          }
    );

    return {
      taskId,
      stopped: active.kind,
      pid: active.record.pid,
      taskStatus: deriveTaskStatus(stopped),
      logTail: await readLogTail(active.record.logPath)
    };
  }

  async reconcileUnfinishedTasks(): Promise<void> {
    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      try {
        await this.reconcileTask(task.id);
        await this.reconcileVerification(task.id);
      } catch (error) {
        if (this.isUnknownTaskError(error, task.id)) {
          continue;
        }
        throw error;
      }
    }
    const plans = await this.store.listPlans();
    for (const plan of plans) {
      await this.reconcilePlan(plan.id);
    }
  }

  async reconcileTaskForAutopilot(taskId: string, allowFinalize = true): Promise<TaskRecord> {
    assertTaskId(taskId);
    await this.reconcileTask(taskId);
    await this.reconcileVerification(taskId);
    const task = await this.requireTask(taskId);
    if (!allowFinalize || deriveTaskStatus(task) !== "ready-for-approval") {
      return task;
    }
    const decision = await this.evaluateTaskApproval(taskId);
    if (!decision.eligible) {
      return task;
    }
    await this.completeTask(taskId, "Task auto-completed by approval policy during reconciliation.");
    return await this.requireTask(taskId);
  }

  async cancelDuplicateQueuedTasks(projectId?: string): Promise<TaskRecord[]> {
    const tasks = await this.store.listTasks();
    const cancelled: TaskRecord[] = [];
    for (const task of tasks) {
      if (projectId && (task.projectId ?? DEFAULT_PROJECT_ID) !== projectId) {
        continue;
      }
      if (deriveTaskStatus(task) !== "queued" || task.build.status !== "queued") {
        continue;
      }
      const duplicate = tasks.find(
        (candidate) =>
          candidate.id !== task.id &&
          (candidate.projectId ?? DEFAULT_PROJECT_ID) === (task.projectId ?? DEFAULT_PROJECT_ID) &&
          taskScopeKey(candidate) === taskScopeKey(task) &&
          duplicateKeeperStatus(deriveTaskStatus(candidate))
      );
      if (!duplicate) {
        continue;
      }
      cancelled.push(await this.cancelDuplicateQueuedTask(task.id, `Duplicate of ${duplicate.id}.`));
    }
    return cancelled;
  }

  async cancelDuplicateQueuedTask(taskId: string, reason = "Duplicate queued task."): Promise<TaskRecord> {
    assertTaskId(taskId);
    const tasks = await this.store.listTasks();
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Unknown taskId: ${taskId}`);
    }
    if (deriveTaskStatus(task) !== "queued" || task.build.status !== "queued") {
      throw new Error(`Task ${taskId} is not a queued task and cannot be skipped as a duplicate.`);
    }
    const duplicate = tasks.find(
      (candidate) =>
        candidate.id !== task.id &&
        (candidate.projectId ?? DEFAULT_PROJECT_ID) === (task.projectId ?? DEFAULT_PROJECT_ID) &&
        taskScopeKey(candidate) === taskScopeKey(task) &&
        duplicateKeeperStatus(deriveTaskStatus(candidate))
    );
    if (!duplicate) {
      throw new Error(`Task ${taskId} does not duplicate an active, completed, or reviewed task.`);
    }

    return await this.updateTaskAndNotify(task.id, (existing) => ({
      ...existing,
      status: "stopped",
      build: {
        ...existing.build,
        status: "stopped",
        exitCode: null,
        endedAt: this.now(),
        error: `Cancelled as duplicate of ${duplicate.id}; ${reason} Historical record preserved and no worker was launched.`
      }
    }));
  }

  private async reconcileTask(taskId: string): Promise<void> {
    const task = await this.requireTask(taskId);
    const project = await this.projectForTask(task);

    if (isReviewActive(task)) {
      const reviewResult = await this.readMatchingReviewResult(task.id, project);
      if (reviewResult) {
        await this.applyReviewResult(
          task.id,
          project,
          task.review!.logPath,
          reviewResult.result,
          null,
          reviewResult.report,
          "Reconciled from REVIEW_REPORT.md."
        );
        return;
      }

      if (task.review?.pid === undefined) {
        await this.blockReview(
          task.id,
          "Review was marked active, but Project Pilot never persisted a child process ID. The review process was not successfully tracked."
        );
        return;
      }

      if (!this.processExists(task.review.pid)) {
        await this.blockReview(
          task.id,
          `Tracked review process PID ${task.review.pid} is no longer running. Project Pilot did not observe a terminal event before restart or status read.`
        );
      }
      return;
    }

    if (isBuildActive(task)) {
      if (task.build.pid === undefined) {
        await this.blockBuild(
          task.id,
          "Build was marked active, but Project Pilot never persisted a child process ID. The build process was not successfully tracked."
        );
        return;
      }

      if (!this.processExists(task.build.pid)) {
        await this.blockBuild(
          task.id,
          `Tracked build process PID ${task.build.pid} is no longer running. Project Pilot did not observe a terminal event before restart or status read.`
        );
      }
    }
  }

  private async reconcilePlan(planId: string): Promise<void> {
    const plan = await this.requirePlan(planId);
    if (plan.status === "plan-ready") {
      return;
    }

    const validation = await this.validatePlanReport(plan);
    if (validation.ok) {
      await this.updatePlan(plan.id, (existing) => ({
        ...existing,
        status: "plan-ready",
        error: undefined,
        endedAt: existing.endedAt ?? this.now(),
        exitCode: existing.exitCode ?? 0
      }));
      return;
    }

    if (plan.status === "plan-blocked") {
      if (plan.exitCode === 0 && !plan.error) {
        await this.blockPlan(plan.id, validation.reason);
      }
      return;
    }

    if (plan.status === "queued") {
      return;
    }

    if (plan.pid === undefined) {
      await this.blockPlan(plan.id, "Plan was marked active, but Project Pilot never persisted a child process ID.");
      return;
    }

    if (!this.processExists(plan.pid)) {
      const reason =
        plan.exitCode === 0
          ? validation.reason
          : `Tracked planning process PID ${plan.pid} is no longer running. Project Pilot did not observe a terminal event before restart or status read.`;
      await this.blockPlan(plan.id, reason);
    }
  }

  private async launchBuild(taskId: string, project: ProjectRecord, logPath: string): Promise<void> {
    let child: SpawnedCodexJob | undefined;
    let finalized = false;
    let timeout: NodeJS.Timeout | undefined;
    const reportPath = taskBuildReportFile(taskArtifactRoot(project), taskId);
    const runId = (await this.findRunForTask(taskId))?.id ?? null;
    const branch = this.branchForEvidence(project);
    await fs.mkdir(assertAllowedPath(taskReportsDir(taskArtifactRoot(project), taskId)), { recursive: true });

    const finalize = async (status: JobStatus, exitCode: number | null, error?: string) => {
      if (finalized) {
        return;
      }
      finalized = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      const taskStatus = buildTaskStatus(status);
      await this.updateTaskAndNotify(taskId, (task) => ({
        ...task,
        status: taskStatus,
        build: {
          ...task.build,
          status,
          exitCode,
          endedAt: this.now(),
          ...(error ? { error } : {})
        }
      }));
      try {
        await this.recordBuildVerification(taskId, project, status === "passed" ? "build-worker" : "failed-build");
      } catch (error) {
        if (!/Unknown taskId/.test(errorMessage(error))) {
          throw error;
        }
      }
    };

    try {
      child = this.spawnJob({
        projectRoot: taskArtifactRoot(project),
        sandbox: "danger-full-access",
        prompt: buildPrompt(taskId, {
          executionRoot: taskArtifactRoot(project),
          configuredCommands: projectVerificationCommands(project),
          reportPath,
          runId,
          branch,
          timestamp: this.now()
        }),
        logPath,
        onError: (error) => {
          void finalize("blocked", null, `Failed to spawn or run Codex build: ${error.message}`);
        },
        onExit: () => {
          // The close event is used for finalization after stdio has flushed.
        },
        onClose: (exitCode, signal) => {
          const status: JobStatus = exitCode === 0 ? "passed" : signal ? "stopped" : "failed";
          const error =
            status === "failed"
              ? `Codex build exited with code ${exitCode ?? "unknown"}.`
              : status === "stopped"
                ? `Codex build closed after signal ${signal}.`
                : undefined;
          void finalize(status, exitCode, error);
        }
      });
    } catch (error) {
      await finalize("blocked", null, `Failed to spawn Codex build: ${errorMessage(error)}`);
      return;
    }

    if (child.pid === undefined) {
      await finalize("blocked", null, "Codex build spawned without a child process ID.");
      return;
    }

    await this.updateTaskAndNotify(taskId, (task) => ({
      ...task,
      status: "building",
      build: {
        ...task.build,
        status: "running",
        pid: child!.pid,
        startedAt: task.build.startedAt ?? this.now()
      }
    }));

    timeout = this.startTimeout("build", taskId, child.pid, logPath, this.buildTimeoutMs, async (error) => {
      await finalize("blocked", null, error);
    });
  }

  private async launchReview(
    taskId: string,
    project: ProjectRecord,
    logPath: string,
    resolve: (value: Record<string, unknown>) => void
  ): Promise<void> {
    let child: SpawnedCodexJob | undefined;
    let finalized = false;
    let timeout: NodeJS.Timeout | undefined;
    const buildReportPath = taskBuildReportFile(taskArtifactRoot(project), taskId);
    const reviewReportPath = taskReviewReportFile(taskArtifactRoot(project), taskId);
    const runId = (await this.findRunForTask(taskId))?.id ?? null;
    const branch = this.branchForEvidence(project);
    await fs.mkdir(assertAllowedPath(taskReportsDir(taskArtifactRoot(project), taskId)), { recursive: true });

    const finalize = async (result: ReviewResult, exitCode: number | null, report: string | undefined, error?: string) => {
      if (finalized) {
        return;
      }
      finalized = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      const updated = await this.applyReviewResult(taskId, project, logPath, result, exitCode, report, error);
      resolve(updated);
    };

    try {
      child = this.spawnJob({
        projectRoot: taskArtifactRoot(project),
        sandbox: "danger-full-access",
        prompt: reviewPrompt(taskId, {
          executionRoot: taskArtifactRoot(project),
          buildReportPath,
          reviewReportPath,
          runId,
          branch,
          timestamp: this.now()
        }),
        logPath,
        onError: (error) => {
          void finalize("blocked", null, undefined, `Failed to spawn or run Codex review: ${error.message}`);
        },
        onExit: () => {
          // The close event is used for finalization after stdio has flushed.
        },
        onClose: (exitCode, signal, stdoutText) => {
          if (exitCode === 0) {
            const extracted = extractReviewReport(stdoutText, taskId);
            void finalize(extracted.result, exitCode, extracted.report);
            return;
          }
          const error = signal
            ? `Codex review closed after signal ${signal}.`
            : `Codex review exited with code ${exitCode ?? "unknown"}.`;
          void finalize("blocked", exitCode, undefined, error);
        }
      });
    } catch (error) {
      await finalize("blocked", null, undefined, `Failed to spawn Codex review: ${errorMessage(error)}`);
      return;
    }

    if (child.pid === undefined) {
      await finalize("blocked", null, undefined, "Codex review spawned without a child process ID.");
      return;
    }

    await this.updateTaskAndNotify(taskId, (existing) => ({
      ...existing,
      status: "reviewing",
      review: {
        ...existing.review!,
        status: "running",
        pid: child!.pid,
        startedAt: existing.review?.startedAt ?? this.now()
      }
    }));

    timeout = this.startTimeout("review", taskId, child.pid, logPath, this.reviewTimeoutMs, async (error) => {
      await finalize("blocked", null, undefined, error);
    });
  }

  private async launchPlan(planId: string, project: ProjectRecord, input: PlanInput, logPath: string): Promise<void> {
    let child: SpawnedCodexJob | undefined;
    let finalized = false;
    let timeout: NodeJS.Timeout | undefined;

    const finalize = async (exitCode: number | null, signal: NodeJS.Signals | null, stdoutText: string, error?: string) => {
      if (finalized) {
        return;
      }
      finalized = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      let finalStatus: PlanStatus = "plan-blocked";
      let finalError = error;
      if (!finalError && exitCode === 0) {
        const extracted = extractPlanReport(stdoutText, planId);
        if (extracted.report) {
          const plan = await this.requirePlan(planId);
          await fs.writeFile(assertAllowedPath(plan.reportPath), extracted.report, "utf8");
        }
        const validation = await this.validatePlanReport(await this.requirePlan(planId));
        if (validation.ok) {
          finalStatus = "plan-ready";
        } else {
          finalError = extracted.error ? `${extracted.error} ${validation.reason}` : validation.reason;
        }
      } else if (!finalError) {
        finalError = signal
          ? `Codex planning closed after signal ${signal}.`
          : `Codex planning exited with code ${exitCode ?? "unknown"}.`;
      }

      const tail = finalError ? await readLogTail(logPath, 20) : "";
      const savedError = finalError && tail ? `${finalError}\nLast log lines:\n${tail}` : finalError;
      await this.updatePlan(planId, (existing) => ({
        ...existing,
        status: finalStatus,
        exitCode,
        endedAt: this.now(),
        ...(savedError ? { error: savedError } : { error: undefined })
      }));
    };

    try {
      child = this.spawnJob({
        projectRoot: taskArtifactRoot(project),
        sandbox: "read-only",
        prompt: planPrompt(planId, input),
        logPath,
        onError: (error) => {
          void finalize(null, null, "", `Failed to spawn or run Codex planning: ${error.message}`);
        },
        onExit: () => {
          // The close event is used for finalization after stdio has flushed.
        },
        onClose: (exitCode, signal, stdoutText) => {
          void finalize(exitCode, signal, stdoutText);
        }
      });
    } catch (error) {
      await finalize(null, null, "", `Failed to spawn Codex planning: ${errorMessage(error)}`);
      return;
    }

    if (child.pid === undefined) {
      await finalize(null, null, "", "Codex planning spawned without a child process ID.");
      return;
    }

    await this.updatePlan(planId, (existing) => ({
      ...existing,
      status: finalized ? existing.status : "planning",
      pid: child!.pid,
      startedAt: existing.startedAt ?? this.now()
    }));

    timeout = this.startTimeout("plan", planId, child.pid, logPath, this.reviewTimeoutMs, async (error) => {
      await finalize(null, null, "", error);
    });
  }

  private startTimeout(
    kind: JobKind,
    taskId: string,
    pid: number,
    logPath: string,
    timeoutMs: number,
    onTimeout: (error: string) => Promise<void>
  ): NodeJS.Timeout {
    const timeout = setTimeout(() => {
      void (async () => {
        let killError: string | undefined;
        try {
          this.killProcess(pid);
        } catch (error) {
          killError = errorMessage(error);
        }
        const tail = await readLogTail(logPath, 20);
        const details = [
          `${kindTitle(kind)} timed out after ${Math.round(timeoutMs / 1000)} seconds. Terminated tracked ${kind} PID ${pid}.`,
          killError ? `Termination error: ${killError}` : "",
          tail ? `Last log lines:\n${tail}` : "No log output was captured before timeout."
        ].filter(Boolean);
        await onTimeout(details.join("\n"));
      })();
    }, timeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private async applyReviewResult(
    taskId: string,
    project: ProjectRecord,
    logPath: string,
    result: ReviewResult,
    exitCode: number | null,
    report: string | undefined,
    error?: string
  ): Promise<Record<string, unknown>> {
    if (report) {
      await fs.mkdir(assertAllowedPath(taskReportsDir(taskArtifactRoot(project), taskId)), { recursive: true });
      await fs.writeFile(assertAllowedPath(taskReviewReportFile(taskArtifactRoot(project), taskId)), report, "utf8");
    }

    const reviewStatus: JobStatus = result === "pass" ? "passed" : result === "needs-fixes" ? "failed" : "blocked";
    const taskStatus: TaskStatus =
      result === "pass" ? "ready-for-approval" : result === "needs-fixes" ? "needs-fixes" : "blocked";
    const task = await this.updateTaskAndNotify(taskId, (existing) => ({
      ...existing,
      status: taskStatus,
      review: {
        ...existing.review!,
        status: reviewStatus,
        result,
        logPath,
        exitCode,
        endedAt: this.now(),
        ...(error ? { error } : {})
      }
    }));

    if (taskStatus === "ready-for-approval") {
      await this.reconcileVerification(taskId);
      const decision = await this.evaluateTaskApproval(taskId);
      if (decision.eligible) {
        return await this.finalizeTask(taskId);
      }
    }

    return {
      taskId,
      reviewStatus: task.review?.status,
      taskStatus: deriveTaskStatus(task),
      result,
      reviewReport: report ?? null,
      error: task.review?.error,
      logTail: await readLogTail(logPath)
    };
  }

  private async blockReview(taskId: string, reason: string): Promise<void> {
    const task = await this.requireTask(taskId);
    const project = await this.projectForTask(task);
    const logPath = task.review?.logPath ?? this.workerLogPath(project, taskId, "review");
    const tail = await readLogTail(logPath, 20);
    const error = tail ? `${reason}\nLast log lines:\n${tail}` : reason;
    await this.updateTaskAndNotify(taskId, (existing) => ({
      ...existing,
      status: "blocked",
      review: {
        ...(existing.review ?? { logPath }),
        status: "blocked",
        result: "blocked",
        logPath,
        exitCode: existing.review?.exitCode ?? null,
        endedAt: this.now(),
        error
      }
    }));
  }

  private async blockBuild(taskId: string, reason: string): Promise<void> {
    const task = await this.requireTask(taskId);
    const tail = await readLogTail(task.build.logPath, 20);
    const error = tail ? `${reason}\nLast log lines:\n${tail}` : reason;
    await this.updateTaskAndNotify(taskId, (existing) => ({
      ...existing,
      status: "blocked",
      build: {
        ...existing.build,
        status: "blocked",
        exitCode: existing.build.exitCode ?? null,
        endedAt: this.now(),
        error
      }
    }));
  }

  private async blockPlan(planId: string, reason: string): Promise<void> {
    const plan = await this.requirePlan(planId);
    const tail = await readLogTail(plan.logPath, 20);
    const error = tail ? `${reason}\nLast log lines:\n${tail}` : reason;
    await this.updatePlan(planId, (existing) => ({
      ...existing,
      status: "plan-blocked",
      exitCode: existing.exitCode ?? null,
      endedAt: this.now(),
      error
    }));
  }

  private async readMatchingReviewResult(
    taskId: string,
    project: ProjectRecord
  ): Promise<{ result: ReviewResult; report: string } | undefined> {
    const task = await this.requireTask(taskId);
    const evidence = await this.readReviewEvidence(task, project);
    const report = evidence.report;
    if (!report || !evidence.trustedForPolicy) {
      return undefined;
    }
    const match = report.match(/Result:\s*(pass|needs-fixes|blocked)\b/i);
    if (!match) {
      return undefined;
    }
    return {
      result: match[1].toLowerCase() as ReviewResult,
      report
    };
  }

  private async assertNoActiveReview(taskId: string): Promise<void> {
    const task = await this.requireTask(taskId);
    if (task.review?.status === "running" || task.review?.status === "queued" || task.status === "reviewing") {
      if (task.review?.pid !== undefined && this.processExists(task.review.pid)) {
        throw new Error(`Task ${taskId} already has an active tracked review PID ${task.review.pid}.`);
      }
      await this.reconcileTask(taskId);
      const reconciled = await this.requireTask(taskId);
      if (isReviewActive(reconciled)) {
        throw new Error(`Task ${taskId} already has an active review.`);
      }
    }
  }

  private async assertRetryReviewAllowed(taskId: string): Promise<void> {
    const task = await this.requireTask(taskId);
    if (task.build.status !== "passed") {
      throw new Error(`Task ${taskId} cannot retry review because its build has not passed.`);
    }
    if (task.review?.pid !== undefined && this.processExists(task.review.pid)) {
      throw new Error(`Task ${taskId} already has an active tracked review PID ${task.review.pid}.`);
    }

    const reviewStatus = task.review?.status;
    const reviewResult = task.review?.result;
    const allowed =
      reviewResult === "blocked" ||
      reviewResult === "needs-fixes" ||
      reviewStatus === "blocked" ||
      reviewStatus === "failed" ||
      task.status === "needs-fixes" ||
      task.status === "blocked";

    if (!allowed) {
      throw new Error(`Task ${taskId} cannot retry review until the prior review is blocked, failed, or needs-fixes.`);
    }
  }

  private async requireTask(taskId: string): Promise<TaskRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown taskId: ${taskId}`);
    }
    return task;
  }

  private isUnknownTaskError(error: unknown, taskId: string): boolean {
    return errorMessage(error) === `Unknown taskId: ${taskId}`;
  }

  private async requirePlan(planId: string): Promise<PlanRecord> {
    const plan = await this.store.getPlan(planId);
    if (!plan) {
      throw new Error(`Unknown planId: ${planId}`);
    }
    return plan;
  }

  private async findRunForTask(taskId: string) {
    const runs = await this.store.listAutopilotRuns();
    return runs.find(
      (run) => run.currentTaskId === taskId || run.queue.some((item) => item.taskId === taskId || item.fixAttemptForTaskId === taskId)
    );
  }

  private async readBuildEvidence(
    task: TaskRecord,
    project: ProjectRecord
  ): Promise<{ report?: string; path: string; trustedForPolicy: boolean; diagnostic?: string }> {
    return await this.readTaskEvidence(task, project, "build");
  }

  private async readReviewEvidence(
    task: TaskRecord,
    project: ProjectRecord
  ): Promise<{ report?: string; path: string; trustedForPolicy: boolean; diagnostic?: string }> {
    return await this.readTaskEvidence(task, project, "review");
  }

  private async readTaskEvidence(
    task: TaskRecord,
    project: ProjectRecord,
    reportType: "build" | "review"
  ): Promise<{ report?: string; path: string; trustedForPolicy: boolean; diagnostic?: string }> {
    const root = taskArtifactRoot(project);
    const canonicalPath = reportType === "build" ? taskBuildReportFile(root, task.id) : taskReviewReportFile(root, task.id);
    const legacyPath = reportType === "build" ? buildReportFile(root) : reviewReportFile(root);
    const runId = (await this.findRunForTask(task.id))?.id ?? null;
    const branch = this.branchForEvidence(project);

    const canonicalReport = await readTextIfExists(canonicalPath);
    if (canonicalReport !== undefined) {
      const validation = this.validateTaskReportIdentity(canonicalReport, {
        reportType,
        task,
        project,
        runId,
        branch,
        reportPath: canonicalPath
      });
      return {
        report: canonicalReport,
        path: canonicalPath,
        trustedForPolicy: validation.ok,
        diagnostic: validation.ok ? undefined : validation.reason
      };
    }

    const legacyReport = await readTextIfExists(legacyPath);
    if (legacyReport !== undefined) {
      const validation = this.validateTaskReportIdentity(legacyReport, {
        reportType,
        task,
        project,
        runId,
        branch,
        reportPath: legacyPath
      });
      return {
        report: legacyReport,
        path: legacyPath,
        trustedForPolicy: validation.ok,
        diagnostic: validation.ok
          ? `Using legacy shared ${pathBasename(legacyPath)} because canonical task-scoped evidence is missing at ${canonicalPath}.`
          : `Rejected legacy shared ${pathBasename(legacyPath)}. ${validation.reason} Canonical task-scoped evidence belongs at ${canonicalPath}.`
      };
    }

    return {
      path: canonicalPath,
      trustedForPolicy: false,
      diagnostic: `No canonical ${pathBasename(canonicalPath)} found for task ${task.id}. Canonical task-scoped evidence belongs at ${canonicalPath}.`
    };
  }

  private validateTaskReportIdentity(
    report: string,
    options: {
      reportType: "build" | "review";
      task: TaskRecord;
      project: ProjectRecord;
      runId: string | null;
      branch: string;
      reportPath: string;
    }
  ): { ok: true } | { ok: false; reason: string } {
    const label = options.reportType === "build" ? "BUILD_REPORT.md" : "REVIEW_REPORT.md";
    const reportType = reportField(report, "Report Type");
    if (reportType !== options.reportType) {
      return { ok: false, reason: `${label} report type mismatch. Expected ${options.reportType}; found ${reportType ?? "none"}.` };
    }
    const taskId = reportField(report, "Task ID");
    if (taskId !== options.task.id) {
      const belongs = taskId ? ` This report belongs to ${taskId}, so it cannot verify this task.` : "";
      return { ok: false, reason: `${label} task identity mismatch. Expected ${options.task.id}; found ${taskId ?? "none"}.${belongs}` };
    }
    const runId = reportField(report, "Run ID");
    const expectedRunId = options.runId ?? "none";
    if ((runId ?? "none") !== expectedRunId) {
      return { ok: false, reason: `${label} run identity mismatch. Expected ${expectedRunId}; found ${runId ?? "none"}.` };
    }
    const executionRoot = reportField(report, "Execution Root");
    if (!executionRoot || !samePathText(executionRoot, taskArtifactRoot(options.project))) {
      return {
        ok: false,
        reason: `${label} execution root mismatch. Expected ${taskArtifactRoot(options.project)}; found ${executionRoot ?? "none"}.`
      };
    }
    const branch = reportField(report, "Branch");
    if (branch !== options.branch) {
      return { ok: false, reason: `${label} branch mismatch. Expected ${options.branch}; found ${branch ?? "none"}.` };
    }
    const timestamp = reportField(report, "Timestamp");
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
      return { ok: false, reason: `${label} timestamp is missing or invalid. Found ${timestamp ?? "none"}.` };
    }
    const reportPath = reportField(report, "Report Path");
    if (!reportPath || !samePathText(reportPath, options.reportPath)) {
      return { ok: false, reason: `${label} report path mismatch. Expected ${options.reportPath}; found ${reportPath ?? "none"}.` };
    }
    return { ok: true };
  }

  private branchForEvidence(project: ProjectRecord): string {
    const root = taskArtifactRoot(project);
    try {
      const branch = this.gitRunner?.(["branch", "--show-current"], root).trim();
      if (branch) {
        return branch;
      }
    } catch {
      // Fall back to configured metadata for report identity when Git is unavailable.
    }
    return project.maintenance?.expectedBranch || project.defaultBranchName || "unknown";
  }

  private async recordVerificationTimelineEvent(taskId: string, event: VerificationAuditEvent): Promise<void> {
    const run = await this.findRunForTask(taskId);
    if (!run) {
      return;
    }
    await this.store.updateAutopilotRun(run.id, (existing) => ({
      ...existing,
      timeline: [
        ...existing.timeline,
        {
          at: event.at,
          kind: "status",
          summary: `Task ${taskId} verification ${event.status}. ${event.explanation}`,
          data: {
            taskId,
            source: event.source,
            status: event.status,
            expectedCommands: event.expectedCommands,
            outputRef: event.outputRef
          }
        }
      ]
    }));
  }

  private async completeTask(taskId: string, message: string): Promise<{
    completedAt: string;
    task: TaskSummary;
    message: string;
  }> {
    const completedAt = this.now();
    const task = await this.updateTaskAndNotify(taskId, (existing) => completeReadyTask(existing, completedAt));
    return {
      completedAt,
      message,
      task: await this.toTaskSummary(task)
    };
  }

  private async evaluateTaskApproval(taskId: string) {
    const task = await this.reconcileVerification(taskId);
    const project = await this.projectForTask(task);
    const buildEvidence = await this.readBuildEvidence(task, project);
    const reviewEvidence = await this.readReviewEvidence(task, project);
    const buildReport = buildEvidence.trustedForPolicy ? buildEvidence.report : null;
    const reviewReport = reviewEvidence.trustedForPolicy ? reviewEvidence.report : null;
    return evaluateApprovalPolicy({
      task,
      buildReport,
      reviewReport,
      configuredCommands: projectVerificationCommands(project),
      verification: task.verification
    });
  }

  private async recordBuildVerification(
    taskId: string,
    project: ProjectRecord,
    source: "build-worker" | "failed-build"
  ): Promise<TaskRecord> {
    const task = await this.requireTask(taskId);
    const commands = projectVerificationCommands(project);
    if (commands.length === 0) {
      return task;
    }

    const evidence = await this.readBuildEvidence(task, project);
    const reportPath = evidence.path;
    const buildReport = evidence.report;
    const reportMtimeMs = await fileMtimeMs(reportPath);
    const recordedAt = this.now();
    const runId = (await this.findRunForTask(taskId))?.id ?? null;
    const strict =
      source === "build-worker"
        ? parseStrictBuildVerificationEvidence({
            buildReport,
            taskId,
            executionRoot: taskArtifactRoot(project),
            outputRef: reportPath,
            expectedOutputRef: reportPath,
            configuredCommands: commands,
            expectedRunId: runId,
            expectedBranch: this.branchForEvidence(project),
            startedAt: task.build.startedAt,
            endedAt: task.build.endedAt,
            recordedAt,
            reportMtimeMs,
            source: "build-worker"
          })
        : ({
            ok: false,
            reason: "Build did not pass, so configured command verification remains unknown.",
            records: unknownVerificationRecords(task, project, commands, reportPath, recordedAt, "build-worker")
          } as const);
    const records = strict.ok
      ? strict.records
      : strict.records.length > 0
        ? withEvidenceExplanation(strict.records, strict.reason)
        : unknownVerificationRecords(task, project, commands, reportPath, recordedAt, "build-worker", strict.reason);
    const event = verificationAuditEvent({
      taskId,
      project,
      commands,
      reportPath,
      at: recordedAt,
      kind: "verification-recorded",
      source: "build-worker",
      status: strict.ok ? "passed" : "unknown",
      explanation: strict.ok ? strict.explanation : strict.reason
    });
    const updated = await this.store.updateTask(taskId, (existing) => ({
      ...existing,
      verification: records,
      verificationEvents: [...(existing.verificationEvents ?? []), event]
    }));
    return updated;
  }

  private async reconcileVerification(taskId: string): Promise<TaskRecord> {
    const task = await this.requireTask(taskId);
    const project = await this.projectForTask(task);
    const commands = projectVerificationCommands(project);
    if (commands.length === 0 || hasCompleteCurrentVerification(task.verification, commands)) {
      return task;
    }

    const evidence = await this.readBuildEvidence(task, project);
    const reportPath = evidence.path;
    const buildReport = evidence.report;
    const reportMtimeMs = await fileMtimeMs(reportPath);
    const recordedAt = this.now();
    const runId = (await this.findRunForTask(taskId))?.id ?? null;
    const strict = parseStrictBuildVerificationEvidence({
      buildReport,
      taskId,
      executionRoot: taskArtifactRoot(project),
      outputRef: reportPath,
      expectedOutputRef: reportPath,
      configuredCommands: commands,
      expectedRunId: runId,
      expectedBranch: this.branchForEvidence(project),
      startedAt: task.build.startedAt,
      endedAt: task.build.endedAt,
      recordedAt,
      reportMtimeMs,
      source: "reconciled-from-evidence"
    });
    const existingCurrent = currentVerificationByCommand(task.verification ?? []);
    const records =
      strict.ok && (task.verification?.length ?? 0) === 0
        ? strict.records
        : mergeVerificationRecords(
            task.verification ?? [],
            strict.ok
              ? strict.records
              : withEvidenceExplanation(
                  strict.records.length > 0
                    ? strict.records
                    : unknownVerificationRecords(
                        task,
                        project,
                        commands.filter((command) => !existingCurrent.has(normalizeCommand(command))),
                        reportPath,
                        recordedAt,
                        "reconciled-from-evidence"
                      ),
                  strict.reason
                )
          );
    if (JSON.stringify(task.verification ?? []) === JSON.stringify(records)) {
      return task;
    }
    const event = verificationAuditEvent({
      taskId,
      project,
      commands,
      reportPath,
      at: recordedAt,
      kind: "verification-reconciled",
      source: "reconciled-from-evidence",
      status: strict.ok ? "reconciled-from-evidence" : "unknown",
      explanation: strict.ok ? strict.explanation : strict.reason
    });
    await this.recordVerificationTimelineEvent(taskId, event);

    return await this.store.updateTask(taskId, (existing) => ({
      ...existing,
      verification: records,
      verificationEvents: [...(existing.verificationEvents ?? []), event]
    }));
  }

  private async updatePlan(planId: string, updater: (plan: PlanRecord) => PlanRecord): Promise<PlanRecord> {
    return await this.store.updatePlan(planId, updater);
  }

  private async updateTaskAndNotify(taskId: string, updater: (task: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    const previous = await this.requireTask(taskId);
    const previousStatus = deriveTaskStatus(previous);
    const updated = await this.store.updateTask(taskId, updater);
    const summary = await this.toTaskSummary(updated);
    this.notifier.notifyTransition(previousStatus, summary);
    return updated;
  }

  private async toTaskSummary(task: TaskRecord): Promise<TaskSummary> {
    const latestLogPath = task.review?.logPath ?? task.build.logPath;
    const latestLogTail = await readLogTail(latestLogPath, 12);
    const project = await this.projectForTask(task);
    const buildEvidence = await this.readBuildEvidence(task, project);
    const reviewEvidence = await this.readReviewEvidence(task, project);
    return {
      title: task.title,
      projectId: project.id,
      projectName: project.name,
      taskId: task.id,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      status: deriveTaskStatus(task),
      codexAccessMode: CODEX_ACCESS_MODE,
      codexApprovalPolicy: CODEX_APPROVAL_POLICY,
      codexAccessWarning: CODEX_ACCESS_WARNING,
      approval: evaluateApprovalPolicy({
        task,
        buildReport: buildEvidence.trustedForPolicy ? buildEvidence.report : null,
        reviewReport: reviewEvidence.trustedForPolicy ? reviewEvidence.report : null,
        configuredCommands: projectVerificationCommands(project),
        verification: task.verification
      }),
      verificationStatus: verificationDisplayStatus(task, projectVerificationCommands(project)),
      verificationSummary: summarizeVerification(task, projectVerificationCommands(project)),
      buildSummary: summarizeBuild(task),
      reviewResult: task.review?.result ?? null,
      latestLogLines: latestLogTail ? latestLogTail.split(/\r?\n/) : []
    };
  }

  private async toPlanSummary(plan: PlanRecord): Promise<PlanSummary> {
    const project = await this.projects.getProject(plan.projectId);
    const latestLogTail = await readLogTail(plan.logPath, 12);
    const report = await readTextIfExists(plan.reportPath);
    return {
      planId: plan.id,
      projectId: project.id,
      projectName: project.name,
      title: plan.title,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      status: plan.status,
      summary: summarizePlanReport(report),
      reportPath: plan.reportPath,
      error: plan.error,
      latestLogLines: latestLogTail ? latestLogTail.split(/\r?\n/) : []
    };
  }

  private async validatePlanReport(plan: PlanRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
    const report = await readTextIfExists(plan.reportPath);
    return validatePlanReportContent(report, plan.id);
  }

  private async projectForTask(task: TaskRecord): Promise<ProjectRecord> {
    return task.projectId ? await this.projects.getProject(task.projectId) : await this.projects.getProject(DEFAULT_PROJECT_ID);
  }

  private async findDuplicateTask(projectId: string, input: TaskInput): Promise<TaskRecord | undefined> {
    const candidateKey = taskInputScopeKey(input);
    const tasks = await this.store.listTasks();
    return tasks.find(
      (task) =>
        (task.projectId ?? DEFAULT_PROJECT_ID) === projectId &&
        taskInputScopeKey(task) === candidateKey &&
        duplicateKeeperStatus(deriveTaskStatus(task))
    );
  }

  private workerLogPath(project: ProjectRecord, taskId: string, kind: "build" | "review"): string {
    const localLogPath = taskLocalLogPath(project, `${taskId}.${kind}.jsonl`);
    return localLogPath || buildLogPath(taskId, kind);
  }

  private planLogPath(project: ProjectRecord, planId: string): string {
    const localLogPath = taskLocalLogPath(project, `${planId}.plan.jsonl`);
    return localLogPath || buildPlanLogPath(planId);
  }
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function fileMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(assertAllowedPath(filePath))).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function hasCompleteCurrentVerification(records: VerificationRecord[] | undefined, commands: string[]): boolean {
  const current = currentVerificationByCommand(records ?? []);
  return commands.every((command) => {
    const record = current.get(normalizeCommand(command));
    return record && record.status !== "unknown";
  });
}

function currentVerificationByCommand(records: VerificationRecord[]): Map<string, VerificationRecord> {
  const current = new Map<string, VerificationRecord>();
  for (const record of records) {
    if (record.isCurrent) {
      current.set(normalizeCommand(record.command), record);
    }
  }
  return current;
}

function mergeVerificationRecords(existing: VerificationRecord[], candidate: VerificationRecord[]): VerificationRecord[] {
  const candidateByCommand = new Map(candidate.map((record) => [normalizeCommand(record.command), record]));
  const merged = existing.map((record) => {
    if (!record.isCurrent) {
      return record;
    }
    const next = candidateByCommand.get(normalizeCommand(record.command));
    if (!next || record.status !== "unknown") {
      return record;
    }
    candidateByCommand.delete(normalizeCommand(record.command));
    return next;
  });
  for (const record of candidateByCommand.values()) {
    if (!existing.some((item) => item.isCurrent && normalizeCommand(item.command) === normalizeCommand(record.command))) {
      merged.push(record);
    }
  }
  return merged;
}

function unknownVerificationRecords(
  task: TaskRecord,
  project: ProjectRecord,
  commands: string[],
  reportPath: string,
  recordedAt: string,
  source: "build-worker" | "reconciled-from-evidence",
  explanation = "Configured command verification is unknown."
): VerificationRecord[] {
  return commands.map((command) => ({
    command,
    attempt: 1,
    startedAt: task.build.startedAt,
    endedAt: task.build.endedAt,
    exitCode: null,
    status: "unknown",
    outputRef: reportPath,
    isCurrent: true,
    evidence: {
      source,
      taskId: task.id,
      executionRoot: taskArtifactRoot(project),
      expectedCommands: commands,
      outputRef: reportPath,
      recordedAt,
      explanation
    }
  }));
}

function withEvidenceExplanation(records: VerificationRecord[], explanation: string): VerificationRecord[] {
  return records.map((record) => ({
    ...record,
    evidence: record.evidence
      ? {
          ...record.evidence,
          explanation
        }
      : record.evidence
  }));
}

function verificationAuditEvent(input: {
  taskId: string;
  project: ProjectRecord;
  commands: string[];
  reportPath: string;
  at: string;
  kind: VerificationAuditEvent["kind"];
  source: VerificationAuditEvent["source"];
  status: VerificationDisplayStatus;
  explanation: string;
}): VerificationAuditEvent {
  return {
    at: input.at,
    kind: input.kind,
    source: input.source,
    status: input.status,
    taskId: input.taskId,
    executionRoot: taskArtifactRoot(input.project),
    expectedCommands: input.commands,
    outputRef: input.reportPath,
    explanation: input.explanation
  };
}

function verificationDisplayStatus(task: TaskRecord, commands: string[]): VerificationDisplayStatus {
  const current = currentVerificationByCommand(task.verification ?? []);
  const records = commands.map((command) => current.get(normalizeCommand(command)));
  if (commands.length === 0 || records.some((record) => !record || record.status === "unknown")) {
    return "unknown";
  }
  if (records.some((record) => record?.status === "failed")) {
    return "failed";
  }
  if (records.some((record) => record?.evidence?.source === "reconciled-from-evidence")) {
    return "reconciled-from-evidence";
  }
  return "passed";
}

function summarizeVerification(task: TaskRecord, commands: string[]): string {
  if (commands.length === 0) {
    return "No configured verification commands.";
  }
  const current = currentVerificationByCommand(task.verification ?? []);
  const lines = commands.map((command) => {
    const record = current.get(normalizeCommand(command));
    if (!record) {
      return `${command}: unknown (missing structured result)`;
    }
    const source = record.evidence?.source ? `, ${record.evidence.source}` : "";
    const explanation = record.status === "unknown" && record.evidence?.explanation ? ` - ${record.evidence.explanation}` : "";
    return `${command}: ${record.status}${source}${explanation}`;
  });
  return lines.join("\n");
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function isBuildActive(task: TaskRecord): boolean {
  return task.status === "building" || task.build.status === "running";
}

function isReviewActive(task: TaskRecord): boolean {
  return task.status === "reviewing" || task.review?.status === "queued" || task.review?.status === "running";
}

function activeJob(task: TaskRecord): { kind: JobKind; record: TaskRecord["build"] } | undefined {
  if (task.review && isReviewActive(task)) {
    return { kind: "review", record: task.review };
  }
  if (isBuildActive(task)) {
    return { kind: "build", record: task.build };
  }
  return undefined;
}

function buildTaskStatus(status: JobStatus): TaskStatus {
  if (status === "passed") {
    return "build-passed";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "stopped") {
    return "stopped";
  }
  if (status === "failed") {
    return "failed";
  }
  return "building";
}

function blockPreparedBuild(task: TaskRecord, reason: string, endedAt: string): TaskRecord {
  return {
    ...task,
    status: "blocked",
    updatedAt: endedAt,
    build: {
      ...task.build,
      status: "blocked",
      exitCode: null,
      endedAt,
      error: reason
    }
  };
}

function duplicateKeeperStatus(status: TaskStatus): boolean {
  return !["failed", "blocked", "stopped"].includes(status);
}

function taskInputScopeKey(input: Pick<TaskInput, "title" | "requirements" | "acceptanceCriteria">): string {
  return normalizeTaskScope(input.title);
}

function taskScopeKey(task: TaskRecord): string {
  return normalizeTaskScope(task.title);
}

function normalizeTaskScope(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function summarizeBuild(task: TaskRecord): string {
  if (task.build.error) {
    return task.build.error;
  }

  if (task.build.status === "queued") {
    return "Build is queued.";
  }

  if (task.build.status === "running") {
    return `Build is running${task.build.startedAt ? ` since ${task.build.startedAt}` : ""}.`;
  }

  if (task.build.status === "passed") {
    return `Build passed${task.build.endedAt ? ` at ${task.build.endedAt}` : ""}.`;
  }

  if (task.build.status === "failed") {
    const exit = task.build.exitCode === undefined ? "" : ` with exit code ${task.build.exitCode}`;
    return `Build failed${exit}.`;
  }

  if (task.build.status === "blocked") {
    return "Build blocked by Project Pilot infrastructure.";
  }

  return "Build stopped.";
}

function buildStatusHistory(task: TaskRecord): TaskStatusHistoryEntry[] {
  const entries: TaskStatusHistoryEntry[] = [
    {
      status: "queued",
      at: task.createdAt,
      source: "Task created"
    }
  ];

  if (task.build.startedAt) {
    entries.push({ status: "building", at: task.build.startedAt, source: "Build started" });
  }

  if (task.build.endedAt) {
    entries.push({
      status:
        task.build.status === "passed"
          ? "build-passed"
          : task.build.status === "failed"
            ? "failed"
            : task.build.status === "blocked"
              ? "blocked"
              : "stopped",
      at: task.build.endedAt,
      source: "Build finished"
    });
  }

  if (task.review?.startedAt) {
    entries.push({ status: "reviewing", at: task.review.startedAt, source: "Review started" });
  }

  if (task.review?.endedAt) {
    entries.push({
      status:
        task.review.result === "pass"
          ? "ready-for-approval"
          : task.review.result === "needs-fixes"
            ? "needs-fixes"
            : task.review.status === "stopped"
              ? "stopped"
              : "blocked",
      at: task.review.endedAt,
      source: "Review finished"
    });
  }

  if (deriveTaskStatus(task) === "completed") {
    entries.push({ status: "completed", at: task.completedAt ?? task.updatedAt, source: "Task approved" });
  }

  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

function collectErrors(task: TaskRecord): string[] {
  return [task.build.error, task.review?.error].filter((error): error is string => Boolean(error));
}

function assertManualApprovalAllowed(
  approval: Awaited<ReturnType<typeof evaluateApprovalPolicy>>,
  reviewedRiskEvidence: boolean
): void {
  const hardBlocks = approval.reasons.filter((reason) =>
    /Build status is not passed|Review result\/status is not pass|Configured command results are missing|Configured command results are unknown|Current configured command results are not passing|BUILD_REPORT\.md is missing|No configured test\/check\/lint\/build command evidence|Reviewer blocker|Task status is .*not ready-for-approval/i.test(
      reason
    )
  );
  if (hardBlocks.length > 0) {
    throw new Error(`Manual approval is not allowed until required build, verification, and review gates pass: ${hardBlocks.join(" ")}`);
  }
  if (approval.riskFlags.length > 0 && !reviewedRiskEvidence) {
    throw new Error(
      `Manual approval requires reviewedRiskEvidence=true because risk flags are present: ${approval.riskFlags.join(", ")}.`
    );
  }
}

function buildPlanStatusHistory(plan: PlanRecord): PlanStatusHistoryEntry[] {
  const entries: PlanStatusHistoryEntry[] = [
    {
      status: "queued",
      at: plan.createdAt,
      source: "Plan created"
    }
  ];

  if (plan.startedAt) {
    entries.push({ status: "planning", at: plan.startedAt, source: "Planning started" });
  }

  if (plan.endedAt) {
    entries.push({
      status: plan.status === "plan-ready" ? "plan-ready" : "plan-blocked",
      at: plan.endedAt,
      source: "Planning finished"
    });
  }

  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

function collectPlanErrors(plan: PlanRecord): string[] {
  return [plan.error].filter((error): error is string => Boolean(error));
}

function summarizePlanReport(report: string | undefined): string {
  const normalized = normalizePlanReportText(report);
  if (!normalized.trim()) {
    return "No plan report available.";
  }

  const summary = extractSection(normalized, "Summary Of The Request");
  const firstParagraph = summary
    .split(/\r?\n\r?\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .find(Boolean);

  if (!firstParagraph) {
    return "Plan report is available.";
  }

  return firstParagraph.length > 240 ? `${firstParagraph.slice(0, 237)}...` : firstParagraph;
}

function validatePlanReportContent(report: string | undefined, planId: string): { ok: true } | { ok: false; reason: string } {
  const normalized = normalizePlanReportText(report);
  if (!normalized.trim()) {
    return { ok: false, reason: "PLAN_REPORT.md is missing or empty." };
  }

  const reportPlanIds = extractPlanIds(normalized);
  if (!reportPlanIds.includes(planId)) {
    const found = reportPlanIds.length > 0 ? reportPlanIds.join(", ") : "none";
    return { ok: false, reason: `PLAN_REPORT.md Plan ID mismatch. Expected ${planId}; found ${found}.` };
  }

  const requiredSections = [
    "Summary Of The Request",
    "Recommended Architecture",
    "Implementation Phases",
    "Files Likely To Change",
    "Dependencies Or Services Needed",
    "Trade-offs And Alternatives",
    "Risks",
    "Test Strategy",
    "Questions/Blockers"
  ];

  for (const section of requiredSections) {
    const content = extractSection(normalized, section);
    if (!content) {
      return { ok: false, reason: `PLAN_REPORT.md is invalid: missing or empty section "${section}".` };
    }
    if (/^(?:unavailable|planning did not complete|n\/a|none)$/i.test(content.replace(/^[-*\s]+/gm, "").trim())) {
      return { ok: false, reason: `PLAN_REPORT.md is invalid: section "${section}" has placeholder content.` };
    }
  }

  return { ok: true };
}

function normalizePlanReportText(report: string | undefined): string {
  if (!report) {
    return "";
  }
  const actualHeadingCount = (report.match(/\r?\n##\s+/g) ?? []).length;
  const escapedHeadingCount = (report.match(/\\n##\s+/g) ?? []).length;
  if (escapedHeadingCount > actualHeadingCount) {
    return report.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  }
  return report;
}

function extractSection(report: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = report.match(new RegExp(`##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function extractPlanIds(report: string): string[] {
  const matches = [...report.matchAll(/\bPlan ID:\s*(plan-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8})\b/gi)];
  return [...new Set(matches.map((match) => match[1]))];
}

function kindTitle(kind: JobKind): string {
  return kind === "build" ? "Build" : kind === "review" ? "Review" : "Plan";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathBasename(filePath: string): string {
  return path.basename(filePath);
}

function reportField(report: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const values = [...report.matchAll(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, "gim"))].map((match) => match[1].trim());
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function samePathText(left: string, right: string): boolean {
  return left.trim().replace(/[\\/]+/g, "/").toLowerCase() === right.trim().replace(/[\\/]+/g, "/").toLowerCase();
}

function planTaskRequirements(plan: PlanRecord, report: string): string {
  return [
    `Implement the approved plan ${plan.id}.`,
    "",
    "Original requirements:",
    plan.requirements,
    "",
    "Constraints:",
    plan.constraints,
    "",
    "Approved plan report:",
    report || "PLAN_REPORT.md was not available when the task was created."
  ].join("\n");
}
