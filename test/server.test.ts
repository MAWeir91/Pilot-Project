import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { JobService } from "../src/jobs.js";
import { AutopilotService, NullAutopilotNotifier } from "../src/manager.js";
import { NullTaskNotifier } from "../src/notifications.js";
import { dataPath } from "../src/paths.js";
import { acquireInstanceLock, createApp, createServer } from "../src/server.js";
import { StateStore } from "../src/state.js";
import type { TaskState } from "../src/types.js";

type ToolsListHandler = (request: unknown, extra: unknown) => ListToolsResult | Promise<ListToolsResult>;
type RequestHandlerHost = {
  _requestHandlers: Map<string, ToolsListHandler>;
};

describe("MCP server connector metadata", () => {
  let httpServer: Server;
  let baseUrl: string;
  const stateFile = dataPath("server-test-tasks.json");
  const buildLogFile = dataPath("task-2026-06-24T01-00-00-000Z-bbbbbbbb.build.jsonl");
  const reviewLogFile = dataPath("task-2026-06-24T01-00-00-000Z-bbbbbbbb.review.jsonl");
  const planLogFile = dataPath("plan-2026-06-24T01-00-00-000Z-cccccccc.plan.jsonl");
  const planReportFile = dataPath("server-plan-report.md");
  const taskId = "task-2026-06-24T01-00-00-000Z-bbbbbbbb";
  const blockedTaskId = "task-2026-06-24T00-30-00-000Z-blocked1";
  const skippedTaskId = "task-2026-06-24T00-20-00-000Z-skipped1";
  const completedTaskId = "task-2026-06-24T00-10-00-000Z-complete";
  const recoveredTaskId = "task-2026-06-24T00-05-00-000Z-recover";
  const planId = "plan-2026-06-24T01-00-00-000Z-cccccccc";
  const runId = "run-dashboard-test";

  beforeAll(async () => {
    await fs.writeFile(
      buildLogFile,
      [
        JSON.stringify({ type: "stderr", timestamp: "2026-06-24T01:00:01.000Z", text: "npm test passed" }),
        JSON.stringify({ type: "exit", timestamp: "2026-06-24T01:00:02.000Z", exitCode: 0, signal: null })
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(reviewLogFile, "Review found no blocking issues.\n", "utf8");
    await fs.writeFile(planLogFile, "Planning completed.\n", "utf8");
    await fs.writeFile(planReportFile, validPlanReport(planId), "utf8");
    await fs.writeFile(
      stateFile,
      `${JSON.stringify(
        {
          tasks: [
            {
              id: taskId,
              title: "Dashboard test task",
              requirements: "Improve dashboard readability.",
              acceptanceCriteria: ["Task feed is readable.", "Details are available."],
              status: "ready-for-approval",
              createdAt: "2026-06-24T01:00:00.000Z",
              updatedAt: "2026-06-24T01:00:03.000Z",
              build: {
                status: "passed",
                logPath: buildLogFile,
                startedAt: "2026-06-24T01:00:01.000Z",
                endedAt: "2026-06-24T01:00:02.000Z",
                exitCode: 0
              },
              review: {
                status: "passed",
                result: "pass",
                logPath: reviewLogFile,
                startedAt: "2026-06-24T01:00:02.000Z",
                endedAt: "2026-06-24T01:00:03.000Z"
              },
              verification: ["npm test", "npm run check", "npm run build"].map((command) => ({
                command,
                attempt: 1,
                startedAt: "2026-06-24T01:00:01.000Z",
                endedAt: "2026-06-24T01:00:02.000Z",
                exitCode: 0,
                status: "passed",
                outputRef: "server-test-fixture",
                isCurrent: true,
                evidence: {
                  source: "build-worker",
                  taskId,
                  executionRoot: "server-test-fixture",
                  expectedCommands: ["npm test", "npm run check", "npm run build"],
                  outputRef: "server-test-fixture",
                  recordedAt: "2026-06-24T01:00:02.000Z",
                  explanation: "Persisted by test fixture."
                }
              }))
            },
            {
              id: blockedTaskId,
              projectId: "trade-journal-lite",
              title: "Blocked dashboard task",
              requirements: "Show blocked state.",
              acceptanceCriteria: ["Blocked state is visible."],
              status: "blocked",
              createdAt: "2026-06-24T00:30:00.000Z",
              updatedAt: "2026-06-24T00:31:00.000Z",
              build: {
                status: "blocked",
                logPath: buildLogFile,
                startedAt: "2026-06-24T00:30:00.000Z",
                endedAt: "2026-06-24T00:31:00.000Z",
                exitCode: null,
                error: "Maintenance preflight blocked this task."
              }
            },
            {
              id: skippedTaskId,
              projectId: "trade-journal-lite",
              title: "Skipped duplicate dashboard task",
              requirements: "Show superseded state.",
              acceptanceCriteria: ["Skipped state is visible."],
              status: "stopped",
              createdAt: "2026-06-24T00:20:00.000Z",
              updatedAt: "2026-06-24T00:21:00.000Z",
              build: {
                status: "stopped",
                logPath: buildLogFile,
                endedAt: "2026-06-24T00:21:00.000Z",
                exitCode: null,
                error: `Cancelled as duplicate of ${taskId}; Historical record preserved and no worker was launched.`
              }
            },
            {
              id: completedTaskId,
              projectId: "trade-journal-lite",
              title: "Completed dashboard task",
              requirements: "Show completed state.",
              acceptanceCriteria: ["Completed state is visible."],
              status: "completed",
              createdAt: "2026-06-24T00:10:00.000Z",
              updatedAt: "2026-06-24T00:11:00.000Z",
              completedAt: "2026-06-24T00:11:00.000Z",
              build: {
                status: "passed",
                logPath: buildLogFile,
                endedAt: "2026-06-24T00:10:30.000Z",
                exitCode: 0
              },
              review: {
                status: "passed",
                result: "pass",
                logPath: reviewLogFile,
                endedAt: "2026-06-24T00:11:00.000Z"
              }
            },
            {
              id: recoveredTaskId,
              projectId: "trade-journal-lite",
              title: "Recovered dashboard task",
              requirements: "Show recovered state.",
              acceptanceCriteria: ["Recovered state is visible."],
              status: "failed",
              createdAt: "2026-06-24T00:05:00.000Z",
              updatedAt: "2026-06-24T00:06:00.000Z",
              build: {
                status: "failed",
                logPath: buildLogFile,
                endedAt: "2026-06-24T00:06:00.000Z",
                exitCode: 1,
                error: "Recovered from lost worker terminal result using persisted evidence."
              }
            }
          ],
          plans: [
            {
              id: planId,
              projectId: "trade-journal-lite",
              title: "Dashboard plan",
              requirements: "Plan dashboard work.",
              constraints: "Read-only.",
              status: "plan-ready",
              createdAt: "2026-06-24T01:00:00.000Z",
              updatedAt: "2026-06-24T01:00:04.000Z",
              logPath: planLogFile,
              reportPath: planReportFile,
              pid: 1234,
              startedAt: "2026-06-24T01:00:01.000Z",
              endedAt: "2026-06-24T01:00:04.000Z",
              exitCode: 0
            }
          ],
          autopilotRuns: [
            {
              id: runId,
              projectId: "trade-journal-lite",
              briefId: "brief-dashboard-test",
              planId,
              status: "paused",
              phase: "building",
              createdAt: "2026-06-24T01:00:00.000Z",
              updatedAt: "2026-06-24T01:00:07.000Z",
              startedAt: "2026-06-24T01:00:00.000Z",
              currentTaskId: taskId,
              lastCompletedTaskId: skippedTaskId,
              pausedAt: "2026-06-24T01:00:07.000Z",
              pauseReason: "Paused for dashboard inspection.",
              activeRuntimeMs: 2000,
              activeRuntimeStartedAt: "2026-06-24T01:00:05.000Z",
              nextAction: "start_next_task",
              decisionsUsed: 1,
              tasksStarted: 1,
              fixAttemptsByTaskId: {},
              recoveryAttemptsByTaskId: { [blockedTaskId]: 1 },
              queue: [
                {
                  id: "queue-active",
                  title: "Dashboard test task",
                  requirements: "Sensitive queue requirements should not be returned by dashboard run details.",
                  acceptanceCriteria: ["No raw requirements in dashboard run detail."],
                  source: "manager",
                  taskId,
                  status: "active",
                  createdAt: "2026-06-24T01:00:00.000Z",
                  updatedAt: "2026-06-24T01:00:06.000Z"
                },
                {
                  id: "queue-recovery",
                  title: "Recover blocked task",
                  requirements: "Operational recovery.",
                  acceptanceCriteria: ["Recovery is visible."],
                  source: "recovery",
                  taskId: "task-2026-06-24T01-05-00-000Z-recover1",
                  status: "completed",
                  fixAttemptForTaskId: blockedTaskId,
                  createdAt: "2026-06-24T01:00:00.000Z",
                  updatedAt: "2026-06-24T01:00:04.000Z"
                },
                {
                  id: "queue-skipped",
                  title: "Skipped duplicate dashboard task",
                  requirements: "Duplicate.",
                  acceptanceCriteria: ["Skipped is visible."],
                  source: "manager",
                  taskId: skippedTaskId,
                  status: "skipped",
                  createdAt: "2026-06-24T00:20:00.000Z",
                  updatedAt: "2026-06-24T00:21:00.000Z"
                }
              ],
              decisions: [
                {
                  at: "2026-06-24T01:00:01.000Z",
                  action: "start_next_task",
                  summary: "Start dashboard task.",
                  reason: "Queue has active work."
                }
              ],
              timeline: [
                { at: "2026-06-24T01:00:00.000Z", kind: "status", summary: "Autopilot run started by explicit user request." },
                { at: "2026-06-24T01:00:02.000Z", kind: "builder-summary", summary: "Started task from queue." },
                {
                  at: "2026-06-24T01:00:04.000Z",
                  kind: "status",
                  summary: "Reconciled 1 stale worker lease.",
                  data: { secret: "token=should-not-render" }
                }
              ],
              codexThreads: { architectThreadId: "thread-dashboard" },
              limits: {
                maxManagerDecisions: 3,
                maxTasks: 2,
                maxFixAttemptsPerTask: 1,
                maxRuntimeMs: 60000
              },
              scheduler: {
                lastTickAt: "2026-06-24T01:00:06.000Z",
                nextScheduledTickAt: "2026-06-24T01:00:11.000Z",
                inProgress: false,
                dispatchStatus: "skipped",
                lastDispatchOutcome: "Current task is still active.",
                skippedDispatchReason: "Current task is still active."
              },
              workers: [
                {
                  id: "lease-active",
                  runId,
                  taskId,
                  phase: "build",
                  pid: 4321,
                  command: "codex build worker",
                  startedAt: "2026-06-24T01:00:05.000Z",
                  attemptType: "manager",
                  reportPath: "BUILD_REPORT.md",
                  expectedArtifact: "BUILD_REPORT.md",
                  logPath: buildLogFile,
                  lastActivityAt: "2026-06-24T01:00:06.000Z",
                  status: "active"
                },
                {
                  id: "lease-recovered",
                  runId,
                  taskId: blockedTaskId,
                  phase: "recovery",
                  command: "codex build worker",
                  startedAt: "2026-06-24T00:30:00.000Z",
                  endedAt: "2026-06-24T00:31:00.000Z",
                  attemptType: "recovery",
                  reportPath: "BUILD_REPORT.md",
                  expectedArtifact: "BUILD_REPORT.md",
                  logPath: buildLogFile,
                  status: "recovered",
                  outcome: "Task was stopped; active worker lease recovered."
                }
              ]
            }
          ]
        } satisfies TaskState,
        null,
        2
      )}\n`,
      "utf8"
    );
    const stateStore = new StateStore(stateFile);
    const service = new JobService(stateStore, new NullTaskNotifier());
    const autopilotService = new AutopilotService({
      store: stateStore,
      jobs: service,
      notifier: new NullAutopilotNotifier(),
      autoSchedule: false,
      processExists: () => true
    });
    await new Promise<void>((resolve) => {
      httpServer = createApp(service, autopilotService, stateStore).listen(0, "127.0.0.1", resolve);
    });

    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await Promise.allSettled([
      fs.unlink(stateFile),
      fs.unlink(buildLogFile),
      fs.unlink(reviewLogFile),
      fs.unlink(planLogFile),
      fs.unlink(planReportFile)
    ]);
  });

  it.each(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])(
    "returns a non-HTML 404 for %s",
    async (path) => {
      const response = await fetch(`${baseUrl}${path}`);
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(contentType).not.toMatch(/text\/html/i);
      expect(body).not.toMatch(/<!doctype html|<html/i);
    }
  );

  it("declares noauth security schemes for every tool", async () => {
    const mcpServer = createServer();
    const protocol = mcpServer.server as unknown as RequestHandlerHost;
    const toolsListHandler = protocol._requestHandlers.get("tools/list");

    expect(toolsListHandler).toBeDefined();

    const result = await toolsListHandler?.({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});

    expect(result?.tools.length).toBeGreaterThan(0);
    expect(result?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "list_tasks",
        "approve_task",
        "decline_task",
        "finalize_task",
        "list_projects",
        "get_project",
        "register_project",
        "configure_maintenance_execution",
        "set_active_project",
        "get_active_project",
        "start_plan",
        "list_plans",
        "get_plan_status",
        "get_plan_details",
        "create_task_from_plan",
        "create_project_brief",
        "get_project_brief",
        "list_project_briefs",
        "start_autopilot",
        "get_autopilot_status",
        "update_autopilot_limits",
        "pause_autopilot",
        "resume_autopilot",
        "stop_autopilot"
      ])
    );
    for (const tool of result?.tools ?? []) {
      expect(tool).toMatchObject({ securitySchemes: [{ type: "noauth" }] });
      expect(tool._meta).toMatchObject({ securitySchemes: [{ type: "noauth" }] });
      expect(JSON.stringify(tool)).not.toMatch(/oauth2/i);
    }
  });

  it("prevents duplicate Project Pilot server startup with a clear lock error", async () => {
    const lockPath = dataPath("server-test-project-pilot.pid");
    await fs.writeFile(lockPath, String(process.pid), "utf8");

    expect(() => acquireInstanceLock(lockPath, false)).toThrow(/already running/);

    await fs.rm(lockPath, { force: true });
  });

  it("serves the local dashboard and task feed", async () => {
    const page = await fetch(`${baseUrl}/dashboard`);
    const html = await page.text();
    const tasks = await fetch(`${baseUrl}/dashboard/tasks`);
    const plans = await fetch(`${baseUrl}/dashboard/plans`);
    const autopilotRuns = await fetch(`${baseUrl}/dashboard/autopilot`);
    const runDetails = await fetch(`${baseUrl}/dashboard/autopilot/${runId}`);
    const readinessResponse = await fetch(`${baseUrl}/dashboard/readiness`);
    const json = (await tasks.json()) as {
      tasks?: Array<{
        taskId: string;
        stateKind?: string;
        stateLabel?: string;
        stateExplanation?: string;
        stateTags?: string[];
        codexAccessMode?: string;
        codexApprovalPolicy?: string;
        codexAccessWarning?: string;
        latestLogPreview?: string[];
        latestLogLines?: string[];
      }>;
    };
    const planJson = (await plans.json()) as {
      plans?: Array<{ planId?: string; summary?: string; latestLogPreview?: string[]; latestLogLines?: string[] }>;
    };
    const autopilotJson = (await autopilotRuns.json()) as {
      runs?: Array<{
        id?: string;
        queueStateSummary?: string;
        workerStateSummary?: string;
        nextStepExplanation?: string;
        lastActivityAt?: string;
        queue?: Array<{ stateLabel?: string; stateTags?: string[]; requirements?: string }>;
        workers?: Array<{ stateLabel?: string; status?: string }>;
      }>;
    };
    const runJson = (await runDetails.json()) as {
      id?: string;
      timeline?: unknown[];
      decisions?: unknown[];
      recoveryHistory?: unknown[];
      audit?: { userActionRequired?: boolean; explanations?: Array<{ category?: string; explanation?: string }> };
      queue?: Array<{ title?: string; stateLabel?: string; stateTags?: string[]; requirements?: string }>;
      workers?: Array<{ stateLabel?: string; status?: string }>;
      runtime?: Record<string, unknown>;
      limits?: Record<string, unknown>;
      nextStepExplanation?: string;
    };
    const readinessJson = (await readinessResponse.json()) as {
      status?: string;
      components?: Array<{ name?: string; status?: string; summary?: string }>;
      problems?: string[];
    };

    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/i);
    expect(html).toMatch(/Project Pilot Dashboard/);
    expect(html).toMatch(/Readiness \/ Health/);
    expect(html).toMatch(/Plans/);
    expect(html).toMatch(/Tasks/);
    expect(html).toMatch(/Task State/);
    expect(html).toMatch(/State Tags/);
    expect(html).toMatch(/Activity/);
    expect(html).toMatch(/Persistent Active-Run Timeline/);
    expect(html).toMatch(/Recovery History/);
    expect(html).toMatch(/Audit Explanation/);
    expect(html).toMatch(/Remaining Limits/);
    expect(html).toMatch(/Current Phase \/ Task \/ Next Action/);
    expect(html).toMatch(/Latest Planning Log Lines/);
    expect(html).toMatch(/Last updated: never/);
    expect(html).toMatch(/Connection issue\. Showing last successful data\./);
    expect(html).toMatch(/setInterval\(refresh, 5000\)/);
    expect(html).toMatch(/View details/);
    expect(html).toMatch(/data-approve-task-id/);
    expect(html).toMatch(/data-decline-task-id/);
    expect(html).toMatch(/Decline \/ Keep Paused/);
    expect(html).toMatch(/Risk Evidence/);
    expect(html).toMatch(/Finalize safe task/);
    expect(html).toMatch(/Approval Mode/);
    expect(html).toMatch(/Codex Access/);
    expect(html).toMatch(/Codex Approval Policy/);
    expect(html).toMatch(/Approval policy: /);
    expect(html).toMatch(/Codex Access Warning/);
    expect(html).not.toMatch(/latestLogLines/);
    expect(tasks.status).toBe(200);
    expect(plans.status).toBe(200);
    expect(autopilotRuns.status).toBe(200);
    expect(runDetails.status).toBe(200);
    expect(readinessResponse.status).toBe(200);
    expect(Array.isArray(json.tasks)).toBe(true);
    expect(Array.isArray(planJson.plans)).toBe(true);
    expect(Array.isArray(autopilotJson.runs)).toBe(true);
    expect(planJson.plans?.[0]?.planId).toBe(planId);
    expect(planJson.plans?.[0]?.summary).toMatch(/Plan dashboard work/);
    expect(Array.isArray(planJson.plans?.[0]?.latestLogPreview)).toBe(true);
    expect(planJson.plans?.[0]?.latestLogLines).toBeUndefined();
    for (const task of json.tasks ?? []) {
      expect(Array.isArray(task.latestLogPreview)).toBe(true);
      expect(task.latestLogPreview?.length).toBeGreaterThan(0);
      expect(task.latestLogPreview?.length).toBeLessThanOrEqual(3);
      expect(task.latestLogLines).toBeUndefined();
      expect(task).toHaveProperty("approval");
      expect(task.codexAccessMode).toBe("full local access");
      expect(task.codexApprovalPolicy).toBe("never");
      expect(task.codexAccessWarning).toMatch(/outside the project folder/);
    }
    expect(json.tasks?.find((task) => task.taskId === taskId)?.stateLabel).toBe("Historical");
    expect(json.tasks?.find((task) => task.taskId === taskId)?.stateTags).toEqual(["historical"]);
    expect(json.tasks?.find((task) => task.taskId === blockedTaskId)?.stateLabel).toBe("Blocked");
    expect(json.tasks?.find((task) => task.taskId === blockedTaskId)?.stateTags).toEqual(["blocked"]);
    expect(json.tasks?.find((task) => task.taskId === skippedTaskId)?.stateLabel).toBe("Superseded / skipped / historical");
    expect(json.tasks?.find((task) => task.taskId === skippedTaskId)?.stateTags).toEqual([
      "superseded",
      "skipped",
      "historical"
    ]);
    expect(json.tasks?.find((task) => task.taskId === completedTaskId)?.stateLabel).toBe("Completed / historical");
    expect(json.tasks?.find((task) => task.taskId === completedTaskId)?.stateTags).toEqual(["completed", "historical"]);
    expect(json.tasks?.find((task) => task.taskId === recoveredTaskId)?.stateLabel).toBe("Recovered");
    expect(json.tasks?.find((task) => task.taskId === recoveredTaskId)?.stateTags).toEqual(["recovered"]);
    expect(autopilotJson.runs?.[0]).toMatchObject({
      id: runId,
      queueStateSummary: expect.stringMatching(/active: 1/),
      workerStateSummary: expect.stringMatching(/recovered: 1/),
      nextStepExplanation: expect.stringMatching(/Paused or blocked/)
    });
    expect(autopilotJson.runs?.[0]?.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(autopilotJson.runs?.[0]?.queue?.some((item) => item.requirements)).toBe(false);
    expect(autopilotJson.runs?.[0]?.queue?.map((item) => item.stateLabel)).toEqual(
      expect.arrayContaining(["Active", "Recovered / historical", "Superseded / skipped / historical"])
    );
    expect(autopilotJson.runs?.[0]?.queue?.flatMap((item) => item.stateTags ?? [])).toEqual(
      expect.arrayContaining(["active", "recovered", "superseded", "skipped", "historical"])
    );
    expect(runJson).toMatchObject({
      id: runId,
      runtime: expect.any(Object),
      limits: expect.any(Object),
      nextStepExplanation: expect.stringMatching(/Paused or blocked/)
    });
    expect(runJson.timeline?.length).toBeGreaterThan(0);
    expect(runJson.decisions?.length).toBe(1);
    expect(runJson.recoveryHistory?.length).toBeGreaterThan(0);
    expect(runJson.audit?.userActionRequired).toBe(true);
    expect(runJson.audit?.explanations?.map((item) => item.category)).toEqual(expect.arrayContaining(["retry-recovery"]));
    expect(runJson.audit?.explanations?.some((item) => /recovery|retry|reconciliation/i.test(item.explanation ?? ""))).toBe(true);
    expect(runJson.queue?.some((item) => item.requirements)).toBe(false);
    expect(JSON.stringify(runJson)).not.toMatch(/Sensitive queue requirements|should-not-render/);
    expect(readinessJson.components?.map((component) => component.name)).toEqual(
      expect.arrayContaining(["launcher", "tunnel", "state-store", "scheduler", "active-run", "configuration"])
    );
    expect(readinessJson.components?.find((component) => component.name === "state-store")?.status).toBe("ready");
    expect(JSON.stringify(readinessJson)).not.toMatch(/should-not-render|token=/);
  });

  it("serves dashboard task details without changing MCP tools", async () => {
    const tasksResponse = await fetch(`${baseUrl}/dashboard/tasks`);
    const tasksJson = (await tasksResponse.json()) as { tasks?: Array<{ taskId: string }> };
    const taskId = tasksJson.tasks?.[0]?.taskId;

    expect(taskId).toBeDefined();

    const details = await fetch(`${baseUrl}/dashboard/tasks/${taskId}`);
    const json = (await details.json()) as {
      taskId?: string;
      statusHistory?: unknown[];
      buildLog?: string;
      buildReport?: string | null;
      reviewReport?: string | null;
      errors?: unknown[];
      codexAccessMode?: string;
      codexApprovalPolicy?: string;
      codexAccessWarning?: string;
    };

    expect(details.status).toBe(200);
    expect(json.taskId).toBe(taskId);
    expect(Array.isArray(json.statusHistory)).toBe(true);
    expect(typeof json.buildLog).toBe("string");
    expect(json).toHaveProperty("buildReport");
    expect(json).toHaveProperty("reviewReport");
    expect(Array.isArray(json.errors)).toBe(true);
    expect(json.codexAccessMode).toBe("full local access");
    expect(json.codexApprovalPolicy).toBe("never");
    expect(json.codexAccessWarning).toMatch(/files and network outside/);
  });

  it("serves dashboard plan details", async () => {
    const details = await fetch(`${baseUrl}/dashboard/plans/${planId}`);
    const json = (await details.json()) as {
      planId?: string;
      statusHistory?: unknown[];
      errors?: unknown[];
      logTail?: string;
      report?: string | null;
      requirements?: string;
      constraints?: string;
    };

    expect(details.status).toBe(200);
    expect(json.planId).toBe(planId);
    expect(json.report).toMatch(/Plan dashboard work/);
    expect(json.requirements).toBe("Plan dashboard work.");
    expect(json.constraints).toBe("Read-only.");
    expect(Array.isArray(json.statusHistory)).toBe(true);
    expect(Array.isArray(json.errors)).toBe(true);
    expect(json.logTail).toMatch(/Planning completed/);
  });

  it("approves a ready task through the dashboard endpoint", async () => {
    const response = await fetch(`${baseUrl}/dashboard/tasks/${taskId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Reviewed in dashboard test." })
    });
    const json = (await response.json()) as {
      taskId?: string;
      status?: string;
      completedAt?: string;
      message?: string;
      task?: { status?: string; completedAt?: string };
    };
    const saved = await new StateStore(stateFile).getTask(taskId);

    expect(response.status).toBe(200);
    expect(json.taskId).toBe(taskId);
    expect(json.status).toBe("completed");
    expect(json.completedAt).toBeDefined();
    expect(json.message).toMatch(/marked completed/);
    expect(json.task?.status).toBe("completed");
    expect(saved?.status).toBe("completed");
    expect(saved?.completedAt).toBe(json.completedAt);
  });

  it("keeps the dashboard alive when corrupt live state is recoverable from a snapshot", async () => {
    await fs.writeFile(stateFile, "{ broken json", "utf8");

    const response = await fetch(`${baseUrl}/dashboard/tasks`);
    const json = (await response.json()) as { tasks?: unknown[] };
    const healthResponse = await fetch(`${baseUrl}/dashboard/state-health`);
    const health = (await healthResponse.json()) as { valid?: boolean; filePath?: string };

    expect(response.status).toBe(200);
    expect(Array.isArray(json.tasks)).toBe(true);
    expect(healthResponse.status).toBe(200);
    expect(health.valid).toBe(true);
    expect(health.filePath).toContain("server-test-tasks.json");
  });
});

function validPlanReport(planId: string): string {
  return `# Plan Report

Plan ID: ${planId}

## Summary Of The Request

Plan dashboard work.

## Recommended Architecture

Use the existing dashboard.

## Implementation Phases

1. Add views.

## Files Likely To Change

- src/dashboard.ts

## Dependencies Or Services Needed

No services are needed.

## Trade-offs And Alternatives

Keep changes small.

## Risks

Low risk.

## Test Strategy

Run npm test.

## Questions/Blockers

No blockers.
`;
}
