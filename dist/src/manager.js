import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { evaluateApprovalPolicy } from "./approval-policy.js";
import { buildReportFile, reviewReportFile } from "./paths.js";
import { maintenanceStatus, taskArtifactRoot } from "./execution.js";
import { ProjectRegistry } from "./projects.js";
import { StateStore } from "./state.js";
import { deriveTaskStatus } from "./task-status.js";
import { MANAGER_DECISION_ACTIONS } from "./types.js";
const DEFAULT_MANAGER_MODEL = "gpt-5";
const DEFAULT_MAX_MANAGER_DECISIONS = 12;
const DEFAULT_MAX_TASKS = 8;
const DEFAULT_MAX_FIX_ATTEMPTS = 1;
const DEFAULT_MAX_RUNTIME_MS = 8 * 60 * 60 * 1000;
const SCHEDULER_HEARTBEAT_MS = 5_000;
const MAX_RECOVERY_ATTEMPTS_PER_TASK = 1;
const taskDecisionSchema = z.object({
    title: z.string().trim().min(1).max(160),
    requirements: z.string().trim().min(1).max(20_000),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(25)
});
const fixTaskDecisionSchema = taskDecisionSchema.extend({
    fixAttemptForTaskId: z.string().trim().min(1).max(80)
});
const decisionSchema = z
    .object({
    action: z.enum(MANAGER_DECISION_ACTIONS),
    summary: z.string().trim().min(1).max(2_000),
    reason: z.string().trim().max(2_000).nullable(),
    taskId: z.string().trim().min(1).max(80).nullable(),
    tasks: z.array(taskDecisionSchema).max(20).nullable(),
    fixTask: fixTaskDecisionSchema.nullable()
})
    .strict()
    .superRefine((decision, context) => {
    if (decision.action === "create_ordered_tasks" && (!decision.tasks || decision.tasks.length === 0)) {
        context.addIssue({ code: "custom", path: ["tasks"], message: "create_ordered_tasks requires a non-empty tasks array." });
    }
    if (decision.action === "request_one_fix_attempt" && !decision.fixTask) {
        context.addIssue({ code: "custom", path: ["fixTask"], message: "request_one_fix_attempt requires fixTask." });
    }
    if ((decision.action === "finalize_current_task" || decision.action === "skip_duplicate_task") && !decision.taskId) {
        context.addIssue({ code: "custom", path: ["taskId"], message: `${decision.action} requires taskId.` });
    }
    if (decision.action === "skip_duplicate_task" && !decision.reason) {
        context.addIssue({ code: "custom", path: ["reason"], message: "skip_duplicate_task requires an audited reason." });
    }
});
const MANAGER_DECISION_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["action", "summary", "reason", "taskId", "tasks", "fixTask"],
    properties: {
        action: {
            type: "string",
            enum: MANAGER_DECISION_ACTIONS
        },
        summary: { type: "string", minLength: 1, maxLength: 2000 },
        reason: { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] },
        taskId: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
        tasks: {
            anyOf: [
                {
                    type: "array",
                    maxItems: 20,
                    items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["title", "requirements", "acceptanceCriteria"],
                        properties: {
                            title: { type: "string", minLength: 1, maxLength: 160 },
                            requirements: { type: "string", minLength: 1, maxLength: 20000 },
                            acceptanceCriteria: {
                                type: "array",
                                minItems: 1,
                                maxItems: 25,
                                items: { type: "string", minLength: 1, maxLength: 2000 }
                            }
                        }
                    }
                },
                { type: "null" }
            ]
        },
        fixTask: {
            anyOf: [
                {
                    type: "object",
                    additionalProperties: false,
                    required: ["title", "requirements", "acceptanceCriteria", "fixAttemptForTaskId"],
                    properties: {
                        title: { type: "string", minLength: 1, maxLength: 160 },
                        requirements: { type: "string", minLength: 1, maxLength: 20000 },
                        acceptanceCriteria: {
                            type: "array",
                            minItems: 1,
                            maxItems: 25,
                            items: { type: "string", minLength: 1, maxLength: 2000 }
                        },
                        fixAttemptForTaskId: { type: "string", minLength: 1, maxLength: 80 }
                    }
                },
                { type: "null" }
            ]
        }
    }
};
export class NullAutopilotNotifier {
    notify() {
        // Tests and non-Windows environments can opt out.
    }
}
export function managerModeConfig(env = process.env) {
    return {
        configured: Boolean(env.OPENAI_API_KEY?.trim()),
        managerModel: env.PROJECT_PILOT_MANAGER_MODEL?.trim() || env.OPENAI_MANAGER_MODEL?.trim() || DEFAULT_MANAGER_MODEL,
        maxManagerDecisionsPerRun: positiveInt(env.PROJECT_PILOT_MANAGER_MAX_DECISIONS_PER_RUN, DEFAULT_MAX_MANAGER_DECISIONS),
        maxTasksPerRun: positiveInt(env.PROJECT_PILOT_MANAGER_MAX_TASKS_PER_RUN, DEFAULT_MAX_TASKS),
        maxFixAttemptsPerTask: positiveInt(env.PROJECT_PILOT_MANAGER_MAX_FIX_ATTEMPTS_PER_TASK, DEFAULT_MAX_FIX_ATTEMPTS),
        maxManagerRuntimeMs: positiveInt(env.PROJECT_PILOT_MANAGER_MAX_RUNTIME_MS, DEFAULT_MAX_RUNTIME_MS)
    };
}
export function managerConfigurationStatus(config = managerModeConfig()) {
    return {
        managerModeConfigured: config.configured,
        managerModel: config.managerModel,
        maxManagerDecisionsPerRun: config.maxManagerDecisionsPerRun,
        maxTasksPerRun: config.maxTasksPerRun,
        maxFixAttemptsPerTask: config.maxFixAttemptsPerTask,
        maxManagerRuntimeMs: config.maxManagerRuntimeMs
    };
}
export function validateManagerDecision(value) {
    return decisionSchema.parse(value);
}
export class OpenAIResponsesManagerAdapter {
    config;
    constructor(config = managerModeConfig()) {
        this.config = config;
    }
    async decide(context) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey?.trim()) {
            throw new Error("OPENAI_API_KEY is not configured.");
        }
        const { default: OpenAI } = await import("openai");
        const client = new OpenAI({ apiKey });
        const response = await client.responses.create({
            model: this.config.managerModel,
            input: managerPrompt(context),
            text: {
                format: {
                    type: "json_schema",
                    name: "project_pilot_manager_decision",
                    description: "One bounded Project Pilot Manager Mode decision.",
                    strict: true,
                    schema: MANAGER_DECISION_JSON_SCHEMA
                }
            }
        });
        return extractOpenAIManagerCandidate(response);
    }
}
export class CodexArchitectAdapter {
    async consult(options) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey?.trim()) {
            throw new Error("OPENAI_API_KEY is not configured.");
        }
        const { Codex } = await import("@openai/codex-sdk");
        const codex = new Codex({ apiKey });
        const thread = options.threadId
            ? codex.resumeThread(options.threadId, {
                workingDirectory: options.projectRoot,
                sandboxMode: "read-only",
                approvalPolicy: "never",
                skipGitRepoCheck: true
            })
            : codex.startThread({
                workingDirectory: options.projectRoot,
                sandboxMode: "read-only",
                approvalPolicy: "never",
                skipGitRepoCheck: true
            });
        const turn = await thread.run(options.prompt);
        return {
            threadId: thread.id ?? options.threadId,
            summary: conciseText(turn.finalResponse)
        };
    }
}
export class AutopilotService {
    store;
    projects;
    jobs;
    manager;
    architect;
    notifier;
    config;
    now;
    autoSchedule;
    processExists;
    activeTicks = new Set();
    heartbeatTimers = new Map();
    constructor(options) {
        this.store = options.store ?? new StateStore();
        this.projects = options.projects ?? new ProjectRegistry();
        this.jobs = options.jobs;
        this.config = options.config ?? managerModeConfig();
        this.manager = options.manager ?? new OpenAIResponsesManagerAdapter(this.config);
        this.architect = options.architect ?? new CodexArchitectAdapter();
        this.notifier = options.notifier ?? new NullAutopilotNotifier();
        this.now = options.now ?? (() => new Date().toISOString());
        this.autoSchedule = options.autoSchedule ?? true;
        this.processExists = options.processExists ?? defaultProcessExists;
    }
    async configurationStatus() {
        const projectState = await this.projects.listProjects();
        return {
            ...managerConfigurationStatus(this.config),
            projects: projectState.projects.map((project) => ({
                projectId: project.id,
                projectName: project.name,
                maintenance: maintenanceStatus(project)
            }))
        };
    }
    async createProjectBrief(input) {
        await this.projects.getProject(input.projectId);
        const now = this.now();
        const brief = {
            ...input,
            id: createBriefId(),
            decisions: input.decisions ?? [],
            definitionOfDone: input.definitionOfDone ?? [],
            createdAt: now,
            updatedAt: now
        };
        await this.store.addProjectBrief(brief);
        return { briefId: brief.id, brief };
    }
    async getProjectBrief(briefId) {
        const brief = await this.store.getProjectBrief(briefId);
        if (!brief) {
            throw new Error(`Unknown briefId: ${briefId}`);
        }
        return brief;
    }
    async listProjectBriefs() {
        return { briefs: await this.store.listProjectBriefs() };
    }
    async startAutopilot(input) {
        const brief = await this.getProjectBrief(input.briefId);
        const project = input.projectId ? await this.projects.getProject(input.projectId) : await this.projects.getActiveProject();
        if (brief.projectId !== project.id) {
            throw new Error(`Brief ${brief.id} belongs to project ${brief.projectId}, not ${project.id}.`);
        }
        const preflight = this.preflightProject(project);
        if (!preflight.ok) {
            throw new Error(`Cannot start Autopilot until maintenance Git preflight passes: ${preflight.reason ?? "Git preflight failed."}`);
        }
        const now = this.now();
        const run = {
            id: createRunId(),
            projectId: project.id,
            briefId: brief.id,
            planId: input.planId ?? brief.planId,
            status: "running",
            phase: "idle",
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            currentTaskId: undefined,
            activeRuntimeMs: 0,
            activeRuntimeStartedAt: undefined,
            nextAction: null,
            decisionsUsed: 0,
            tasksStarted: 0,
            fixAttemptsByTaskId: {},
            recoveryAttemptsByTaskId: {},
            queue: [],
            decisions: [],
            timeline: [{ at: now, kind: "status", summary: "Autopilot run started by explicit user request." }],
            codexThreads: {},
            limits: {
                maxManagerDecisions: input.limits?.maxManagerDecisions ?? this.config.maxManagerDecisionsPerRun,
                maxTasks: input.limits?.maxTasks ?? this.config.maxTasksPerRun,
                maxFixAttemptsPerTask: input.limits?.maxFixAttemptsPerTask ?? this.config.maxFixAttemptsPerTask,
                maxRuntimeMs: input.limits?.maxRuntimeMs ?? this.config.maxManagerRuntimeMs
            },
            scheduler: {
                dispatchStatus: "created"
            },
            workers: []
        };
        await this.store.addAutopilotRun(run);
        if (this.autoSchedule) {
            this.scheduleRun(run.id, "run-started");
            this.ensureHeartbeat(run.id);
        }
        return { runId: run.id, status: run.status, run };
    }
    async getAutopilotStatus(runId) {
        return await this.requireRun(runId);
    }
    async listAutopilotRuns() {
        return { runs: await this.store.listAutopilotRuns() };
    }
    async pauseAutopilot(runId, reason = "Paused by user request.") {
        const run = await this.updateRun(runId, (existing) => pauseRun(existing, reason, this.now()));
        this.notifier.notify("Project Pilot autopilot paused", reason);
        return run;
    }
    async resumeAutopilot(runId) {
        const now = this.now();
        const run = await this.updateRun(runId, (existing) => ({
            ...existing,
            status: "running",
            phase: "idle",
            pauseReason: undefined,
            pausedAt: undefined,
            activeRuntimeStartedAt: undefined,
            activeRuntimeMs: existing.activeRuntimeMs ?? 0,
            timeline: appendTimeline(existing, now, "status", "Autopilot run resumed.")
        }));
        this.scheduleRun(run.id, "run-resumed");
        this.ensureHeartbeat(run.id);
        return run;
    }
    async updateAutopilotLimits(input) {
        const now = this.now();
        const run = await this.requireRun(input.runId);
        const recalculatedActiveRuntimeMs = run.activeRuntimeMs === undefined ? await this.recalculateActiveRuntimeMs(run) : runtimeSnapshot(run, now).activeRuntimeMs;
        const updated = await this.updateRun(input.runId, (existing) => {
            const oldLimits = existing.limits;
            const newLimits = {
                maxRuntimeMs: input.maxRuntimeMs ?? oldLimits.maxRuntimeMs,
                maxManagerDecisions: input.maxManagerDecisions ?? oldLimits.maxManagerDecisions,
                maxTasks: input.maxTasks ?? oldLimits.maxTasks,
                maxFixAttemptsPerTask: input.maxFixAttemptsPerTask ?? oldLimits.maxFixAttemptsPerTask
            };
            const remaining = Math.max(0, newLimits.maxRuntimeMs - recalculatedActiveRuntimeMs);
            const wasRuntimeLimited = existing.status === "usage-limited" && /runtime budget|runtime limit/i.test(existing.pauseReason ?? "");
            return {
                ...existing,
                status: wasRuntimeLimited && remaining > 0 ? "paused" : existing.status,
                phase: wasRuntimeLimited && remaining > 0 ? "paused" : existing.phase,
                pauseReason: wasRuntimeLimited && remaining > 0
                    ? `Runtime limit updated; ${Math.round(remaining / 1000)} seconds of active runtime remain. Ready for user-controlled resume.`
                    : existing.pauseReason,
                activeRuntimeMs: recalculatedActiveRuntimeMs,
                activeRuntimeStartedAt: undefined,
                limits: newLimits,
                timeline: appendTimeline(existing, now, "status", "Autopilot limits updated.", {
                    reason: input.reason,
                    oldLimits,
                    newLimits,
                    activeRuntimeMs: recalculatedActiveRuntimeMs
                })
            };
        });
        return { ...updated, runtime: runtimeSnapshot(updated, now) };
    }
    async stopAutopilot(runId, reason = "Stopped by user request.") {
        const now = this.now();
        const run = await this.updateRun(runId, (existing) => ({
            ...accrueActiveRuntime(existing, now),
            status: "stopped",
            phase: "stopped",
            stopReason: reason,
            endedAt: now,
            timeline: appendTimeline(existing, now, "status", reason)
        }));
        this.notifier.notify("Project Pilot autopilot stopped", reason);
        return run;
    }
    async reconcileAndResume() {
        const runs = await this.store.listAutopilotRuns();
        for (const run of runs) {
            if (run.status === "running" || run.status === "queued") {
                if (run.activeRuntimeStartedAt) {
                    await this.updateRun(run.id, (existing) => ({
                        ...existing,
                        activeRuntimeStartedAt: this.now(),
                        activeRuntimeMs: existing.activeRuntimeMs ?? 0,
                        timeline: appendTimeline(existing, this.now(), "status", "Runtime tracking resumed after Project Pilot startup; server-down time was excluded.")
                    }));
                }
                this.scheduleRun(run.id, "startup-reconciliation");
                this.ensureHeartbeat(run.id);
            }
        }
    }
    scheduleRun(runId, reason = "scheduled") {
        void this.updateRun(runId, (existing) => ({
            ...existing,
            scheduler: {
                ...(existing.scheduler ?? {}),
                nextScheduledTickAt: this.now(),
                dispatchStatus: reason,
                skippedDispatchReason: undefined
            }
        })).catch(() => undefined);
        setImmediate(() => {
            void this.tick(runId).catch((error) => this.handleSchedulerError(runId, error));
        });
    }
    ensureHeartbeat(runId) {
        if (!this.autoSchedule || this.heartbeatTimers.has(runId)) {
            return;
        }
        const timer = setInterval(() => {
            void this.scheduleRun(runId, "heartbeat");
        }, SCHEDULER_HEARTBEAT_MS);
        timer.unref?.();
        this.heartbeatTimers.set(runId, timer);
    }
    async tick(runId) {
        if (this.activeTicks.has(runId)) {
            await this.updateRun(runId, (existing) => ({
                ...existing,
                scheduler: {
                    ...(existing.scheduler ?? {}),
                    skippedDispatchReason: "Scheduler tick skipped because another tick is already running for this run.",
                    dispatchStatus: "single-flight-skip"
                }
            })).catch(() => undefined);
            return;
        }
        this.activeTicks.add(runId);
        try {
            await this.updateRun(runId, (existing) => ({
                ...existing,
                scheduler: {
                    ...(existing.scheduler ?? {}),
                    inProgress: true,
                    lastTickAt: this.now(),
                    dispatchStatus: "running",
                    skippedDispatchReason: undefined
                }
            }));
            await this.beginActiveRuntime(runId);
            await this.tickInternal(runId);
        }
        finally {
            await this.endActiveRuntimeIfIdle(runId);
            await this.updateRun(runId, (existing) => ({
                ...existing,
                scheduler: {
                    ...(existing.scheduler ?? {}),
                    inProgress: false,
                    nextScheduledTickAt: shouldKeepScheduling(existing) ? new Date(Date.parse(this.now()) + SCHEDULER_HEARTBEAT_MS).toISOString() : undefined
                }
            })).catch(() => undefined);
            this.activeTicks.delete(runId);
        }
    }
    async handleSchedulerError(runId, error) {
        const message = errorMessage(error);
        await this.updateRun(runId, (existing) => pauseRun(existing, `state_store_unavailable: Scheduler could not safely persist state. ${message}`, this.now(), "blocked")).catch(() => undefined);
        this.notifier.notify("Project Pilot state store unavailable", message);
    }
    async tickInternal(runId) {
        let run = await this.requireRun(runId);
        if (run.status !== "running" && run.status !== "queued") {
            return;
        }
        run = await this.requireRun(run.id);
        const activeRuntimeMs = runtimeSnapshot(run, this.now()).activeRuntimeMs;
        if (activeRuntimeMs > run.limits.maxRuntimeMs) {
            await this.pauseFor(run.id, "Manager runtime budget reached.", "usage-limited");
            return;
        }
        if (run.decisionsUsed >= run.limits.maxManagerDecisions) {
            await this.pauseFor(run.id, "Manager decision budget reached.", "usage-limited");
            return;
        }
        await this.reconcileWorkerLeases(run.id);
        run = await this.requireRun(run.id);
        const activeTask = run.currentTaskId ? await this.store.getTask(run.currentTaskId) : undefined;
        if (activeTask) {
            const advanced = await this.advanceActiveTask(run, activeTask);
            if (advanced) {
                run = await this.requireRun(run.id);
            }
            else {
                return;
            }
        }
        const brief = await this.getProjectBrief(run.briefId);
        const project = await this.projects.getProject(run.projectId);
        const dispatched = await this.dispatchRunnableQueueItem(run.id, project.id);
        if (dispatched) {
            return;
        }
        if (!this.config.configured) {
            await this.pauseFor(run.id, "OPENAI_API_KEY is not configured; Manager Mode cannot call the manager API.", "blocked");
            return;
        }
        const cancelledDuplicates = await this.jobs.cancelDuplicateQueuedTasks(project.id);
        if (cancelledDuplicates.length > 0) {
            await this.updateRun(run.id, (existing) => ({
                ...existing,
                timeline: appendTimeline(existing, this.now(), "status", `Cancelled ${cancelledDuplicates.length} duplicate queued task(s) before manager decision.`, { taskIds: cancelledDuplicates.map((task) => task.id) })
            }));
            run = await this.requireRun(run.id);
        }
        const decision = await this.requestManagerDecision(run, brief, project);
        if (!decision) {
            return;
        }
        await this.applyDecision(run.id, decision, project, brief);
    }
    async requestManagerDecision(run, brief, project) {
        const context = await this.buildManagerContext(run, brief, project);
        let firstRaw;
        try {
            firstRaw = await this.manager.decide(context);
        }
        catch (error) {
            await this.pauseFor(run.id, managerApiFailureReason(error), "blocked");
            return null;
        }
        const firstCandidate = normalizeManagerCandidate(firstRaw);
        await this.recordCandidateDiagnostics(run.id, firstCandidate.diagnostics);
        const first = parseManagerDecision(firstCandidate.candidate);
        if (first.ok) {
            return first.decision;
        }
        const firstDiagnostics = formatDecisionValidationError(first.error);
        const firstPreview = firstCandidate.diagnostics.candidatePreview;
        await this.updateRun(run.id, (existing) => ({
            ...existing,
            timeline: appendTimeline(existing, this.now(), "status", `manager_decision_invalid: malformed manager decision; requesting one corrective retry. ${firstDiagnostics}`, {
                invalidResponsePreview: firstPreview,
                receivedAction: firstCandidate.diagnostics.receivedAction,
                missingFields: firstCandidate.diagnostics.missingFields
            })
        }));
        let secondRaw;
        try {
            secondRaw = await this.manager.decide({
                ...context,
                correction: {
                    validationDiagnostics: firstDiagnostics,
                    invalidResponsePreview: firstPreview
                }
            });
        }
        catch (error) {
            await this.pauseFor(run.id, managerApiFailureReason(error), "blocked");
            return null;
        }
        const secondCandidate = normalizeManagerCandidate(secondRaw);
        await this.recordCandidateDiagnostics(run.id, secondCandidate.diagnostics);
        const second = parseManagerDecision(secondCandidate.candidate);
        if (second.ok) {
            await this.updateRun(run.id, (existing) => ({
                ...existing,
                timeline: appendTimeline(existing, this.now(), "status", "manager_decision_corrected: corrective retry returned a valid decision.")
            }));
            return second.decision;
        }
        const secondDiagnostics = formatDecisionValidationError(second.error);
        await this.pauseFor(run.id, `manager_decision_invalid: manager returned malformed decisions twice. First validation: ${firstDiagnostics}. Second validation: ${secondDiagnostics}.`, "blocked");
        return null;
    }
    async recordCandidateDiagnostics(runId, diagnostics) {
        const action = diagnostics.receivedAction === null ? "missing" : diagnostics.receivedAction;
        const missing = diagnostics.missingFields.length > 0 ? diagnostics.missingFields.join(", ") : "none";
        await this.updateRun(runId, (existing) => ({
            ...existing,
            timeline: appendTimeline(existing, this.now(), "status", `manager_decision_candidate: action=${action}; missing=${missing}.`, { ...diagnostics })
        }));
    }
    async buildManagerContext(run, brief, project) {
        const activeTask = run.currentTaskId ? (await this.store.getTask(run.currentTaskId)) ?? null : null;
        const reportTaskId = activeTask?.id ?? run.lastCompletedTaskId;
        const taskDetails = reportTaskId ? await this.jobs.getTaskDetails(reportTaskId).catch(() => null) : null;
        const planDetails = run.planId ? await this.jobs.getPlanDetails(run.planId).catch(() => null) : null;
        const taskList = await this.jobs.listTasks().catch(() => ({ tasks: [] }));
        return {
            run,
            brief,
            project,
            gitPolicy: project.allowedGitBehavior,
            plan: planDetails
                ? {
                    planId: planDetails.planId,
                    status: planDetails.status,
                    summary: planDetails.summary,
                    report: planDetails.report,
                    errors: planDetails.errors
                }
                : null,
            activeTask,
            projectTasks: taskList.tasks
                .filter((task) => task.projectId === project.id)
                .slice(0, 20)
                .map((task) => ({
                taskId: task.taskId,
                title: task.title,
                status: task.status,
                updatedAt: task.updatedAt,
                buildSummary: task.buildSummary,
                reviewResult: task.reviewResult,
                approval: task.approval
            })),
            reports: {
                buildReport: taskDetails?.buildReport ?? null,
                reviewReport: taskDetails?.reviewReport ?? null
            }
        };
    }
    async advanceActiveTask(run, task) {
        const reconciled = typeof this.jobs.reconcileTaskForAutopilot === "function"
            ? await this.jobs.reconcileTaskForAutopilot(task.id)
            : task;
        const status = deriveTaskStatus(reconciled);
        if (status === "completed") {
            await this.updateRun(run.id, (existing) => ({
                ...existing,
                currentTaskId: existing.currentTaskId === reconciled.id ? undefined : existing.currentTaskId,
                lastCompletedTaskId: reconciled.id,
                phase: "idle",
                queue: markQueueTaskCompleted(existing.queue, reconciled.id, this.now()),
                workers: markWorkerLeases(existing.workers, reconciled.id, "completed", this.now(), "task completed"),
                nextAction: null,
                timeline: appendTimeline(existing, this.now(), "reviewer-summary", `Task ${reconciled.id} reviewed and finalized.`)
            }));
            if (this.autoSchedule) {
                this.scheduleRun(run.id, "task-finalized");
            }
            return false;
        }
        if (status === "build-passed" && !reconciled.review) {
            const project = await this.projects.getProject(run.projectId);
            const preflight = this.preflightProject(project);
            if (!preflight.ok) {
                await this.pauseFor(run.id, preflight.reason ?? "Maintenance Git preflight failed.", "blocked");
                return false;
            }
            const lease = createWorkerLease({
                runId: run.id,
                taskId: reconciled.id,
                phase: "review",
                attemptType: "manager",
                command: "codex review worker",
                startedAt: this.now(),
                reportPath: reviewReportFile(taskArtifactRoot(project)),
                expectedArtifact: "REVIEW_REPORT.md"
            });
            await this.updateRun(run.id, (existing) => ({
                ...existing,
                phase: "reviewing",
                workers: [...(existing.workers ?? []), lease],
                timeline: appendTimeline(existing, this.now(), "builder-summary", `Build passed for ${reconciled.id}; starting review.`)
            }));
            await this.jobs.runReview(reconciled.id);
            await this.updateRun(run.id, (existing) => ({
                ...existing,
                workers: markWorkerLeases(existing.workers, reconciled.id, "completed", this.now(), "review worker returned")
            }));
            if (this.autoSchedule) {
                this.scheduleRun(run.id, "review-terminal");
            }
            return false;
        }
        if (status === "ready-for-approval") {
            const finalized = await this.jobs.finalizeTask(reconciled.id);
            const completed = finalized.status === "completed";
            await this.updateRun(run.id, (existing) => ({
                ...existing,
                currentTaskId: completed ? undefined : existing.currentTaskId,
                lastCompletedTaskId: completed ? reconciled.id : existing.lastCompletedTaskId,
                phase: completed ? "idle" : "paused",
                queue: completed ? markQueueTaskCompleted(existing.queue, reconciled.id, this.now()) : existing.queue,
                workers: completed ? markWorkerLeases(existing.workers, reconciled.id, "completed", this.now(), "task finalized") : existing.workers,
                nextAction: completed ? null : existing.nextAction,
                timeline: appendTimeline(existing, this.now(), "reviewer-summary", completed ? `Task ${reconciled.id} reviewed and finalized.` : `Task ${reconciled.id} requires manual approval.`)
            }));
            if (!completed) {
                await this.pauseFor(run.id, "Task requires manual approval under approval policy.", "paused");
            }
            if (completed && this.autoSchedule) {
                this.scheduleRun(run.id, "task-finalized");
            }
            return false;
        }
        if (status === "needs-fixes") {
            const attempts = run.fixAttemptsByTaskId[reconciled.id] ?? 0;
            if (attempts >= run.limits.maxFixAttemptsPerTask) {
                await this.pauseFor(run.id, `Task ${reconciled.id} still needs fixes after ${attempts} fix attempt(s).`, "blocked");
                return false;
            }
            await this.updateRun(run.id, (existing) => ({
                ...existing,
                phase: "fixing",
                currentTaskId: undefined,
                fixAttemptsByTaskId: { ...existing.fixAttemptsByTaskId, [reconciled.id]: attempts + 1 },
                timeline: appendTimeline(existing, this.now(), "reviewer-summary", `Task ${reconciled.id} needs fixes.`)
            }));
            return true;
        }
        if (status === "failed" || status === "blocked" || status === "stopped") {
            if (status === "blocked" && isOperationalWorkerLoss(reconciled)) {
                const queued = await this.ensureRecoveryQueued(run, reconciled);
                if (queued) {
                    return true;
                }
            }
            await this.pauseFor(run.id, `Task ${reconciled.id} ended with status ${status}.`, "blocked");
            return false;
        }
        return false;
    }
    async applyDecision(runId, decision, project, brief) {
        const now = this.now();
        let run = await this.updateRun(runId, (existing) => ({
            ...existing,
            decisionsUsed: existing.decisionsUsed + 1,
            nextAction: decision.action,
            decisions: [
                ...existing.decisions,
                { at: now, action: decision.action, summary: decision.summary, reason: decision.reason ?? undefined }
            ],
            timeline: appendTimeline(existing, now, "manager-decision", decision.summary, { action: decision.action })
        }));
        switch (decision.action) {
            case "create_plan":
            case "revise_plan": {
                try {
                    const preflight = this.preflightProject(project);
                    if (!preflight.ok) {
                        await this.pauseFor(runId, preflight.reason ?? "Maintenance Git preflight failed.", "blocked");
                        return;
                    }
                    const consultation = await this.architect.consult({
                        projectRoot: taskArtifactRoot(project),
                        threadId: run.codexThreads.architectThreadId,
                        prompt: `Project brief: ${brief.title}\n\n${brief.productSummary}\n\n${brief.requirements}\n\nManager request: ${decision.summary}`
                    });
                    await this.updateRun(runId, (existing) => ({
                        ...existing,
                        phase: "consulting-architect",
                        codexThreads: {
                            ...existing.codexThreads,
                            architectThreadId: consultation.threadId,
                            architectSummary: consultation.summary,
                            updatedAt: this.now()
                        },
                        timeline: appendTimeline(existing, this.now(), "architect-consultation", consultation.summary)
                    }));
                }
                catch (error) {
                    await this.pauseFor(runId, `Codex architect consultation failed: ${errorMessage(error)}`, "blocked");
                }
                return;
            }
            case "create_ordered_tasks": {
                const tasks = decision.tasks ?? [];
                if (tasks.length === 0) {
                    await this.pauseFor(runId, "Manager requested task creation but provided no tasks.", "blocked");
                    return;
                }
                await this.updateRun(runId, (existing) => ({
                    ...existing,
                    phase: "queuing-tasks",
                    queue: [
                        ...existing.queue,
                        ...tasks.map((task) => ({
                            id: `queue-${randomUUID().slice(0, 8)}`,
                            title: task.title,
                            requirements: task.requirements,
                            acceptanceCriteria: task.acceptanceCriteria,
                            source: "manager",
                            status: "queued",
                            createdAt: this.now(),
                            updatedAt: this.now()
                        }))
                    ]
                }));
                if (this.autoSchedule) {
                    this.scheduleRun(runId, "manager-created-queue");
                }
                return;
            }
            case "request_one_fix_attempt": {
                if (!decision.fixTask) {
                    await this.pauseFor(runId, "Manager requested a fix attempt but provided no fix task.", "blocked");
                    return;
                }
                const source = isOperationalRecoveryDecision(decision) ? "recovery" : "fix";
                await this.updateRun(runId, (existing) => ({
                    ...existing,
                    phase: source === "recovery" ? "fixing" : "fixing",
                    queue: [
                        ...existing.queue,
                        {
                            id: `queue-${randomUUID().slice(0, 8)}`,
                            title: decision.fixTask.title,
                            requirements: decision.fixTask.requirements,
                            acceptanceCriteria: decision.fixTask.acceptanceCriteria,
                            source,
                            fixAttemptForTaskId: decision.fixTask.fixAttemptForTaskId,
                            status: "queued",
                            createdAt: this.now(),
                            updatedAt: this.now()
                        }
                    ]
                }));
                if (this.autoSchedule) {
                    this.scheduleRun(runId, source === "recovery" ? "recovery-queued" : "fix-queued");
                }
                return;
            }
            case "start_next_task": {
                await this.startNextQueuedTask(runId, project.id);
                return;
            }
            case "finalize_current_task": {
                await this.finalizeCurrentTask(runId, decision.taskId);
                return;
            }
            case "skip_duplicate_task": {
                await this.skipDuplicateTask(runId, project.id, decision.taskId, decision.reason);
                return;
            }
            case "finalize_project": {
                await this.updateRun(runId, (existing) => ({
                    ...accrueActiveRuntime(existing, this.now()),
                    status: "completed",
                    phase: "completed",
                    endedAt: this.now(),
                    completionSummary: decision.summary,
                    timeline: appendTimeline(existing, this.now(), "status", decision.summary)
                }));
                this.notifier.notify("Project Pilot autopilot completed", decision.summary);
                return;
            }
            case "pause_for_blocker": {
                await this.pauseFor(runId, decision.reason || decision.summary, "blocked");
                return;
            }
            case "stop": {
                await this.stopAutopilot(runId, decision.reason || decision.summary);
                return;
            }
        }
        assertNever(decision.action);
    }
    async finalizeCurrentTask(runId, taskId) {
        const finalized = await this.jobs.finalizeTask(taskId);
        const completed = finalized.status === "completed";
        await this.updateRun(runId, (existing) => ({
            ...existing,
            phase: completed ? "idle" : "paused",
            currentTaskId: completed && existing.currentTaskId === taskId ? undefined : existing.currentTaskId,
            lastCompletedTaskId: completed ? taskId : existing.lastCompletedTaskId,
            queue: completed ? markQueueTaskCompleted(existing.queue, taskId, this.now()) : existing.queue,
            timeline: appendTimeline(existing, this.now(), "reviewer-summary", completed ? `Task ${taskId} finalized by manager decision.` : `Task ${taskId} could not be auto-finalized by policy.`)
        }));
        if (!completed) {
            await this.pauseFor(runId, `Task ${taskId} requires manual approval under approval policy.`, "paused");
        }
    }
    async skipDuplicateTask(runId, projectId, taskId, reason) {
        const cancelled = await this.jobs.cancelDuplicateQueuedTask(taskId, reason);
        await this.updateRun(runId, (existing) => ({
            ...existing,
            timeline: appendTimeline(existing, this.now(), "status", `Skipped duplicate task ${cancelled.id}: ${reason}`, { taskId, projectId, reason })
        }));
    }
    async ensureRecoveryQueued(run, task) {
        const attempts = run.recoveryAttemptsByTaskId?.[task.id] ?? 0;
        if (attempts >= MAX_RECOVERY_ATTEMPTS_PER_TASK) {
            await this.pauseFor(run.id, `Operational recovery for ${task.id} reached ${attempts} attempt(s).`, "blocked");
            return false;
        }
        const existing = run.queue.find((item) => item.fixAttemptForTaskId === task.id && (item.source === "recovery" || item.source === "fix") && item.status === "queued");
        await this.updateRun(run.id, (current) => ({
            ...current,
            phase: "fixing",
            currentTaskId: undefined,
            queue: existing
                ? current.queue.map((item) => item.id === existing.id ? { ...item, source: "recovery", updatedAt: this.now() } : item)
                : [
                    ...current.queue,
                    {
                        id: `queue-${randomUUID().slice(0, 8)}`,
                        title: `Revalidate ${task.title}`,
                        requirements: [
                            "Operational recovery for a task whose worker terminal result was lost.",
                            "Reuse the existing task scope and verify the implementation without expanding requirements.",
                            task.requirements
                        ].join("\n\n"),
                        acceptanceCriteria: task.acceptanceCriteria,
                        source: "recovery",
                        fixAttemptForTaskId: task.id,
                        status: "queued",
                        createdAt: this.now(),
                        updatedAt: this.now()
                    }
                ],
            scheduler: {
                ...(current.scheduler ?? {}),
                dispatchStatus: "recovery-queued",
                lastDispatchOutcome: `Operational recovery queued for ${task.id}.`
            },
            timeline: appendTimeline(current, this.now(), "status", `Operational recovery queued for ${task.id} after missing terminal worker result.`, { taskId: task.id, recoveryAttempts: attempts })
        }));
        if (this.autoSchedule) {
            this.scheduleRun(run.id, "operational-recovery-queued");
        }
        return true;
    }
    async dispatchRunnableQueueItem(runId, projectId) {
        const run = await this.requireRun(runId);
        if (run.currentTaskId) {
            await this.recordSchedulerOutcome(runId, "skipped", "Current task is still active.");
            return false;
        }
        const next = run.queue.find((item) => item.status === "queued" && (item.source === "recovery" || item.source === "fix")) ??
            run.queue.find((item) => item.status === "queued" && item.source === "manager");
        if (!next) {
            await this.recordSchedulerOutcome(runId, "idle", "No queued runnable task is available.");
            return false;
        }
        await this.startQueuedTask(runId, projectId, next);
        return true;
    }
    preflightProject(project) {
        const preflightRunner = this.jobs;
        if (typeof preflightRunner.preflightWorkerLaunch === "function") {
            return preflightRunner.preflightWorkerLaunch(project);
        }
        return { ok: true, diagnostics: { projectId: project.id, maintenanceMode: project.maintenance?.enabled === true } };
    }
    async startQueuedTask(runId, projectId, next) {
        const run = await this.requireRun(runId);
        if (run.currentTaskId) {
            await this.recordSchedulerOutcome(runId, "skipped", "Dispatch skipped because a current task appeared before launch.");
            return;
        }
        if (run.tasksStarted >= run.limits.maxTasks) {
            await this.pauseFor(runId, "Maximum tasks per run reached.", "usage-limited");
            return;
        }
        if (next.source === "recovery" && next.fixAttemptForTaskId) {
            const attempts = run.recoveryAttemptsByTaskId?.[next.fixAttemptForTaskId] ?? 0;
            if (attempts >= MAX_RECOVERY_ATTEMPTS_PER_TASK) {
                await this.pauseFor(runId, `Operational recovery for ${next.fixAttemptForTaskId} already reached ${attempts} attempt(s).`, "blocked");
                return;
            }
        }
        const taskInput = {
            projectId,
            title: next.title,
            requirements: next.requirements,
            acceptanceCriteria: next.acceptanceCriteria
        };
        const project = await this.projects.getProject(projectId);
        const preflight = this.preflightProject(project);
        if (!preflight.ok) {
            await this.updateRun(runId, (existing) => ({
                ...existing,
                scheduler: {
                    ...(existing.scheduler ?? {}),
                    dispatchStatus: "maintenance-preflight-blocked",
                    lastDispatchOutcome: preflight.reason ?? "Maintenance Git preflight failed."
                },
                timeline: appendTimeline(existing, this.now(), "status", `Maintenance worker launch blocked: ${preflight.reason ?? "Git preflight failed."}`, { diagnostics: preflight.diagnostics })
            }));
            await this.pauseFor(runId, preflight.reason ?? "Maintenance Git preflight failed.", "blocked");
            return;
        }
        const preparedStarter = this.jobs;
        if (typeof preparedStarter.prepareBuild === "function" && typeof preparedStarter.launchPreparedBuild === "function") {
            const prepared = await preparedStarter.prepareBuild(taskInput);
            if (prepared.duplicate) {
                await this.recordSchedulerOutcome(runId, "duplicate", `Queue item ${next.id} duplicates existing task ${prepared.task.id}; no worker launched.`);
                return;
            }
            const lease = createWorkerLease({
                runId,
                taskId: prepared.task.id,
                phase: next.source === "recovery" ? "recovery" : next.source === "fix" ? "fix" : "build",
                attemptType: next.source === "recovery" ? "recovery" : next.source === "fix" ? "reviewer-fix" : "manager",
                command: "codex build worker",
                startedAt: this.now(),
                reportPath: buildReportFile(taskArtifactRoot(project)),
                expectedArtifact: "BUILD_REPORT.md"
            });
            await this.store.transaction((state) => {
                state.tasks.unshift(prepared.task);
                state.autopilotRuns = state.autopilotRuns ?? [];
                const index = state.autopilotRuns.findIndex((candidate) => candidate.id === runId);
                if (index < 0) {
                    throw new Error(`Unknown autopilot runId: ${runId}`);
                }
                state.autopilotRuns[index] = launchQueuedTaskRunState(state.autopilotRuns[index], next, prepared.task.id, lease, this.now());
            });
            await preparedStarter.launchPreparedBuild(prepared);
            return;
        }
        const started = await this.jobs.startBuild(taskInput);
        const lease = createWorkerLease({
            runId,
            taskId: started.taskId,
            phase: next.source === "recovery" ? "recovery" : next.source === "fix" ? "fix" : "build",
            attemptType: next.source === "recovery" ? "recovery" : next.source === "fix" ? "reviewer-fix" : "manager",
            command: "codex build worker",
            startedAt: this.now(),
            reportPath: buildReportFile(taskArtifactRoot(project)),
            expectedArtifact: "BUILD_REPORT.md"
        });
        await this.updateRun(runId, (existing) => launchQueuedTaskRunState(existing, next, started.taskId, lease, this.now()));
    }
    async startNextQueuedTask(runId, projectId) {
        const run = await this.requireRun(runId);
        if (run.currentTaskId) {
            return;
        }
        if (run.tasksStarted >= run.limits.maxTasks) {
            await this.pauseFor(runId, "Maximum tasks per run reached.", "usage-limited");
            return;
        }
        const next = run.queue.find((item) => item.status === "queued");
        if (!next) {
            await this.pauseFor(runId, "No queued task is available for start_next_task.", "blocked");
            return;
        }
        await this.startQueuedTask(runId, projectId, next);
    }
    async recordSchedulerOutcome(runId, status, reason) {
        await this.updateRun(runId, (existing) => ({
            ...existing,
            scheduler: {
                ...(existing.scheduler ?? {}),
                dispatchStatus: status,
                lastDispatchOutcome: reason,
                skippedDispatchReason: status === "skipped" ? reason : existing.scheduler?.skippedDispatchReason
            }
        }));
    }
    async reconcileWorkerLeases(runId) {
        const run = await this.requireRun(runId);
        const activeLeases = (run.workers ?? []).filter((lease) => lease.status === "active");
        if (activeLeases.length === 0) {
            return;
        }
        const reconciled = [];
        const tasks = await this.store.listTasks();
        const tasksById = new Map(tasks.map((task) => [task.id, task]));
        const activeTaskIds = new Set([run.currentTaskId, ...run.queue.filter((item) => item.status === "active").map((item) => item.taskId)].filter(Boolean));
        const workers = (run.workers ?? []).map((lease) => {
            if (lease.status !== "active") {
                return lease;
            }
            const result = this.classifyWorkerLease(lease, tasksById.get(lease.taskId), activeTaskIds);
            if (!result) {
                return lease;
            }
            reconciled.push({ leaseId: lease.id, taskId: lease.taskId, ...result });
            return {
                ...lease,
                status: result.status,
                endedAt: this.now(),
                lastActivityAt: this.now(),
                outcome: result.outcome
            };
        });
        if (reconciled.length === 0) {
            return;
        }
        await this.updateRun(runId, (existing) => ({
            ...existing,
            workers,
            scheduler: {
                ...(existing.scheduler ?? {}),
                dispatchStatus: "leases-reconciled",
                lastDispatchOutcome: `Reconciled ${reconciled.length} stale worker lease(s).`
            },
            timeline: appendTimeline(existing, this.now(), "status", `Reconciled ${reconciled.length} stale worker lease(s).`, {
                leases: reconciled
            })
        }));
    }
    classifyWorkerLease(lease, task, activeTaskIds) {
        if (lease.pid !== undefined && !this.processExists(lease.pid)) {
            return { status: "dead", outcome: `Tracked worker PID ${lease.pid} is no longer running.` };
        }
        if (!task) {
            return { status: "dead", outcome: "Worker lease references a missing task record." };
        }
        const status = deriveTaskStatus(task);
        if (status === "completed") {
            return { status: "completed", outcome: "Task completed." };
        }
        if (status === "build-passed" && lease.phase === "build") {
            return { status: "completed", outcome: "Build worker completed and task advanced to review eligibility." };
        }
        if (status === "ready-for-approval" || status === "needs-fixes") {
            return { status: "completed", outcome: `Review worker completed with task status ${status}.` };
        }
        if (status === "stopped") {
            return { status: "recovered", outcome: "Task was stopped; active worker lease recovered." };
        }
        if (status === "failed" || status === "blocked") {
            return { status: "dead", outcome: `Task ended with terminal status ${status}.` };
        }
        if (!activeTaskIds.has(lease.taskId)) {
            return { status: "recovered", outcome: "Lease was active but the run no longer has this task active." };
        }
        return undefined;
    }
    async pauseFor(runId, reason, status) {
        const run = await this.updateRun(runId, (existing) => pauseRun(existing, reason, this.now(), status));
        this.notifier.notify(`Project Pilot autopilot ${run.status}`, reason);
    }
    async requireRun(runId) {
        const run = await this.store.getAutopilotRun(runId);
        if (!run) {
            throw new Error(`Unknown autopilot runId: ${runId}`);
        }
        return run;
    }
    async updateRun(runId, updater) {
        return await this.store.updateAutopilotRun(runId, updater);
    }
    async beginActiveRuntime(runId) {
        const now = this.now();
        await this.updateRun(runId, (existing) => {
            if (existing.status !== "running" && existing.status !== "queued") {
                return existing;
            }
            if (existing.activeRuntimeStartedAt) {
                return { ...existing, activeRuntimeMs: existing.activeRuntimeMs ?? 0 };
            }
            return {
                ...existing,
                activeRuntimeMs: existing.activeRuntimeMs ?? 0,
                activeRuntimeStartedAt: now
            };
        });
    }
    async endActiveRuntimeIfIdle(runId) {
        const run = await this.store.getAutopilotRun(runId);
        if (!run || shouldKeepActiveRuntimeOpen(run)) {
            return;
        }
        await this.updateRun(runId, (existing) => accrueActiveRuntime(existing, this.now()));
    }
    async recalculateActiveRuntimeMs(run) {
        const taskIds = new Set([
            run.currentTaskId,
            run.lastCompletedTaskId,
            ...run.queue.map((item) => item.taskId)
        ].filter((taskId) => Boolean(taskId)));
        const tasks = await this.store.listTasks();
        let total = estimateTimelineActiveRuntime(run);
        for (const task of tasks) {
            if (!taskIds.has(task.id)) {
                continue;
            }
            total += intervalMs(task.build.startedAt, task.build.endedAt);
            total += intervalMs(task.review?.startedAt, task.review?.endedAt);
        }
        return total;
    }
}
function pauseRun(run, reason, at, status = "paused") {
    const accrued = accrueActiveRuntime(run, at);
    return {
        ...accrued,
        status,
        phase: "paused",
        pausedAt: at,
        pauseReason: reason,
        timeline: appendTimeline(accrued, at, "status", reason)
    };
}
function shouldKeepScheduling(run) {
    return run.status === "running" || run.status === "queued";
}
export function runtimeSnapshot(run, at = new Date().toISOString()) {
    const base = run.activeRuntimeMs ?? 0;
    const active = run.activeRuntimeStartedAt ? base + intervalMs(run.activeRuntimeStartedAt, at) : base;
    const wallClockElapsedMs = Math.max(0, Date.parse(at) - Date.parse(run.startedAt));
    const runtimeLimitMs = run.limits.maxRuntimeMs;
    return {
        activeRuntimeMs: active,
        wallClockElapsedMs,
        runtimeLimitMs,
        remainingActiveRuntimeMs: Math.max(0, runtimeLimitMs - active),
        ...(run.activeRuntimeStartedAt ? { activeRuntimeStartedAt: run.activeRuntimeStartedAt } : {})
    };
}
function accrueActiveRuntime(run, at) {
    if (!run.activeRuntimeStartedAt) {
        return { ...run, activeRuntimeMs: run.activeRuntimeMs ?? 0 };
    }
    return {
        ...run,
        activeRuntimeMs: (run.activeRuntimeMs ?? 0) + intervalMs(run.activeRuntimeStartedAt, at),
        activeRuntimeStartedAt: undefined
    };
}
function shouldKeepActiveRuntimeOpen(run) {
    return ((run.status === "running" || run.status === "queued") &&
        ["building", "reviewing", "fixing", "finalizing", "consulting-architect"].includes(run.phase));
}
function estimateTimelineActiveRuntime(run) {
    const events = [...run.timeline].sort((left, right) => left.at.localeCompare(right.at));
    let activeStartedAt = run.startedAt;
    let total = 0;
    for (const event of events) {
        if (/Autopilot run resumed|started by explicit user request/i.test(event.summary)) {
            activeStartedAt = event.at;
            continue;
        }
        if (!activeStartedAt) {
            continue;
        }
        if (isTimelineActiveStop(event)) {
            total += intervalMs(activeStartedAt, event.at);
            activeStartedAt = undefined;
        }
    }
    return total;
}
function isTimelineActiveStop(event) {
    return (event.kind === "manager-decision" ||
        /Manager API|manager_api_|manager_decision_invalid|Manager runtime budget reached|Paused|requires manual approval|reviewed and finalized|ended with status/i.test(event.summary));
}
function intervalMs(start, end) {
    if (!start || !end) {
        return 0;
    }
    const delta = Date.parse(end) - Date.parse(start);
    return Number.isFinite(delta) && delta > 0 ? delta : 0;
}
function appendTimeline(run, at, kind, summary, data) {
    return [...run.timeline, { at, kind, summary, ...(data ? { data } : {}) }];
}
function markQueueTaskCompleted(queue, taskId, at) {
    return queue.map((item) => (item.taskId === taskId ? { ...item, status: "completed", updatedAt: at } : item));
}
function launchQueuedTaskRunState(run, queueItem, taskId, lease, at) {
    return {
        ...run,
        phase: "building",
        currentTaskId: taskId,
        tasksStarted: run.tasksStarted + 1,
        recoveryAttemptsByTaskId: queueItem.source === "recovery" && queueItem.fixAttemptForTaskId
            ? {
                ...(run.recoveryAttemptsByTaskId ?? {}),
                [queueItem.fixAttemptForTaskId]: ((run.recoveryAttemptsByTaskId ?? {})[queueItem.fixAttemptForTaskId] ?? 0) + 1
            }
            : run.recoveryAttemptsByTaskId,
        queue: run.queue.map((item) => (item.id === queueItem.id ? { ...item, status: "active", taskId, updatedAt: at } : item)),
        workers: [...(run.workers ?? []), lease],
        scheduler: {
            ...(run.scheduler ?? {}),
            dispatchStatus: "dispatched",
            lastDispatchOutcome: `${queueItem.source} task ${taskId} dispatched from queue item ${queueItem.id}.`,
            skippedDispatchReason: run.scheduler?.skippedDispatchReason
        },
        timeline: appendTimeline(run, at, queueItem.source === "recovery" ? "status" : "builder-summary", `${queueItem.source === "recovery" ? "Operational recovery" : "Started task"} ${taskId}: ${queueItem.title}`, { queueItemId: queueItem.id, source: queueItem.source, originalTaskId: queueItem.fixAttemptForTaskId })
    };
}
function createWorkerLease(options) {
    return {
        id: `lease-${randomUUID().slice(0, 8)}`,
        runId: options.runId,
        taskId: options.taskId,
        phase: options.phase,
        command: options.command,
        startedAt: options.startedAt,
        attemptType: options.attemptType,
        reportPath: options.reportPath,
        expectedArtifact: options.expectedArtifact,
        lastActivityAt: options.startedAt,
        status: "active"
    };
}
function markWorkerLeases(leases, taskId, status, at, outcome) {
    return (leases ?? []).map((lease) => lease.taskId === taskId && lease.status === "active"
        ? { ...lease, status, endedAt: at, lastActivityAt: at, outcome }
        : lease);
}
function isOperationalRecoveryDecision(decision) {
    const text = [decision.summary, decision.reason ?? ""].join("\n");
    return /\b(restart|missing terminal|terminal build status|lost|tracked build status|process tracking|pid)\b/i.test(text);
}
function isOperationalWorkerLoss(task) {
    const text = [task.build.error, task.review?.error].filter(Boolean).join("\n");
    return /\b(pid|terminal event|process was not successfully tracked|no longer running|missing terminal)\b/i.test(text);
}
function defaultProcessExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
function createBriefId() {
    return `brief-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
function createRunId() {
    return `autopilot-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
function positiveInt(value, fallback) {
    if (value === undefined || value.trim() === "") {
        return fallback;
    }
    if (!/^\d+$/.test(value.trim())) {
        throw new Error(`Invalid positive integer environment value: ${value}`);
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid positive integer environment value: ${value}`);
    }
    return parsed;
}
function managerPrompt(context) {
    return [
        "You are Project Pilot Manager Mode. Return only JSON matching the allowed decision schema.",
        "Choose one bounded action. Do not provide shell commands.",
        `Valid actions: ${MANAGER_DECISION_ACTIONS.join(", ")}`,
        "Task finalization must use finalize_current_task with taskId. Project completion must use finalize_project.",
        "Duplicate queued task cancellation must use skip_duplicate_task with taskId and reason.",
        `Project: ${context.project.name}`,
        `Brief: ${context.brief.title}`,
        `Git policy: ${context.gitPolicy}`,
        `Plan: ${context.plan ? `${context.plan.planId} (${context.plan.status}) - ${context.plan.summary}` : "No approved plan attached."}`,
        `Run status: ${context.run.status}, phase: ${context.run.phase}`,
        `Queue length: ${context.run.queue.filter((item) => item.status === "queued").length}`,
        `Decisions used: ${context.run.decisionsUsed}/${context.run.limits.maxManagerDecisions}`,
        `Requirements:\n${context.brief.requirements}`,
        `Definition of done:\n${context.brief.definitionOfDone.join("\n")}`,
        `Recent project tasks:\n${JSON.stringify(context.projectTasks, null, 2)}`,
        `Latest build report:\n${context.reports.buildReport ?? "None"}`,
        `Latest review report:\n${context.reports.reviewReport ?? "None"}`,
        `Plan report:\n${context.plan?.report ?? "None"}`,
        `Canonical decision schema:\n${JSON.stringify(MANAGER_DECISION_JSON_SCHEMA, null, 2)}`,
        `Valid example:\n${JSON.stringify({
            action: "finalize_current_task",
            summary: "Finalize the independently reviewed safe foundation task.",
            reason: null,
            taskId: "task-2026-06-25T01-36-32-141Z-5873a120",
            tasks: null,
            fixTask: null
        }, null, 2)}`,
        context.correction
            ? `Your previous response was invalid. Return one corrected JSON object only.\nValidation diagnostics:\n${context.correction.validationDiagnostics}\nInvalid response preview:\n${context.correction.invalidResponsePreview}`
            : ""
    ].join("\n\n");
}
function normalizeManagerCandidate(value) {
    if (isManagerCandidateEnvelope(value)) {
        return value;
    }
    return {
        candidate: value,
        diagnostics: managerCandidateDiagnostics("manager_adapter", null, value)
    };
}
function isManagerCandidateEnvelope(value) {
    return (typeof value === "object" &&
        value !== null &&
        "candidate" in value &&
        "diagnostics" in value &&
        typeof value.diagnostics === "object");
}
function extractOpenAIManagerCandidate(response) {
    if (response?.status === "incomplete") {
        throw new Error(`manager_response_incomplete: ${response.incomplete_details?.reason ?? "unknown reason"}`);
    }
    if (response?.status === "failed") {
        throw new Error(`manager_response_failed: ${response.error?.message ?? "unknown error"}`);
    }
    const selected = selectStructuredOutputItem(response);
    if (!selected) {
        throw new Error("manager_response_incomplete: no final assistant structured-output payload was found.");
    }
    if (selected.refusal) {
        throw new Error(`manager_response_refusal: ${selected.text}`);
    }
    let candidate;
    try {
        candidate = JSON.parse(selected.text);
    }
    catch (error) {
        throw new Error(`manager_response_invalid_json: ${errorMessage(error)}`);
    }
    return {
        candidate,
        diagnostics: managerCandidateDiagnostics("openai_responses", selected.item, candidate)
    };
}
function selectStructuredOutputItem(response) {
    const output = Array.isArray(response?.output) ? response.output : [];
    for (const item of [...output].reverse()) {
        if (item?.type === "reasoning") {
            continue;
        }
        if (item?.type === "message") {
            const content = Array.isArray(item.content) ? item.content : [];
            for (const part of [...content].reverse()) {
                if (part?.type === "output_refusal" || typeof part?.refusal === "string") {
                    return { text: String(part.refusal ?? "refused"), item, refusal: true };
                }
                if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
                    return { text: part.text, item, refusal: false };
                }
            }
        }
        if (item?.type === "function_call" && typeof item.arguments === "string" && item.arguments.trim()) {
            return { text: item.arguments, item, refusal: false };
        }
    }
    if (typeof response?.output_text === "string" && response.output_text.trim()) {
        return { text: response.output_text, item: { output_text: response.output_text }, refusal: false };
    }
    return undefined;
}
function managerCandidateDiagnostics(source, selectedOutputItem, candidate) {
    const record = typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) ? candidate : {};
    return {
        source,
        selectedOutputItemPreview: selectedOutputItem === null ? null : previewValue(selectedOutputItem),
        candidatePreview: previewValue(candidate),
        receivedAction: typeof record.action === "string" ? record.action : null,
        missingFields: ["action", "summary", "reason", "taskId", "tasks", "fixTask"].filter((field) => !(field in record))
    };
}
function parseManagerDecision(value) {
    try {
        return { ok: true, decision: validateManagerDecision(value) };
    }
    catch (error) {
        return { ok: false, error };
    }
}
function formatDecisionValidationError(error) {
    if (error instanceof z.ZodError) {
        return error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ");
    }
    return errorMessage(error);
}
function previewValue(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return conciseText(redactSensitiveText(text ?? String(value)));
}
function managerApiFailureReason(error) {
    const message = errorMessage(error);
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
    if (status === 429 || /\b429\b|quota|rate limit/i.test(message)) {
        return `manager_api_quota_error: ${message}`;
    }
    return `manager_api_error: ${message}`;
}
function conciseText(value) {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > 1_000 ? `${text.slice(0, 997)}...` : text;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function redactSensitiveText(text) {
    return text
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
        .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]");
}
function assertNever(value) {
    throw new Error(`Unhandled manager decision action: ${value}`);
}
export function projectHasRiskyRequirements(brief) {
    const fakeTask = {
        id: "task-2026-06-24T00-00-00-000Z-aaaaaaaa",
        title: brief.title,
        requirements: brief.requirements,
        acceptanceCriteria: brief.definitionOfDone,
        status: "queued",
        createdAt: brief.createdAt,
        updatedAt: brief.updatedAt,
        build: { status: "queued", logPath: "unused" }
    };
    return evaluateApprovalPolicy({ task: fakeTask, buildReport: null, reviewReport: null }).riskFlags.length > 0;
}
