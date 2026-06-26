import fs from "node:fs/promises";
import { buildReportFile, planReportFile, reviewReportFile, taskFile, assertAllowedPath } from "./paths.js";
import { CODEX_ACCESS_MODE, CODEX_ACCESS_WARNING, CODEX_APPROVAL_POLICY, assertPlanId, buildLogPath, buildPlanLogPath, createPlanId, createTaskId, spawnCodexJob, assertTaskId } from "./codex.js";
import { readLogTail, readTextIfExists, extractPlanReport, extractReviewReport } from "./logs.js";
import { buildPrompt, planPrompt, renderTaskMarkdown, reviewPrompt } from "./prompts.js";
import { StateStore } from "./state.js";
import { preflightWorkerLaunch, taskArtifactRoot, taskLocalLogPath } from "./execution.js";
import { completeReadyTask, deriveTaskStatus } from "./task-status.js";
import { WindowsTaskNotifier } from "./notifications.js";
import { evaluateApprovalPolicy, parseVerificationRecords, projectVerificationCommands } from "./approval-policy.js";
import { DEFAULT_PROJECT_ID, ProjectRegistry } from "./projects.js";
const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_REVIEW_TIMEOUT_MS = 8 * 60 * 1000;
export class JobService {
    store;
    projects;
    notifier;
    spawnJob;
    processExists;
    killProcess;
    buildTimeoutMs;
    reviewTimeoutMs;
    now;
    gitRunner;
    constructor(store = new StateStore(), notifier = new WindowsTaskNotifier(), options = {}) {
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
    async startBuild(input) {
        const prepared = await this.prepareBuild(input);
        if (prepared.duplicate) {
            return { taskId: prepared.task.id, status: deriveTaskStatus(prepared.task) };
        }
        const preflight = this.preflightWorkerLaunch(prepared.project);
        if (!preflight.ok) {
            await this.store.addTask(blockPreparedBuild(prepared.task, preflight.reason ?? "Maintenance Git preflight failed.", this.now()));
            return { taskId: prepared.task.id, status: "blocked" };
        }
        await fs.writeFile(assertAllowedPath(taskFile(taskArtifactRoot(prepared.project))), renderTaskMarkdown(prepared.task.id, prepared.input), "utf8");
        await this.store.addTask(prepared.task);
        this.launchPreparedBuild(prepared);
        return { taskId: prepared.task.id, status: "queued" };
    }
    async prepareBuild(input) {
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
        const task = {
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
    async launchPreparedBuild(prepared) {
        if (prepared.duplicate) {
            return;
        }
        const preflight = this.preflightWorkerLaunch(prepared.project);
        if (!preflight.ok) {
            await this.blockBuild(prepared.task.id, preflight.reason ?? "Maintenance Git preflight failed.");
            return;
        }
        await fs.writeFile(assertAllowedPath(taskFile(taskArtifactRoot(prepared.project))), renderTaskMarkdown(prepared.task.id, prepared.input), "utf8");
        setImmediate(() => {
            void this.launchBuild(prepared.task.id, prepared.project, prepared.logPath);
        });
    }
    async listProjects() {
        return await this.projects.listProjects();
    }
    async getProject(projectId) {
        return await this.projects.getProject(projectId);
    }
    async registerProject(input) {
        return await this.projects.registerProject(input);
    }
    async setActiveProject(projectId) {
        return await this.projects.setActiveProject(projectId);
    }
    async getActiveProject() {
        return await this.projects.getActiveProject();
    }
    preflightWorkerLaunch(project) {
        return preflightWorkerLaunch(project, this.gitRunner);
    }
    async getBuildStatus(taskId) {
        assertTaskId(taskId);
        await this.reconcileTask(taskId);
        const task = await this.requireTask(taskId);
        const project = await this.projectForTask(task);
        const buildReport = await readTextIfExists(buildReportFile(taskArtifactRoot(project)));
        return {
            taskId,
            status: task.build.status,
            taskStatus: deriveTaskStatus(task),
            startedAt: task.build.startedAt,
            endedAt: task.build.endedAt,
            exitCode: task.build.exitCode,
            error: task.build.error,
            logTail: await readLogTail(task.build.logPath),
            buildReport: buildReport ?? null
        };
    }
    async listTasks() {
        await this.reconcileUnfinishedTasks();
        const tasks = await this.store.listTasks();
        return {
            tasks: await Promise.all(tasks.map((task) => this.toTaskSummary(task)))
        };
    }
    async approveTask(input) {
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
    async declineTaskApproval(input) {
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
    async finalizeTask(taskId) {
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
    async getTaskDetails(taskId) {
        assertTaskId(taskId);
        await this.reconcileTaskForAutopilot(taskId, false);
        const task = await this.requireTask(taskId);
        const project = await this.projectForTask(task);
        const approval = await this.evaluateTaskApproval(taskId);
        return {
            ...(await this.toTaskSummary(task)),
            requirements: task.requirements,
            acceptanceCriteria: task.acceptanceCriteria,
            statusHistory: buildStatusHistory(task),
            errors: collectErrors(task),
            buildLog: (await readTextIfExists(task.build.logPath)) ?? "",
            reviewLog: task.review?.logPath ? (await readTextIfExists(task.review.logPath)) ?? "" : "",
            buildReport: (await readTextIfExists(buildReportFile(taskArtifactRoot(project)))) ?? null,
            reviewReport: (await readTextIfExists(reviewReportFile(taskArtifactRoot(project)))) ?? null,
            approvalActions: task.approvalActions ?? [],
            approval
        };
    }
    async runReview(taskId) {
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
    async retryReview(taskId) {
        assertTaskId(taskId);
        await this.reconcileTask(taskId);
        await this.assertRetryReviewAllowed(taskId);
        return await this.runReview(taskId);
    }
    async startPlan(input) {
        const project = await this.projects.getProject(input.projectId);
        const planId = createPlanId();
        const now = this.now();
        const logPath = this.planLogPath(project, planId);
        const preflight = this.preflightWorkerLaunch(project);
        const plan = {
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
    async listPlans() {
        await this.reconcileUnfinishedTasks();
        const plans = await this.store.listPlans();
        return {
            plans: await Promise.all(plans.map((plan) => this.toPlanSummary(plan)))
        };
    }
    async getPlanStatus(planId) {
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
    async getPlanDetails(planId) {
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
    async createTaskFromPlan(input) {
        assertPlanId(input.planId);
        await this.reconcilePlan(input.planId);
        const plan = await this.requirePlan(input.planId);
        if (plan.status !== "plan-ready") {
            throw new Error(`Plan ${input.planId} is ${plan.status}, not plan-ready.`);
        }
        const project = await this.projects.getProject(plan.projectId);
        const taskId = createTaskId();
        const report = (await readTextIfExists(plan.reportPath)) ?? "";
        const taskInput = {
            projectId: project.id,
            title: input.title?.trim() || plan.title,
            requirements: input.requirements?.trim() || planTaskRequirements(plan, report),
            acceptanceCriteria: input.acceptanceCriteria && input.acceptanceCriteria.length > 0
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
        const task = {
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
    async stopTask(taskId) {
        assertTaskId(taskId);
        await this.reconcileTask(taskId);
        const task = await this.requireTask(taskId);
        const active = activeJob(task);
        if (!active || active.record.pid === undefined || !this.processExists(active.record.pid)) {
            throw new Error(`Task ${taskId} has no tracked active build or review process.`);
        }
        try {
            this.killProcess(active.record.pid);
        }
        catch (error) {
            throw new Error(`Failed to stop tracked ${active.kind} process ${active.record.pid}: ${errorMessage(error)}`);
        }
        const stopped = await this.updateTaskAndNotify(taskId, (existing) => active.kind === "review"
            ? {
                ...existing,
                status: "stopped",
                review: {
                    ...existing.review,
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
            });
        return {
            taskId,
            stopped: active.kind,
            pid: active.record.pid,
            taskStatus: deriveTaskStatus(stopped),
            logTail: await readLogTail(active.record.logPath)
        };
    }
    async reconcileUnfinishedTasks() {
        const tasks = await this.store.listTasks();
        for (const task of tasks) {
            await this.reconcileTask(task.id);
            await this.reconcileVerification(task.id);
        }
        const plans = await this.store.listPlans();
        for (const plan of plans) {
            await this.reconcilePlan(plan.id);
        }
    }
    async reconcileTaskForAutopilot(taskId, allowFinalize = true) {
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
    async cancelDuplicateQueuedTasks(projectId) {
        const tasks = await this.store.listTasks();
        const cancelled = [];
        for (const task of tasks) {
            if (projectId && (task.projectId ?? DEFAULT_PROJECT_ID) !== projectId) {
                continue;
            }
            if (deriveTaskStatus(task) !== "queued" || task.build.status !== "queued") {
                continue;
            }
            const duplicate = tasks.find((candidate) => candidate.id !== task.id &&
                (candidate.projectId ?? DEFAULT_PROJECT_ID) === (task.projectId ?? DEFAULT_PROJECT_ID) &&
                taskScopeKey(candidate) === taskScopeKey(task) &&
                duplicateKeeperStatus(deriveTaskStatus(candidate)));
            if (!duplicate) {
                continue;
            }
            cancelled.push(await this.cancelDuplicateQueuedTask(task.id, `Duplicate of ${duplicate.id}.`));
        }
        return cancelled;
    }
    async cancelDuplicateQueuedTask(taskId, reason = "Duplicate queued task.") {
        assertTaskId(taskId);
        const tasks = await this.store.listTasks();
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task) {
            throw new Error(`Unknown taskId: ${taskId}`);
        }
        if (deriveTaskStatus(task) !== "queued" || task.build.status !== "queued") {
            throw new Error(`Task ${taskId} is not a queued task and cannot be skipped as a duplicate.`);
        }
        const duplicate = tasks.find((candidate) => candidate.id !== task.id &&
            (candidate.projectId ?? DEFAULT_PROJECT_ID) === (task.projectId ?? DEFAULT_PROJECT_ID) &&
            taskScopeKey(candidate) === taskScopeKey(task) &&
            duplicateKeeperStatus(deriveTaskStatus(candidate)));
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
    async reconcileTask(taskId) {
        const task = await this.requireTask(taskId);
        const project = await this.projectForTask(task);
        if (isReviewActive(task)) {
            const reviewResult = await this.readMatchingReviewResult(task.id, project);
            if (reviewResult) {
                await this.applyReviewResult(task.id, project, task.review.logPath, reviewResult.result, null, reviewResult.report, "Reconciled from REVIEW_REPORT.md.");
                return;
            }
            if (task.review?.pid === undefined) {
                await this.blockReview(task.id, "Review was marked active, but Project Pilot never persisted a child process ID. The review process was not successfully tracked.");
                return;
            }
            if (!this.processExists(task.review.pid)) {
                await this.blockReview(task.id, `Tracked review process PID ${task.review.pid} is no longer running. Project Pilot did not observe a terminal event before restart or status read.`);
            }
            return;
        }
        if (isBuildActive(task)) {
            if (task.build.pid === undefined) {
                await this.blockBuild(task.id, "Build was marked active, but Project Pilot never persisted a child process ID. The build process was not successfully tracked.");
                return;
            }
            if (!this.processExists(task.build.pid)) {
                await this.blockBuild(task.id, `Tracked build process PID ${task.build.pid} is no longer running. Project Pilot did not observe a terminal event before restart or status read.`);
            }
        }
    }
    async reconcilePlan(planId) {
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
            const reason = plan.exitCode === 0
                ? validation.reason
                : `Tracked planning process PID ${plan.pid} is no longer running. Project Pilot did not observe a terminal event before restart or status read.`;
            await this.blockPlan(plan.id, reason);
        }
    }
    async launchBuild(taskId, project, logPath) {
        let child;
        let finalized = false;
        let timeout;
        const finalize = async (status, exitCode, error) => {
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
        };
        try {
            child = this.spawnJob({
                projectRoot: taskArtifactRoot(project),
                sandbox: "danger-full-access",
                prompt: buildPrompt(taskId),
                logPath,
                onError: (error) => {
                    void finalize("blocked", null, `Failed to spawn or run Codex build: ${error.message}`);
                },
                onExit: () => {
                    // The close event is used for finalization after stdio has flushed.
                },
                onClose: (exitCode, signal) => {
                    const status = exitCode === 0 ? "passed" : signal ? "stopped" : "failed";
                    const error = status === "failed"
                        ? `Codex build exited with code ${exitCode ?? "unknown"}.`
                        : status === "stopped"
                            ? `Codex build closed after signal ${signal}.`
                            : undefined;
                    void finalize(status, exitCode, error);
                }
            });
        }
        catch (error) {
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
                pid: child.pid,
                startedAt: task.build.startedAt ?? this.now()
            }
        }));
        timeout = this.startTimeout("build", taskId, child.pid, logPath, this.buildTimeoutMs, async (error) => {
            await finalize("blocked", null, error);
        });
    }
    async launchReview(taskId, project, logPath, resolve) {
        let child;
        let finalized = false;
        let timeout;
        const finalize = async (result, exitCode, report, error) => {
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
                prompt: reviewPrompt(taskId),
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
        }
        catch (error) {
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
                ...existing.review,
                status: "running",
                pid: child.pid,
                startedAt: existing.review?.startedAt ?? this.now()
            }
        }));
        timeout = this.startTimeout("review", taskId, child.pid, logPath, this.reviewTimeoutMs, async (error) => {
            await finalize("blocked", null, undefined, error);
        });
    }
    async launchPlan(planId, project, input, logPath) {
        let child;
        let finalized = false;
        let timeout;
        const finalize = async (exitCode, signal, stdoutText, error) => {
            if (finalized) {
                return;
            }
            finalized = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            let finalStatus = "plan-blocked";
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
                }
                else {
                    finalError = extracted.error ? `${extracted.error} ${validation.reason}` : validation.reason;
                }
            }
            else if (!finalError) {
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
        }
        catch (error) {
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
            pid: child.pid,
            startedAt: existing.startedAt ?? this.now()
        }));
        timeout = this.startTimeout("plan", planId, child.pid, logPath, this.reviewTimeoutMs, async (error) => {
            await finalize(null, null, "", error);
        });
    }
    startTimeout(kind, taskId, pid, logPath, timeoutMs, onTimeout) {
        const timeout = setTimeout(() => {
            void (async () => {
                let killError;
                try {
                    this.killProcess(pid);
                }
                catch (error) {
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
    async applyReviewResult(taskId, project, logPath, result, exitCode, report, error) {
        if (report) {
            await fs.writeFile(assertAllowedPath(reviewReportFile(taskArtifactRoot(project))), report, "utf8");
        }
        const reviewStatus = result === "pass" ? "passed" : result === "needs-fixes" ? "failed" : "blocked";
        const taskStatus = result === "pass" ? "ready-for-approval" : result === "needs-fixes" ? "needs-fixes" : "blocked";
        const task = await this.updateTaskAndNotify(taskId, (existing) => ({
            ...existing,
            status: taskStatus,
            review: {
                ...existing.review,
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
    async blockReview(taskId, reason) {
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
    async blockBuild(taskId, reason) {
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
    async blockPlan(planId, reason) {
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
    async readMatchingReviewResult(taskId, project) {
        const report = await readTextIfExists(reviewReportFile(taskArtifactRoot(project)));
        if (!report || !report.includes(`Task ID: ${taskId}`)) {
            return undefined;
        }
        const match = report.match(/Result:\s*(pass|needs-fixes|blocked)\b/i);
        if (!match) {
            return undefined;
        }
        return {
            result: match[1].toLowerCase(),
            report
        };
    }
    async assertNoActiveReview(taskId) {
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
    async assertRetryReviewAllowed(taskId) {
        const task = await this.requireTask(taskId);
        if (task.build.status !== "passed") {
            throw new Error(`Task ${taskId} cannot retry review because its build has not passed.`);
        }
        if (task.review?.pid !== undefined && this.processExists(task.review.pid)) {
            throw new Error(`Task ${taskId} already has an active tracked review PID ${task.review.pid}.`);
        }
        const reviewStatus = task.review?.status;
        const reviewResult = task.review?.result;
        const allowed = reviewResult === "blocked" ||
            reviewResult === "needs-fixes" ||
            reviewStatus === "blocked" ||
            reviewStatus === "failed" ||
            task.status === "needs-fixes" ||
            task.status === "blocked";
        if (!allowed) {
            throw new Error(`Task ${taskId} cannot retry review until the prior review is blocked, failed, or needs-fixes.`);
        }
    }
    async requireTask(taskId) {
        const task = await this.store.getTask(taskId);
        if (!task) {
            throw new Error(`Unknown taskId: ${taskId}`);
        }
        return task;
    }
    async requirePlan(planId) {
        const plan = await this.store.getPlan(planId);
        if (!plan) {
            throw new Error(`Unknown planId: ${planId}`);
        }
        return plan;
    }
    async findRunForTask(taskId) {
        const runs = await this.store.listAutopilotRuns();
        return runs.find((run) => run.currentTaskId === taskId || run.queue.some((item) => item.taskId === taskId || item.fixAttemptForTaskId === taskId));
    }
    async completeTask(taskId, message) {
        const completedAt = this.now();
        const task = await this.updateTaskAndNotify(taskId, (existing) => completeReadyTask(existing, completedAt));
        return {
            completedAt,
            message,
            task: await this.toTaskSummary(task)
        };
    }
    async evaluateTaskApproval(taskId) {
        const task = await this.reconcileVerification(taskId);
        const project = await this.projectForTask(task);
        const buildReport = await readTextIfExists(buildReportFile(taskArtifactRoot(project)));
        const reviewReport = await readTextIfExists(reviewReportFile(taskArtifactRoot(project)));
        return evaluateApprovalPolicy({
            task,
            buildReport,
            reviewReport,
            configuredCommands: projectVerificationCommands(project),
            verification: task.verification
        });
    }
    async reconcileVerification(taskId) {
        const task = await this.requireTask(taskId);
        const project = await this.projectForTask(task);
        const buildReport = await readTextIfExists(buildReportFile(taskArtifactRoot(project)));
        const verification = parseVerificationRecords({
            buildReport,
            configuredCommands: projectVerificationCommands(project),
            startedAt: task.build.startedAt,
            endedAt: task.build.endedAt,
            outputRef: buildReportFile(taskArtifactRoot(project))
        });
        if (verification.length === 0 && (!task.verification || task.verification.length === 0)) {
            return task;
        }
        if (JSON.stringify(task.verification ?? []) === JSON.stringify(verification)) {
            return task;
        }
        return await this.store.updateTask(taskId, (existing) => ({
            ...existing,
            verification
        }));
    }
    async updatePlan(planId, updater) {
        return await this.store.updatePlan(planId, updater);
    }
    async updateTaskAndNotify(taskId, updater) {
        const previous = await this.requireTask(taskId);
        const previousStatus = deriveTaskStatus(previous);
        const updated = await this.store.updateTask(taskId, updater);
        const summary = await this.toTaskSummary(updated);
        this.notifier.notifyTransition(previousStatus, summary);
        return updated;
    }
    async toTaskSummary(task) {
        const latestLogPath = task.review?.logPath ?? task.build.logPath;
        const latestLogTail = await readLogTail(latestLogPath, 12);
        const project = await this.projectForTask(task);
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
                buildReport: await readTextIfExists(buildReportFile(taskArtifactRoot(project))),
                reviewReport: await readTextIfExists(reviewReportFile(taskArtifactRoot(project))),
                configuredCommands: projectVerificationCommands(project),
                verification: task.verification
            }),
            buildSummary: summarizeBuild(task),
            reviewResult: task.review?.result ?? null,
            latestLogLines: latestLogTail ? latestLogTail.split(/\r?\n/) : []
        };
    }
    async toPlanSummary(plan) {
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
    async validatePlanReport(plan) {
        const report = await readTextIfExists(plan.reportPath);
        return validatePlanReportContent(report, plan.id);
    }
    async projectForTask(task) {
        return task.projectId ? await this.projects.getProject(task.projectId) : await this.projects.getProject(DEFAULT_PROJECT_ID);
    }
    async findDuplicateTask(projectId, input) {
        const candidateKey = taskInputScopeKey(input);
        const tasks = await this.store.listTasks();
        return tasks.find((task) => (task.projectId ?? DEFAULT_PROJECT_ID) === projectId &&
            taskInputScopeKey(task) === candidateKey &&
            duplicateKeeperStatus(deriveTaskStatus(task)));
    }
    workerLogPath(project, taskId, kind) {
        const localLogPath = taskLocalLogPath(project, `${taskId}.${kind}.jsonl`);
        return localLogPath || buildLogPath(taskId, kind);
    }
    planLogPath(project, planId) {
        const localLogPath = taskLocalLogPath(project, `${planId}.plan.jsonl`);
        return localLogPath || buildPlanLogPath(planId);
    }
}
function defaultProcessExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error.code;
        return code === "EPERM";
    }
}
function isBuildActive(task) {
    return task.status === "building" || task.build.status === "running";
}
function isReviewActive(task) {
    return task.status === "reviewing" || task.review?.status === "queued" || task.review?.status === "running";
}
function activeJob(task) {
    if (task.review && isReviewActive(task)) {
        return { kind: "review", record: task.review };
    }
    if (isBuildActive(task)) {
        return { kind: "build", record: task.build };
    }
    return undefined;
}
function buildTaskStatus(status) {
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
function blockPreparedBuild(task, reason, endedAt) {
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
function duplicateKeeperStatus(status) {
    return !["failed", "blocked", "stopped"].includes(status);
}
function taskInputScopeKey(input) {
    return normalizeTaskScope(input.title);
}
function taskScopeKey(task) {
    return normalizeTaskScope(task.title);
}
function normalizeTaskScope(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function summarizeBuild(task) {
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
function buildStatusHistory(task) {
    const entries = [
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
            status: task.build.status === "passed"
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
            status: task.review.result === "pass"
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
function collectErrors(task) {
    return [task.build.error, task.review?.error].filter((error) => Boolean(error));
}
function assertManualApprovalAllowed(approval, reviewedRiskEvidence) {
    const hardBlocks = approval.reasons.filter((reason) => /Build status is not passed|Review result\/status is not pass|Configured command results are missing|Current configured command results are not passing|BUILD_REPORT\.md is missing|No configured test\/check\/lint\/build command evidence|Reviewer blocker|Task status is .*not ready-for-approval/i.test(reason));
    if (hardBlocks.length > 0) {
        throw new Error(`Manual approval is not allowed until required build, verification, and review gates pass: ${hardBlocks.join(" ")}`);
    }
    if (approval.riskFlags.length > 0 && !reviewedRiskEvidence) {
        throw new Error(`Manual approval requires reviewedRiskEvidence=true because risk flags are present: ${approval.riskFlags.join(", ")}.`);
    }
}
function buildPlanStatusHistory(plan) {
    const entries = [
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
function collectPlanErrors(plan) {
    return [plan.error].filter((error) => Boolean(error));
}
function summarizePlanReport(report) {
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
function validatePlanReportContent(report, planId) {
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
function normalizePlanReportText(report) {
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
function extractSection(report, heading) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = report.match(new RegExp(`##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "i"));
    return match?.[1]?.trim() ?? "";
}
function extractPlanIds(report) {
    const matches = [...report.matchAll(/\bPlan ID:\s*(plan-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8})\b/gi)];
    return [...new Set(matches.map((match) => match[1]))];
}
function kindTitle(kind) {
    return kind === "build" ? "Build" : kind === "review" ? "Review" : "Plan";
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function planTaskRequirements(plan, report) {
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
