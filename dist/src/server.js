import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { JobService } from "./jobs.js";
import { AutopilotService, managerConfigurationStatus, runtimeSnapshot } from "./manager.js";
import { buildReadinessSummary } from "./readiness.js";
import { getProjectStatus } from "./status.js";
import { renderDashboardHtml } from "./dashboard.js";
import { WindowsAutopilotNotifier } from "./notifications.js";
import { ALLOWLISTED_PROJECT_ROOT, DATA_DIR, PROJECTS_FILE, buildReportFile, dataPath, reviewReportFile, taskBuildReportFile, taskReviewReportFile } from "./paths.js";
import { StateStore } from "./state.js";
import { CODEX_ACCESS_MODE, CODEX_ACCESS_WARNING, CODEX_APPROVAL_POLICY } from "./codex.js";
import { readLogTail, readTextIfExists } from "./logs.js";
import { evaluateApprovalPolicy, projectVerificationCommands } from "./approval-policy.js";
import { DEFAULT_PROJECT_ID } from "./projects.js";
import { deriveTaskStatus } from "./task-status.js";
import { buildAutopilotAuditSummary } from "./audit.js";
import { taskArtifactRoot } from "./execution.js";
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = strictPort(process.env.PORT ?? "3000");
if (HOST !== "127.0.0.1") {
    throw new Error("Project Pilot is local-only. HOST must be 127.0.0.1.");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
}
const store = new StateStore();
const jobs = new JobService(store);
const autopilot = new AutopilotService({ store, jobs, notifier: new WindowsAutopilotNotifier() });
const NOAUTH_SECURITY_SCHEMES = [{ type: "noauth" }];
const DASHBOARD_ENDPOINT_TIMEOUT_MS = 1_500;
const MAX_DASHBOARD_TASKS = 200;
const MAX_DASHBOARD_PLANS = 100;
const MAX_DASHBOARD_RUNS = 100;
function jsonToolResult(value) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(value, null, 2)
            }
        ]
    };
}
function withNoAuthSecuritySchemes(result) {
    return {
        ...result,
        tools: result.tools.map((tool) => ({
            ...tool,
            securitySchemes: NOAUTH_SECURITY_SCHEMES,
            _meta: {
                ...tool._meta,
                securitySchemes: NOAUTH_SECURITY_SCHEMES
            }
        }))
    };
}
function installNoAuthToolsListHandler(server) {
    const protocol = server.server;
    const originalToolsListHandler = protocol._requestHandlers.get("tools/list");
    if (!originalToolsListHandler) {
        throw new Error("MCP tools/list handler was not installed.");
    }
    server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        const result = await originalToolsListHandler(request, extra);
        return withNoAuthSecuritySchemes(result);
    });
}
export function createServer() {
    const server = new McpServer({
        name: "Project Pilot",
        version: "0.1.0"
    });
    server.registerTool("create_project_brief", {
        title: "Create Project Brief",
        description: "Persist a durable project brief. ChatGPT can synthesize this from the current conversation when the user says Start Autopilot.",
        inputSchema: {
            projectId: z.string().trim().min(1).max(80),
            title: z.string().trim().min(1).max(160),
            productSummary: z.string().trim().min(1).max(20_000),
            requirements: z.string().trim().min(1).max(30_000),
            constraints: z.string().trim().min(1).max(20_000),
            decisions: z.array(z.string().trim().min(1).max(2_000)).max(50),
            definitionOfDone: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
            planId: z.string().trim().min(1).max(80).optional()
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await autopilot.createProjectBrief(input)));
    server.registerTool("get_project_brief", {
        title: "Get Project Brief",
        description: "Return a durable Project Pilot project brief by briefId.",
        inputSchema: {
            briefId: z.string().trim().min(1).max(100)
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ briefId }) => jsonToolResult(await autopilot.getProjectBrief(briefId)));
    server.registerTool("list_project_briefs", {
        title: "List Project Briefs",
        description: "Return durable Project Pilot project briefs.",
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async () => jsonToolResult(await autopilot.listProjectBriefs()));
    server.registerTool("start_autopilot", {
        title: "Start Autopilot",
        description: "Start an explicit Manager Mode autopilot run from a project brief. This never starts automatically just because a brief exists.",
        inputSchema: {
            projectId: z.string().trim().min(1).max(80).optional(),
            briefId: z.string().trim().min(1).max(100),
            planId: z.string().trim().min(1).max(80).optional(),
            limits: z
                .object({
                maxManagerDecisions: z.number().int().positive().optional(),
                maxTasks: z.number().int().positive().optional(),
                maxFixAttemptsPerTask: z.number().int().nonnegative().optional(),
                maxRuntimeMs: z.number().int().positive().optional()
            })
                .optional()
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await autopilot.startAutopilot(input)));
    server.registerTool("get_autopilot_status", {
        title: "Get Autopilot Status",
        description: "Return a Project Pilot Manager Mode autopilot run status.",
        inputSchema: {
            runId: z.string().trim().min(1).max(120)
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ runId }) => jsonToolResult(await autopilot.getAutopilotStatus(runId)));
    server.registerTool("update_autopilot_limits", {
        title: "Update Autopilot Limits",
        description: "Update limits for an existing Project Pilot Autopilot run. Requires an explicit runId and explicit values; never creates runs, briefs, plans, tasks, or workers.",
        inputSchema: {
            runId: z.string().trim().min(1).max(120),
            reason: z.string().trim().min(1).max(2_000),
            maxRuntimeMs: z.number().int().positive().optional(),
            maxManagerDecisions: z.number().int().positive().optional(),
            maxTasks: z.number().int().positive().optional(),
            maxFixAttemptsPerTask: z.number().int().nonnegative().optional()
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await autopilot.updateAutopilotLimits(input)));
    server.registerTool("pause_autopilot", {
        title: "Pause Autopilot",
        description: "Pause a running Project Pilot Manager Mode autopilot run.",
        inputSchema: {
            runId: z.string().trim().min(1).max(120),
            reason: z.string().trim().min(1).max(2_000).optional()
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ runId, reason }) => jsonToolResult(await autopilot.pauseAutopilot(runId, reason)));
    server.registerTool("resume_autopilot", {
        title: "Resume Autopilot",
        description: "Resume a paused Project Pilot Manager Mode autopilot run.",
        inputSchema: {
            runId: z.string().trim().min(1).max(120)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ runId }) => jsonToolResult(await autopilot.resumeAutopilot(runId)));
    server.registerTool("stop_autopilot", {
        title: "Stop Autopilot",
        description: "Stop a Project Pilot Manager Mode autopilot run.",
        inputSchema: {
            runId: z.string().trim().min(1).max(120),
            reason: z.string().trim().min(1).max(2_000).optional()
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ runId, reason }) => jsonToolResult(await autopilot.stopAutopilot(runId, reason)));
    server.registerTool("list_projects", {
        title: "List Projects",
        description: "Return registered local Project Pilot projects and the active project.",
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async () => jsonToolResult(await jobs.listProjects()));
    server.registerTool("get_project", {
        title: "Get Project",
        description: "Return one registered Project Pilot project by projectId.",
        inputSchema: {
            projectId: z.string().trim().min(1).max(80)
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ projectId }) => jsonToolResult(await jobs.getProject(projectId)));
    server.registerTool("register_project", {
        title: "Register Project",
        description: "Register or update an approved local project path for Project Pilot.",
        inputSchema: {
            id: z.string().trim().min(1).max(80),
            name: z.string().trim().min(1).max(160),
            path: z.string().trim().min(1).max(1_000),
            gitRemoteName: z.string().trim().min(1).max(80).optional(),
            buildCommand: z.string().trim().min(1).max(500),
            testCommand: z.string().trim().min(1).max(500),
            checkCommand: z.string().trim().min(1).max(500),
            defaultBranchName: z.string().trim().min(1).max(120),
            allowedGitBehavior: z.string().trim().min(1).max(2_000)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await jobs.registerProject(input)));
    server.registerTool("configure_maintenance_execution", {
        title: "Configure Maintenance Execution",
        description: "Configure and validate maintenance execution for a registered project. Enabled maintenance requires an isolated Git worktree on the expected branch before saving.",
        inputSchema: {
            projectId: z.string().trim().min(1).max(80),
            enabled: z.boolean(),
            liveRoot: z.string().trim().min(1).max(1_000).optional(),
            executionRoot: z.string().trim().min(1).max(1_000).optional(),
            baseBranch: z.string().trim().min(1).max(120).optional(),
            expectedBranch: z.string().trim().min(1).max(120).optional(),
            allowDirtyWorkingTree: z.boolean().optional(),
            dirtyWorkingTreeReason: z.string().trim().min(1).max(2_000).optional()
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await jobs.configureMaintenanceExecution(input)));
    server.registerTool("set_active_project", {
        title: "Set Active Project",
        description: "Set the default registered project used by Project Pilot.",
        inputSchema: {
            projectId: z.string().trim().min(1).max(80)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ projectId }) => jsonToolResult(await jobs.setActiveProject(projectId)));
    server.registerTool("get_active_project", {
        title: "Get Active Project",
        description: "Return the active Project Pilot project.",
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async () => jsonToolResult(await jobs.getActiveProject()));
    server.registerTool("get_project_status", {
        title: "Get Project Status",
        description: "Read current task status, recent build log summary, git status, and test status for the active registered project.",
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async () => {
        return jsonToolResult(await getProjectStatus());
    });
    server.registerTool("start_build", {
        title: "Start Build",
        description: "Write TASK.md and start a background Codex build for a registered project.",
        inputSchema: {
            projectId: z.string().trim().min(1).max(80).optional(),
            title: z.string().trim().min(1).max(160),
            requirements: z.string().trim().min(1).max(20_000),
            acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(25)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await jobs.startBuild(input)));
    server.registerTool("start_plan", {
        title: "Start Plan",
        description: "Start a read-only Codex planning pass for a registered project.",
        inputSchema: {
            projectId: z.string().trim().min(1).max(80),
            title: z.string().trim().min(1).max(160),
            requirements: z.string().trim().min(1).max(20_000),
            constraints: z.string().trim().min(1).max(10_000)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await jobs.startPlan(input)));
    server.registerTool("list_plans", {
        title: "List Plans",
        description: "Return Project Pilot plans with status, project, timestamps, and concise summary.",
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async () => jsonToolResult(await jobs.listPlans()));
    server.registerTool("get_plan_status", {
        title: "Get Plan Status",
        description: "Return lifecycle status, PID, timestamps, exit code, error, and latest planning log lines.",
        inputSchema: {
            planId: z.string().trim().min(1).max(80)
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ planId }) => jsonToolResult(await jobs.getPlanStatus(planId)));
    server.registerTool("get_plan_details", {
        title: "Get Plan Details",
        description: "Return PLAN_REPORT.md, requirements, constraints, status history, log tail, and errors.",
        inputSchema: {
            planId: z.string().trim().min(1).max(80)
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ planId }) => jsonToolResult(await jobs.getPlanDetails(planId)));
    server.registerTool("create_task_from_plan", {
        title: "Create Task From Plan",
        description: "Create a queued implementation task from a plan-ready Project Pilot plan without starting implementation.",
        inputSchema: {
            planId: z.string().trim().min(1).max(80),
            title: z.string().trim().min(1).max(160).optional(),
            requirements: z.string().trim().min(1).max(20_000).optional(),
            acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(25).optional()
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await jobs.createTaskFromPlan(input)));
    server.registerTool("get_build_status", {
        title: "Get Build Status",
        description: "Return build status, concise log tail, and BUILD_REPORT.md when available.",
        inputSchema: {
            taskId: z.string().trim().min(1).max(80)
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ taskId }) => jsonToolResult(await jobs.getBuildStatus(taskId)));
    server.registerTool("list_tasks", {
        title: "List Tasks",
        description: "Return current Project Pilot tasks and task-level statuses.",
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async () => jsonToolResult(await jobs.listTasks()));
    server.registerTool("run_review", {
        title: "Run Review",
        description: "Run a read-only Codex review and write REVIEW_REPORT.md from the captured report.",
        inputSchema: {
            taskId: z.string().trim().min(1).max(80)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ taskId }) => jsonToolResult(await jobs.runReview(taskId)));
    server.registerTool("approve_task", {
        title: "Approve Task",
        description: "Manually approve a ready-for-approval task after reviewing any cited risk evidence. This does not commit, push, merge, deploy, or modify the target project.",
        inputSchema: {
            taskId: z.string().trim().min(1).max(80),
            reason: z.string().trim().min(1).max(2000),
            reviewedRiskEvidence: z.boolean().optional()
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await jobs.approveTask(input)));
    server.registerTool("decline_task", {
        title: "Decline Task Approval",
        description: "Decline approval for a ready-for-approval task, keep the run paused, and preserve all work and audit history.",
        inputSchema: {
            taskId: z.string().trim().min(1).max(80),
            reason: z.string().trim().min(1).max(2000)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async (input) => jsonToolResult(await jobs.declineTaskApproval(input)));
    server.registerTool("finalize_task", {
        title: "Finalize Task",
        description: "Automatically complete an eligible safe task, or return manual_approval_required with exact reasons.",
        inputSchema: {
            taskId: z.string().trim().min(1).max(80)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ taskId }) => jsonToolResult(await jobs.finalizeTask(taskId)));
    server.registerTool("stop_task", {
        title: "Stop Task",
        description: "Stop only a tracked active Project Pilot build or review process for a task.",
        inputSchema: {
            taskId: z.string().trim().min(1).max(80)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ taskId }) => jsonToolResult(await jobs.stopTask(taskId)));
    server.registerTool("retry_review", {
        title: "Retry Review",
        description: "Retry a review only after a passed build and a blocked, failed, or needs-fixes prior review.",
        inputSchema: {
            taskId: z.string().trim().min(1).max(80)
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        },
        _meta: {
            securitySchemes: NOAUTH_SECURITY_SCHEMES
        }
    }, async ({ taskId }) => jsonToolResult(await jobs.retryReview(taskId)));
    installNoAuthToolsListHandler(server);
    return server;
}
export function createApp(jobService = jobs, autopilotService = autopilot, stateStore = store, options = {}) {
    const app = express();
    if (options.reconcileOnStart ?? true) {
        void jobService.reconcileUnfinishedTasks();
        void autopilotService.reconcileAndResume();
    }
    app.use(express.json({ limit: "1mb" }));
    app.use((req, res, next) => {
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
            res.status(403).json({ error: "Project Pilot is local-only." });
            return;
        }
        next();
    });
    app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
        res.status(404).json({ error: "OAuth metadata is not available for this local connector." });
    });
    app.get("/dashboard", (_req, res) => {
        res.type("html").send(renderDashboardHtml());
    });
    app.get("/dashboard/tasks", async (_req, res) => {
        await sendDashboardJson(res, "tasks", async () => ({
            tasks: (await dashboardSnapshot(stateStore)).tasks
        }));
    });
    app.get("/dashboard/tasks/:taskId", async (req, res) => {
        try {
            res.json(await dashboardTaskDetails(stateStore, req.params.taskId));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            res.status(message.includes("Unknown taskId") ? 404 : 400).json({ error: message });
        }
    });
    app.get("/dashboard/plans", async (_req, res) => {
        await sendDashboardJson(res, "plans", async () => ({
            plans: (await dashboardSnapshot(stateStore)).plans
        }));
    });
    app.get("/dashboard/plans/:planId", async (req, res) => {
        try {
            res.json(await dashboardPlanDetails(stateStore, req.params.planId));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            res.status(message.includes("Unknown planId") ? 404 : 400).json({ error: message });
        }
    });
    app.get("/dashboard/configuration", async (_req, res) => {
        await sendDashboardJson(res, "configuration", async () => await dashboardConfigurationSnapshot());
    });
    app.get("/dashboard/state-health", async (_req, res) => {
        try {
            res.json(await stateStore.health());
        }
        catch (error) {
            res.status(500).json({ error: `Failed to inspect state health: ${errorMessage(error)}` });
        }
    });
    app.get("/dashboard/readiness", async (_req, res) => {
        try {
            const [configuration, stateHealth, snapshot] = await Promise.all([
                withTimeout(dashboardConfigurationSnapshot(), DASHBOARD_ENDPOINT_TIMEOUT_MS, "configuration"),
                withTimeout(stateStore.health(), DASHBOARD_ENDPOINT_TIMEOUT_MS, "state health"),
                withTimeout(dashboardSnapshot(stateStore), DASHBOARD_ENDPOINT_TIMEOUT_MS, "dashboard snapshot")
            ]);
            res.json(buildReadinessSummary({
                configuration,
                stateHealth,
                runs: snapshot.rawRuns,
                launcherState: readLocalLauncherState()
            }));
        }
        catch (error) {
            res.status(500).json({ error: `Failed to inspect readiness: ${errorMessage(error)}` });
        }
    });
    app.get("/dashboard/autopilot", async (_req, res) => {
        await sendDashboardJson(res, "autopilot runs", async () => ({
            runs: (await dashboardSnapshot(stateStore)).runs
        }));
    });
    app.get("/dashboard/core", async (_req, res) => {
        await sendDashboardJson(res, "core dashboard data", async () => {
            const snapshot = await dashboardSnapshot(stateStore);
            return {
                tasks: snapshot.tasks,
                plans: snapshot.plans,
                runs: snapshot.runs
            };
        });
    });
    app.get("/dashboard/autopilot/:runId", async (req, res) => {
        try {
            res.json(await dashboardAutopilotDetails(stateStore, req.params.runId));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            res.status(message.includes("Unknown autopilot") ? 404 : 400).json({ error: message });
        }
    });
    app.post("/dashboard/autopilot/:runId/pause", async (req, res) => {
        try {
            res.json(await autopilotService.pauseAutopilot(req.params.runId, "Paused from dashboard."));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            res.status(message.includes("Unknown autopilot") ? 404 : 400).json({ error: message });
        }
    });
    app.post("/dashboard/autopilot/:runId/resume", async (req, res) => {
        try {
            res.json(await autopilotService.resumeAutopilot(req.params.runId));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            res.status(message.includes("Unknown autopilot") ? 404 : 400).json({ error: message });
        }
    });
    app.post("/dashboard/autopilot/:runId/stop", async (req, res) => {
        try {
            res.json(await autopilotService.stopAutopilot(req.params.runId, "Stopped from dashboard."));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            res.status(message.includes("Unknown autopilot") ? 404 : 400).json({ error: message });
        }
    });
    app.post("/dashboard/tasks/:taskId/approve", async (req, res) => {
        try {
            res.json(await jobService.approveTask({
                taskId: req.params.taskId,
                reason: String(req.body?.reason ?? "").trim(),
                reviewedRiskEvidence: Boolean(req.body?.reviewedRiskEvidence)
            }));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            res.status(message.includes("Unknown taskId") ? 404 : 400).json({ error: message });
        }
    });
    app.post("/dashboard/tasks/:taskId/decline", async (req, res) => {
        try {
            res.json(await jobService.declineTaskApproval({
                taskId: req.params.taskId,
                reason: String(req.body?.reason ?? "").trim()
            }));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            res.status(message.includes("Unknown taskId") ? 404 : 400).json({ error: message });
        }
    });
    app.post("/dashboard/tasks/:taskId/finalize", async (req, res) => {
        try {
            res.json(await jobService.finalizeTask(req.params.taskId));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            res.status(message.includes("Unknown taskId") ? 404 : 400).json({ error: message });
        }
    });
    app.post("/mcp", async (req, res) => {
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            console.error("Error handling MCP request:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32603,
                        message: "Internal server error"
                    },
                    id: null
                });
            }
        }
        finally {
            res.on("close", () => {
                void transport.close();
                void server.close();
            });
        }
    });
    app.get("/mcp", (_req, res) => {
        res.status(405).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null
        });
    });
    app.delete("/mcp", (_req, res) => {
        res.status(405).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null
        });
    });
    return app;
}
function isLoopbackAddress(address) {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
async function sendDashboardJson(res, label, producer) {
    try {
        res.json(await withTimeout(producer(), DASHBOARD_ENDPOINT_TIMEOUT_MS, label));
    }
    catch (error) {
        const timedOut = error instanceof DashboardTimeoutError;
        res.status(timedOut ? 503 : 500).json({
            error: timedOut
                ? `Dashboard ${label} snapshot timed out after ${DASHBOARD_ENDPOINT_TIMEOUT_MS} ms.`
                : `Failed to refresh dashboard ${label}: ${errorMessage(error)}`
        });
    }
}
class DashboardTimeoutError extends Error {
    constructor(label, timeoutMs) {
        super(`${label} timed out after ${timeoutMs} ms.`);
    }
}
async function withTimeout(promise, timeoutMs, label) {
    let timeout;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timeout = setTimeout(() => reject(new DashboardTimeoutError(label, timeoutMs)), timeoutMs);
            })
        ]);
    }
    finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}
async function dashboardSnapshot(stateStore) {
    const [state, projects] = await Promise.all([stateStore.read(), readDashboardProjects()]);
    const taskRecords = latestRecords(state.tasks, MAX_DASHBOARD_TASKS);
    const planRecords = latestRecords(state.plans ?? [], MAX_DASHBOARD_PLANS);
    const rawRuns = latestRecords(state.autopilotRuns ?? [], MAX_DASHBOARD_RUNS).map((run) => ({
        ...run,
        audit: buildAutopilotAuditSummary(run)
    }));
    const taskSummaries = await Promise.all(taskRecords.map((task) => dashboardTaskSummary(task, projects)));
    const taskSummaryById = new Map(taskSummaries.map((task) => [task.taskId, task]));
    const planSummaries = await Promise.all(planRecords.map((plan) => dashboardPlanSummary(plan, projects)));
    return {
        tasks: taskSummaries.map(toDashboardTask),
        plans: planSummaries.map(toDashboardPlan),
        rawRuns,
        runs: await Promise.all(rawRuns.map((run) => toDashboardAutopilotRun(run, taskSummaryById.get(run.currentTaskId ?? ""))))
    };
}
async function dashboardConfigurationSnapshot() {
    const projects = await readDashboardProjects();
    return {
        ...managerConfigurationStatus(),
        projects: [...projects.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((project) => ({
            projectId: project.id,
            projectName: project.name,
            maintenance: dashboardMaintenanceMetadata(project)
        }))
    };
}
function dashboardMaintenanceMetadata(project) {
    if (project.maintenance?.enabled) {
        return {
            enabled: true,
            mode: "maintenance/self-improvement",
            operatorMessage: "Project Pilot maintenance/self-improvement mode is active. Dashboard reads do not run Git preflight; worker launch actions still enforce maintenance protections.",
            liveRoot: project.maintenance.liveRoot,
            executionRoot: project.executionRoot ?? project.path,
            baseBranch: project.maintenance.baseBranch,
            expectedBranch: project.maintenance.expectedBranch,
            manualHandoff: {
                required: true,
                message: "Review the isolated worktree manually before any commit, push, merge, deploy, or live-checkout update."
            },
            preflight: {
                ok: null,
                readOnly: true,
                skipped: true,
                reason: "Dashboard configuration reads do not run Git preflight."
            },
            canStart: null,
            cannotStartReason: null
        };
    }
    return {
        enabled: false,
        mode: "normal",
        operatorMessage: "Maintenance/self-improvement mode is not enabled for this project. Dashboard reads do not run Git preflight.",
        liveRoot: project.path,
        executionRoot: project.executionRoot ?? project.path,
        baseBranch: project.defaultBranchName,
        expectedBranch: null,
        manualHandoff: {
            required: false,
            message: "No maintenance handoff is active."
        },
        preflight: {
            ok: null,
            readOnly: true,
            skipped: true,
            reason: "Dashboard configuration reads do not run Git preflight."
        },
        canStart: null,
        cannotStartReason: null
    };
}
async function dashboardTaskDetails(stateStore, taskId) {
    const [state, projects] = await Promise.all([stateStore.read(), readDashboardProjects()]);
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
        throw new Error(`Unknown taskId: ${taskId}`);
    }
    const project = projectForDashboardTask(task, projects);
    const summary = await dashboardTaskSummary(task, projects);
    const buildReportPath = taskBuildReportFile(taskArtifactRoot(project), task.id);
    const reviewReportPath = taskReviewReportFile(taskArtifactRoot(project), task.id);
    const legacyBuildReportPath = buildReportFile(taskArtifactRoot(project));
    const legacyReviewReportPath = reviewReportFile(taskArtifactRoot(project));
    const runId = findRunForTask(state, task.id)?.id ?? null;
    const details = {
        ...summary,
        requirements: task.requirements,
        acceptanceCriteria: task.acceptanceCriteria,
        statusHistory: buildStatusHistorySnapshot(task),
        errors: collectTaskErrors(task),
        buildLog: (await readTextIfExists(task.build.logPath).catch(() => undefined)) ?? "",
        reviewLog: task.review?.logPath ? (await readTextIfExists(task.review.logPath).catch(() => undefined)) ?? "" : "",
        buildReport: (await readTextIfExists(buildReportPath).catch(() => undefined)) ??
            (await readTextIfExists(legacyBuildReportPath).catch(() => undefined)) ??
            null,
        reviewReport: (await readTextIfExists(reviewReportPath).catch(() => undefined)) ??
            (await readTextIfExists(legacyReviewReportPath).catch(() => undefined)) ??
            null,
        evidencePaths: {
            buildReport: buildReportPath,
            reviewReport: reviewReportPath,
            canonicalBuildReport: buildReportPath,
            canonicalReviewReport: reviewReportPath,
            legacyBuildReport: legacyBuildReportPath,
            legacyReviewReport: legacyReviewReportPath
        },
        verificationIdentity: {
            taskId: task.id,
            runId,
            executionRoot: taskArtifactRoot(project),
            branch: project.maintenance?.expectedBranch || project.defaultBranchName || "unknown"
        },
        verification: task.verification ?? [],
        verificationEvents: task.verificationEvents ?? [],
        approvalActions: task.approvalActions ?? []
    };
    return {
        ...details,
        ...classifyTaskSummary(details)
    };
}
async function dashboardPlanDetails(stateStore, planId) {
    const [state, projects] = await Promise.all([stateStore.read(), readDashboardProjects()]);
    const plan = (state.plans ?? []).find((candidate) => candidate.id === planId);
    if (!plan) {
        throw new Error(`Unknown planId: ${planId}`);
    }
    const summary = await dashboardPlanSummary(plan, projects);
    const log = (await readTextIfExists(plan.logPath).catch(() => undefined)) ?? "";
    return {
        ...summary,
        requirements: plan.requirements,
        constraints: plan.constraints,
        pid: plan.pid,
        startedAt: plan.startedAt,
        endedAt: plan.endedAt,
        exitCode: plan.exitCode,
        statusHistory: buildPlanStatusHistorySnapshot(plan),
        errors: [plan.error].filter((error) => Boolean(error)),
        logTail: log.split(/\r?\n/).filter(Boolean).slice(-40).join("\n"),
        report: (await readTextIfExists(plan.reportPath).catch(() => undefined)) ?? null,
        log
    };
}
async function dashboardAutopilotDetails(stateStore, runId) {
    const snapshot = await dashboardSnapshot(stateStore);
    const run = snapshot.rawRuns.find((candidate) => candidate.id === runId);
    if (!run) {
        throw new Error(`Unknown autopilot runId: ${runId}`);
    }
    const activeTask = snapshot.tasks.find((task) => task.taskId === run.currentTaskId);
    return await toDashboardAutopilotRunDetails(run, activeTask);
}
async function dashboardTaskSummary(task, projects) {
    const project = projectForDashboardTask(task, projects);
    const latestLogPath = task.review?.logPath ?? task.build.logPath;
    const latestLogTail = await readLogTail(latestLogPath, 12).catch(() => "");
    const configuredCommands = projectVerificationCommands(project);
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
            configuredCommands,
            verification: task.verification
        }),
        verificationStatus: verificationDisplayStatusSnapshot(task, configuredCommands),
        verificationSummary: summarizeVerificationSnapshot(task, configuredCommands),
        buildSummary: summarizeBuildSnapshot(task),
        reviewResult: task.review?.result ?? null,
        latestLogLines: latestLogTail ? latestLogTail.split(/\r?\n/) : []
    };
}
async function dashboardPlanSummary(plan, projects) {
    const project = projects.get(plan.projectId) ?? fallbackProject(plan.projectId);
    const [latestLogTail, report] = await Promise.all([
        readLogTail(plan.logPath, 12).catch(() => ""),
        readTextIfExists(plan.reportPath).catch(() => undefined)
    ]);
    return {
        planId: plan.id,
        projectId: project.id,
        projectName: project.name,
        title: plan.title,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        status: plan.status,
        summary: summarizePlanReportSnapshot(report),
        reportPath: plan.reportPath,
        error: plan.error,
        latestLogLines: latestLogTail ? latestLogTail.split(/\r?\n/) : []
    };
}
async function readDashboardProjects() {
    try {
        const raw = await fs.promises.readFile(PROJECTS_FILE, "utf8");
        const parsed = JSON.parse(raw);
        const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
        return new Map(projects.map((project) => [project.id, project]));
    }
    catch {
        return new Map([[DEFAULT_PROJECT_ID, fallbackProject(DEFAULT_PROJECT_ID)]]);
    }
}
function projectForDashboardTask(task, projects) {
    const projectId = task.projectId ?? DEFAULT_PROJECT_ID;
    return projects.get(projectId) ?? fallbackProject(projectId);
}
function fallbackProject(projectId) {
    return {
        id: projectId,
        name: projectId === DEFAULT_PROJECT_ID ? "Trade Journal Lite" : projectId,
        path: ALLOWLISTED_PROJECT_ROOT,
        buildCommand: "npm run build",
        testCommand: "npm test",
        checkCommand: "npm run check",
        defaultBranchName: "main",
        allowedGitBehavior: "feature branches, isolated worktrees, descriptive commits, non-protected branch pushes, and draft pull requests",
        createdAt: "",
        updatedAt: ""
    };
}
function latestRecords(records, limit) {
    return [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit);
}
function findRunForTask(state, taskId) {
    return (state.autopilotRuns ?? []).find((run) => run.currentTaskId === taskId || run.queue.some((item) => item.taskId === taskId || item.fixAttemptForTaskId === taskId));
}
function toDashboardTask(task) {
    const state = classifyTaskSummary(task);
    return {
        title: task.title,
        projectId: task.projectId,
        projectName: task.projectName,
        taskId: task.taskId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        status: task.status,
        codexAccessMode: task.codexAccessMode,
        codexApprovalPolicy: task.codexApprovalPolicy,
        codexAccessWarning: task.codexAccessWarning,
        approval: task.approval,
        verificationStatus: task.verificationStatus,
        verificationSummary: task.verificationSummary,
        buildSummary: task.buildSummary,
        reviewResult: task.reviewResult,
        latestLogPreview: summarizeLogPreview(task.latestLogLines),
        ...state
    };
}
function toDashboardPlan(plan) {
    return {
        planId: plan.planId,
        projectId: plan.projectId,
        projectName: plan.projectName,
        title: plan.title,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        status: plan.status,
        summary: plan.summary,
        reportPath: plan.reportPath,
        error: plan.error,
        latestLogPreview: summarizeLogPreview(plan.latestLogLines)
    };
}
async function toDashboardAutopilotRun(run, activeTask) {
    const workers = summarizeWorkers(run.workers ?? []);
    const queue = summarizeQueue(run.queue);
    return {
        id: run.id,
        projectId: run.projectId,
        briefId: run.briefId,
        planId: run.planId,
        status: run.status,
        phase: run.phase,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        pausedAt: run.pausedAt,
        pauseReason: safeExcerpt(run.pauseReason),
        stopReason: safeExcerpt(run.stopReason),
        completionSummary: safeExcerpt(run.completionSummary),
        currentTaskId: run.currentTaskId,
        lastCompletedTaskId: run.lastCompletedTaskId,
        nextAction: run.nextAction ?? null,
        decisionsUsed: run.decisionsUsed,
        tasksStarted: run.tasksStarted,
        queue,
        workers,
        scheduler: run.scheduler,
        limits: run.limits,
        recoveryAttemptsByTaskId: run.recoveryAttemptsByTaskId ?? {},
        queuedTasks: run.queue.filter((item) => item.status === "queued").length,
        currentTask: run.currentTaskId ?? null,
        codexThreadStatus: run.codexThreads.architectThreadId ? "architect thread active" : "no architect thread",
        runtime: runtimeSnapshot(run),
        limitPauseKind: limitPauseKind(run),
        activeTaskLogPreview: activeTask
            ? activeTask.latestLogLines
                ? summarizeLogPreview(activeTask.latestLogLines)
                : activeTask.latestLogPreview ?? []
            : [],
        activeTaskStatus: activeTask?.status ?? null,
        activeTaskBuildSummary: activeTask?.buildSummary ? (safeExcerpt(activeTask.buildSummary, 500) ?? null) : null,
        lastActivityAt: latestActivityAt(run),
        queueStateSummary: queueStateSummary(queue),
        workerStateSummary: workerStateSummary(workers),
        nextStepExplanation: nextStepExplanation(run),
        auditSummary: run.audit?.runStateExplanation,
        userActionRequired: run.audit?.userActionRequired
    };
}
async function toDashboardAutopilotRunDetails(run, activeTask) {
    const summary = await toDashboardAutopilotRun(run, activeTask);
    return {
        ...summary,
        decisions: run.decisions.slice(-10).map((decision) => ({
            at: decision.at,
            action: decision.action,
            summary: safeExcerpt(decision.summary, 500),
            reason: safeExcerpt(decision.reason, 500)
        })),
        timeline: summarizeTimeline(run.timeline),
        recoveryHistory: recoveryHistory(run),
        maintenance: run.maintenance,
        audit: run.audit
    };
}
function classifyTaskSummary(task) {
    const text = [task.buildSummary, ...task.latestLogLines].join("\n");
    if (task.status === "completed") {
        return {
            stateKind: "completed historical",
            stateLabel: "Completed / historical",
            stateExplanation: "Task passed build and review gates and was marked complete.",
            stateTags: ["completed", "historical"],
            historical: true
        };
    }
    if (task.status === "blocked") {
        return {
            stateKind: "blocked",
            stateLabel: "Blocked",
            stateExplanation: "Task is paused by a blocker or infrastructure failure that needs attention.",
            stateTags: ["blocked"],
            historical: false
        };
    }
    if (task.status === "stopped" && /duplicate|superseded|skipped|historical record/i.test(text)) {
        return {
            stateKind: "superseded skipped historical",
            stateLabel: "Superseded / skipped / historical",
            stateExplanation: "Task was skipped because another active, reviewed, or completed task covers the same work.",
            stateTags: ["superseded", "skipped", "historical"],
            historical: true
        };
    }
    if (task.status === "stopped") {
        return {
            stateKind: "stopped historical",
            stateLabel: "Stopped / historical",
            stateExplanation: "Task is no longer active and remains visible for audit history.",
            stateTags: ["stopped", "historical"],
            historical: true
        };
    }
    if (/recovered|recovery/i.test(text)) {
        return {
            stateKind: "recovered",
            stateLabel: "Recovered",
            stateExplanation: "Task has recovery evidence in its recorded activity.",
            stateTags: ["recovered"],
            historical: false
        };
    }
    const active = task.status === "queued" || task.status === "building" || task.status === "reviewing";
    return {
        stateKind: active ? "active" : "historical",
        stateLabel: active ? "Active" : "Historical",
        stateExplanation: active ? "Task is queued or currently running." : "Task is retained for review and audit context.",
        stateTags: active ? ["active"] : ["historical"],
        historical: !active
    };
}
function summarizeQueue(queue) {
    return queue.map((item) => {
        const state = classifyQueueItem(item);
        return {
            id: item.id,
            title: safeExcerpt(item.title, 240) ?? "",
            source: item.source,
            taskId: item.taskId,
            status: item.status,
            fixAttemptForTaskId: item.fixAttemptForTaskId,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            ...state
        };
    });
}
function classifyQueueItem(item) {
    if (item.source === "recovery") {
        return {
            stateKind: item.status === "completed" ? "recovered historical" : "recovery",
            stateLabel: item.status === "completed" ? "Recovered / historical" : "Recovery",
            stateExplanation: item.fixAttemptForTaskId
                ? `Recovery work for ${item.fixAttemptForTaskId}.`
                : "Recovery work queued by Project Pilot.",
            stateTags: item.status === "completed" ? ["recovered", "historical"] : ["recovery"]
        };
    }
    if (item.status === "skipped") {
        return {
            stateKind: "superseded skipped historical",
            stateLabel: "Superseded / skipped / historical",
            stateExplanation: "Queue item was intentionally skipped and retained for audit.",
            stateTags: ["superseded", "skipped", "historical"]
        };
    }
    if (item.status === "completed") {
        return {
            stateKind: "completed historical",
            stateLabel: "Completed / historical",
            stateExplanation: "Queue item already completed.",
            stateTags: ["completed", "historical"]
        };
    }
    if (item.status === "blocked") {
        return {
            stateKind: "blocked",
            stateLabel: "Blocked",
            stateExplanation: "Queue item cannot dispatch until the blocker is resolved.",
            stateTags: ["blocked"]
        };
    }
    return {
        stateKind: item.status,
        stateLabel: item.status === "active" ? "Active" : item.status === "queued" ? "Queued" : "Failed",
        stateExplanation: `Queue item is ${item.status}.`,
        stateTags: [item.status]
    };
}
function summarizeWorkers(workers) {
    return workers.map((worker) => ({
        id: worker.id,
        taskId: worker.taskId,
        phase: worker.phase,
        pid: worker.pid,
        command: worker.command,
        startedAt: worker.startedAt,
        endedAt: worker.endedAt,
        attemptType: worker.attemptType,
        reportPath: worker.reportPath,
        expectedArtifact: worker.expectedArtifact,
        logPath: worker.logPath,
        lastActivityAt: worker.lastActivityAt,
        status: worker.status,
        outcome: safeExcerpt(worker.outcome, 500),
        stateKind: worker.status === "recovered" ? "recovered historical" : worker.status,
        stateLabel: worker.status === "recovered" ? "Recovered / historical" : labelFromStatus(worker.status)
    }));
}
function summarizeTimeline(timeline) {
    return timeline.slice(-30).map((entry) => ({
        at: entry.at,
        kind: entry.kind,
        summary: safeExcerpt(entry.summary, 700) ?? ""
    }));
}
function recoveryHistory(run) {
    const attemptEntries = Object.entries(run.recoveryAttemptsByTaskId ?? {}).map(([taskId, attempts]) => ({
        kind: "attempt-count",
        taskId,
        attempts
    }));
    const queueEntries = run.queue
        .filter((item) => item.source === "recovery")
        .map((item) => ({
        kind: "queue",
        taskId: item.taskId,
        originalTaskId: item.fixAttemptForTaskId,
        status: item.status,
        title: safeExcerpt(item.title, 240),
        updatedAt: item.updatedAt
    }));
    const workerEntries = (run.workers ?? [])
        .filter((worker) => worker.attemptType === "recovery" || worker.status === "recovered")
        .map((worker) => ({
        kind: "worker",
        taskId: worker.taskId,
        status: worker.status,
        phase: worker.phase,
        startedAt: worker.startedAt,
        endedAt: worker.endedAt,
        outcome: safeExcerpt(worker.outcome, 500)
    }));
    return [...attemptEntries, ...queueEntries, ...workerEntries].slice(-20);
}
function latestActivityAt(run) {
    const values = [
        run.updatedAt,
        run.scheduler?.lastTickAt,
        run.scheduler?.nextScheduledTickAt,
        ...run.queue.map((item) => item.updatedAt),
        ...(run.workers ?? []).flatMap((worker) => [worker.lastActivityAt, worker.endedAt, worker.startedAt]),
        ...run.timeline.map((entry) => entry.at)
    ].filter((value) => Boolean(value));
    return values.sort().at(-1) ?? run.updatedAt;
}
function queueStateSummary(queue) {
    if (!queue.length) {
        return "Queue is empty.";
    }
    const counts = new Map();
    for (const item of queue) {
        counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    }
    return [...counts.entries()].map(([status, count]) => `${status}: ${count}`).join(", ");
}
function workerStateSummary(workers) {
    if (!workers.length) {
        return "No worker leases recorded.";
    }
    const active = workers.filter((worker) => worker.status === "active").length;
    const recovered = workers.filter((worker) => worker.status === "recovered").length;
    const terminal = workers.length - active;
    return `active: ${active}, terminal: ${terminal}, recovered: ${recovered}`;
}
function nextStepExplanation(run) {
    if (run.pauseReason) {
        return `Paused or blocked: ${safeExcerpt(run.pauseReason, 500)}`;
    }
    if (run.stopReason) {
        return `Stopped: ${safeExcerpt(run.stopReason, 500)}`;
    }
    if (run.completionSummary) {
        return `Completed: ${safeExcerpt(run.completionSummary, 500)}`;
    }
    if (run.nextAction) {
        return `Manager selected next action ${run.nextAction}.`;
    }
    const queued = run.queue.filter((item) => item.status === "queued").length;
    if (queued > 0) {
        return `${queued} queued item(s) are waiting for scheduler dispatch.`;
    }
    if (run.currentTaskId) {
        return `Current task ${run.currentTaskId} is still in progress or awaiting reconciliation.`;
    }
    return "Waiting for the next scheduler tick or manager decision.";
}
function labelFromStatus(status) {
    return status
        .split("-")
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(" ");
}
function safeExcerpt(value, maxLength = 1_000) {
    if (!value) {
        return value ?? undefined;
    }
    const redacted = value
        .replace(/\b(api[_-]?key|token|password|secret|credential)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[redacted]");
    return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 3)}...` : redacted;
}
function buildStatusHistorySnapshot(task) {
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
function buildPlanStatusHistorySnapshot(plan) {
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
function collectTaskErrors(task) {
    return [task.build.error, task.review?.error].filter((error) => Boolean(error));
}
function summarizeBuildSnapshot(task) {
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
function verificationDisplayStatusSnapshot(task, commands) {
    const current = currentVerificationByCommandSnapshot(task.verification ?? []);
    const records = commands.map((command) => current.get(normalizeCommandSnapshot(command)));
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
function summarizeVerificationSnapshot(task, commands) {
    if (commands.length === 0) {
        return "No configured verification commands.";
    }
    const current = currentVerificationByCommandSnapshot(task.verification ?? []);
    return commands
        .map((command) => {
        const record = current.get(normalizeCommandSnapshot(command));
        if (!record) {
            return `${command}: unknown (missing structured result)`;
        }
        const source = record.evidence?.source ? `, ${record.evidence.source}` : "";
        const explanation = record.status === "unknown" && record.evidence?.explanation ? ` - ${record.evidence.explanation}` : "";
        return `${command}: ${record.status}${source}${explanation}`;
    })
        .join("\n");
}
function currentVerificationByCommandSnapshot(records = []) {
    const current = new Map();
    for (const record of records) {
        if (record.isCurrent) {
            current.set(normalizeCommandSnapshot(record.command), record);
        }
    }
    return current;
}
function normalizeCommandSnapshot(command) {
    return command.trim().replace(/\s+/g, " ").toLowerCase();
}
function summarizePlanReportSnapshot(report) {
    const normalized = normalizePlanReportTextSnapshot(report);
    if (!normalized.trim()) {
        return "No plan report available.";
    }
    const summary = extractPlanSectionSnapshot(normalized, "Summary Of The Request");
    const firstParagraph = summary
        .split(/\r?\n\r?\n/)
        .map((block) => block.replace(/\s+/g, " ").trim())
        .find(Boolean);
    if (!firstParagraph) {
        return "Plan report is available.";
    }
    return firstParagraph.length > 240 ? `${firstParagraph.slice(0, 237)}...` : firstParagraph;
}
function normalizePlanReportTextSnapshot(report) {
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
function extractPlanSectionSnapshot(report, heading) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = report.match(new RegExp(`##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "i"));
    return match?.[1]?.trim() ?? "";
}
function readLocalLauncherState() {
    try {
        const raw = fs.readFileSync(dataPath("local-launcher.json"), "utf8");
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function limitPauseKind(run) {
    const reason = run.pauseReason ?? "";
    if (/runtime/i.test(reason))
        return "runtime";
    if (/quota|rate limit|OPENAI_API_KEY/i.test(reason))
        return "quota";
    if (/decision budget/i.test(reason))
        return "decision";
    if (/Maximum tasks/i.test(reason))
        return "task";
    if (/fix attempt/i.test(reason))
        return "fix";
    return null;
}
function summarizeLogPreview(lines) {
    const preview = lines
        .map((line) => plainEnglishLogLine(line))
        .filter((line) => line.length > 0)
        .slice(-3);
    return preview.length > 0 ? preview : ["No recent log output."];
}
function plainEnglishLogLine(line) {
    try {
        const parsed = JSON.parse(line);
        if (typeof parsed.text === "string") {
            return parsed.text.trim();
        }
        if (parsed.type === "exit") {
            return `Process exited with code ${String(parsed.exitCode ?? "unknown")}.`;
        }
        if (typeof parsed.message === "string") {
            return parsed.message.trim();
        }
        if (typeof parsed.type === "string") {
            return `Log event: ${parsed.type}.`;
        }
    }
    catch {
        return line.trim();
    }
    return line.trim();
}
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
    acquireInstanceLock();
    createApp().listen(PORT, HOST, () => {
        console.log(`Project Pilot MCP server listening at http://${HOST}:${PORT}/mcp`);
        console.log(`Project Pilot dashboard available at http://${HOST}:${PORT}/dashboard`);
    });
}
function strictPort(value) {
    if (!/^\d+$/.test(value.trim())) {
        throw new Error(`PORT must be an integer from 1 to 65535. Received: ${value}`);
    }
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`PORT must be an integer from 1 to 65535. Received: ${value}`);
    }
    return port;
}
export function acquireInstanceLock(lockPath = dataPath("project-pilot.pid"), registerHandlers = true) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(lockPath)) {
        const raw = fs.readFileSync(lockPath, "utf8").trim();
        const existingPid = Number.parseInt(raw, 10);
        if (Number.isInteger(existingPid) && processExists(existingPid)) {
            throw new Error(`Project Pilot is already running with PID ${existingPid}. Stop that instance before starting another.`);
        }
    }
    fs.writeFileSync(lockPath, String(process.pid), { flag: "w" });
    const cleanup = () => {
        try {
            if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
                fs.unlinkSync(lockPath);
            }
        }
        catch {
            // Best-effort lock cleanup.
        }
    };
    if (!registerHandlers) {
        return;
    }
    process.once("exit", cleanup);
    process.once("SIGINT", () => {
        cleanup();
        process.exit(130);
    });
    process.once("SIGTERM", () => {
        cleanup();
        process.exit(143);
    });
}
function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
