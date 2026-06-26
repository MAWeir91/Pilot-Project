import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService } from "../src/jobs.js";
import { NullTaskNotifier } from "../src/notifications.js";
import { ALLOWLISTED_PROJECT_ROOT, dataPath, taskBuildReportFile, taskReportsDir, taskReviewReportFile } from "../src/paths.js";
import { ProjectRegistry } from "../src/projects.js";
import { StateStore } from "../src/state.js";
import type { AutopilotRunRecord, TaskRecord, TaskState, TaskStatus } from "../src/types.js";

const TASK_ID = "task-2026-06-24T03-00-00-000Z-dddddddd";
const SECOND_TASK_ID = "task-2026-06-24T03-00-00-000Z-eeeeeeee";
const BUILD_LOG = dataPath("task-2026-06-24T03-00-00-000Z-dddddddd.build.jsonl");
const REVIEW_LOG = dataPath("task-2026-06-24T03-00-00-000Z-dddddddd.review.jsonl");
const STATE_FILES: string[] = [];

afterEach(async () => {
  await Promise.allSettled([...STATE_FILES.splice(0), BUILD_LOG, REVIEW_LOG].map((file) => fs.rm(file, { force: true, recursive: true })));
});

describe("task approval", () => {
  it("completes an eligible ready-for-approval task without spawning Codex", async () => {
    const spawnJob = vi.fn(() => {
      throw new Error("approve_task must not spawn Codex");
    });
    const { service, store } = await serviceWithTask(readyTask(), { spawnJob });

    const result = await service.approveTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result).toMatchObject({
      taskId: TASK_ID,
      status: "completed",
      completedAt: "2026-06-24T03:10:00.000Z"
    });
    expect(result.message).toBe(`Task ${TASK_ID} marked completed.`);
    expect(saved?.status).toBe("completed");
    expect(saved?.completedAt).toBe("2026-06-24T03:10:00.000Z");
    expect(saved?.updatedAt).toBeDefined();
    expect(spawnJob).not.toHaveBeenCalled();
  });

  it.each([
    "queued",
    "building",
    "build-passed",
    "reviewing",
    "needs-fixes",
    "completed",
    "failed",
    "blocked",
    "stopped"
  ] as const)("rejects %s tasks", async (status) => {
    const { service } = await serviceWithTask(taskForStatus(status));

    await expect(service.approveTask(TASK_ID)).rejects.toThrow(/not ready-for-approval|required build, verification, and review gates/);
  });

  it("does not modify target-project files", async () => {
    const before = await snapshotTargetProject();
    const { service } = await serviceWithTask(readyTask());

    await service.approveTask(TASK_ID);

    await expect(snapshotTargetProject()).resolves.toEqual(before);
  });

  it("finalizeTask auto-completes an eligible safe task", async () => {
    const { service, store } = await serviceWithTask(readyTask());

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result).toMatchObject({
      taskId: TASK_ID,
      status: "completed",
      completedAt: "2026-06-24T03:10:00.000Z"
    });
    expect(saved?.status).toBe("completed");
    expect(saved?.completedAt).toBe("2026-06-24T03:10:00.000Z");
  });

  it("approves from durable structured passed command evidence without BUILD_REPORT.md command parsing", async () => {
    const { service, store } = await serviceWithTask(
      {
        ...readyTask(),
        verification: durableVerification()
      },
      { buildReport: "" }
    );

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result.status).toBe("completed");
    expect(saved?.verification?.every((record) => record.evidence?.source === "build-worker")).toBe(true);
  });

  it("strictly reconciles valid legacy build evidence and records audit visibility", async () => {
    const { service, store } = await serviceWithTask(readyTask(), { withRun: true, legacyBuildReport: true });

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);
    const run = (await store.listAutopilotRuns())[0];

    expect(result.status).toBe("completed");
    expect(saved?.verification?.every((record) => record.status === "passed")).toBe(true);
    expect(saved?.verification?.some((record) => record.evidence?.source === "reconciled-from-evidence")).toBe(true);
    expect(saved?.verificationEvents?.[0]).toMatchObject({
      kind: "verification-reconciled",
      source: "reconciled-from-evidence",
      status: "reconciled-from-evidence",
      taskId: TASK_ID
    });
    expect(run.timeline.some((entry) => entry.summary.includes("verification reconciled-from-evidence"))).toBe(true);
  });

  it("does not reuse another task's canonical evidence for a later task", async () => {
    const { service, store } = await serviceWithTwoReadyTasksWithOnlyFirstEvidence();

    const result = await service.finalizeTask(SECOND_TASK_ID);
    const second = await store.getTask(SECOND_TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(second?.verification?.every((record) => record.status === "unknown")).toBe(true);
    expect(second?.verificationEvents?.[0]?.outputRef).toContain(SECOND_TASK_ID);
    expect(second?.verificationEvents?.[0]?.explanation).toMatch(/missing|No canonical/i);
  });

  it("does not parse filenames or paths as command evidence", async () => {
    const reportWithOnlyPathText = [
      "# Build Report",
      "",
      "Report Type: build",
      `Task ID: ${TASK_ID}`,
      "Run ID: __RUN_ID__",
      "Execution Root: __EXECUTION_ROOT__",
      "Branch: main",
      "Timestamp: 2026-06-24T03:10:00.000Z",
      "Report Path: __REPORT_PATH__",
      "",
      "Final Status: passed",
      "",
      "## Notes",
      "",
      "- `BUILD_REPORT.md` - passed",
      "- `.project-pilot/logs/task.build.jsonl` - passed",
      "- `src/server.ts` - passed",
      "- `npm test` mentioned in prose, not as a structured command record."
    ].join("\n");
    const { service, store } = await serviceWithTask(readyTask(), { buildReport: reportWithOnlyPathText });

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(saved?.verificationEvents?.[0]?.explanation).toMatch(/missing commands|structured command-result/i);
    expect(saved?.verification?.some((record) => record.command === "BUILD_REPORT.md" || record.command === "src/server.ts")).toBe(false);
  });

  it("rejects a report with the wrong task ID in plain English", async () => {
    const wrongTaskId = "task-2026-06-24T03-00-00-000Z-aaaaaaaa";
    const { service, store } = await serviceWithTask(readyTask(), { buildReport: approvalBuildReport({ taskId: wrongTaskId }) });

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(saved?.verificationEvents?.[0]?.explanation).toContain(`This report belongs to ${wrongTaskId}, so it cannot verify this task.`);
  });

  it("rejects old shared reports without strict matching provenance", async () => {
    const oldSharedReport = [
      "# Build Report",
      "",
      `Task ID: ${TASK_ID}`,
      "",
      "- `npm test` - passed",
      "- `npm run check` - passed",
      "- `npm run build` - passed",
      "",
      "Final Status: passed"
    ].join("\n");
    const { service, store } = await serviceWithTask(readyTask(), { buildReport: oldSharedReport, legacyBuildReport: true });

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(saved?.verificationEvents?.[0]?.explanation).toMatch(/report type mismatch|Run ID|Report Path/);
  });

  it("treats a later successful retry as the effective configured command result", async () => {
    const { service, store } = await serviceWithTask(readyTask(), {
      buildReport: approvalBuildReportWithTestRetry()
    });

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result.status).toBe("completed");
    expect(saved?.verification?.filter((record) => record.command === "npm test")).toMatchObject([
      { command: "npm test", attempt: 1, status: "failed", isCurrent: false },
      { command: "npm test", attempt: 2, status: "passed", isCurrent: true }
    ]);
  });

  it("preserves historic failed command attempts when a final retry passes", async () => {
    const { service, store } = await serviceWithTask(readyTask(), {
      buildReport: approvalBuildReportWithTestRetry()
    });

    await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);
    const npmTestAttempts = saved?.verification?.filter((record) => record.command === "npm test") ?? [];

    expect(npmTestAttempts).toHaveLength(2);
    expect(npmTestAttempts[0]).toMatchObject({ attempt: 1, status: "failed", isCurrent: false });
    expect(npmTestAttempts[1]).toMatchObject({ attempt: 2, status: "passed", isCurrent: true });
  });

  it("blocks finalization when a configured command has only failed results", async () => {
    const { service, store } = await serviceWithTask(readyTask(), {
      buildReport: approvalBuildReportWithFailedTestOnly()
    });

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(result.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/npm test \(failed\)/)]));
    expect(saved?.status).toBe("ready-for-approval");
    expect(saved?.verification?.find((record) => record.command === "npm test" && record.isCurrent)).toMatchObject({
      status: "failed"
    });
  });

  it.each([
    ["mismatched task identity", approvalBuildReport({ taskId: "task-2026-06-24T03-00-00-000Z-aaaaaaaa" }), /task identity mismatch/],
    [
      "ambiguous task identities",
      [approvalBuildReport(), "", "Task ID: task-2026-06-24T03-00-00-000Z-aaaaaaaa"].join("\n"),
      /task identity mismatch/
    ],
    ["missing report", "", /missing or empty/],
    ["missing command", approvalBuildReport({ omitCommand: "npm run check" }), /missing commands: npm run check/],
    ["ambiguous final status", approvalBuildReport({ extraFinalStatus: "failed" }), /final status is not exactly one passed/]
  ])("rejects %s legacy evidence and keeps verification unknown", async (_label, buildReport, reason) => {
    const { service, store } = await serviceWithTask(readyTask(), { buildReport });

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(result.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/unknown|missing|not passing/i)]));
    expect(saved?.status).toBe("ready-for-approval");
    expect(saved?.verification?.some((record) => record.status === "unknown")).toBe(true);
    expect(saved?.verificationEvents?.[0]?.explanation).toMatch(reason);
  });

  it("does not approve when structured configured command results remain unknown", async () => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      verification: durableVerification("unknown")
    }, { buildReport: "" });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(result.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/unknown/)]));
  });

  it("does not treat no-deployment language as deployment risk", async () => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements: "Keep this local-only. Do not add cloud deployment, external services, credentials, or publishing."
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("completed");
  });

  it.each([
    "No deployment is in scope.",
    "Deployment excluded; this remains local-only.",
    "No payments, purchases, subscriptions, or spending money are allowed.",
    "Payments excluded and no checkout or billing API should be added."
  ])("does not treat negative high-risk language as a blocking risk: %s", async (requirements) => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("completed");
  });

  it("does not block finalization for report-only excluded deployment/payment wording", async () => {
    const { service } = await serviceWithTask(readyTask(), {
      buildReport: [
        approvalBuildReport(),
        "",
        "## Scope Review",
        "",
        "Deployment excluded. Payments excluded. README documents no deployment, no payments, and local-only operation."
      ].join("\n"),
      reviewReport: [
        "# Review Report",
        "",
        "Report Type: review",
        `Task ID: ${TASK_ID}`,
        "Run ID: __RUN_ID__",
        "Execution Root: __EXECUTION_ROOT__",
        "Branch: main",
        "Timestamp: 2026-06-24T03:10:00.000Z",
        "Report Path: __REPORT_PATH__",
        "Result: pass",
        "",
        "No deployment behavior, payment flow, or external service integration was found."
      ].join("\n")
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("completed");
  });

  it.each([
    "No credentials, no secrets, no API keys, and no external services are allowed.",
    "Do not use secrets or credential files.",
    "The app must not access API keys or environment variables for credentials."
  ])("does not treat negative credential safety language as credential risk: %s", async (requirements) => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("completed");
  });

  it.each([
    ["Add a .env file containing service credentials.", "credential/secret file"],
    ["Read process.env.API_KEY and send it to the API client.", "credential environment variable access"],
    ["Store authToken = 'abcdefghijklmnopqrstuvwxyz123456' in local storage.", "secret-like assignment"],
    ["Add an OAuth authentication flow with bearer token handling.", "authentication or token handling"]
  ])("detects concrete credential risk evidence: %s", async (requirements, behavior) => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(result.riskFlags).toContain("credentials_or_secrets");
    expect(result.approval).toMatchObject({
      riskEvidence: expect.arrayContaining([
        expect.objectContaining({
          flag: "credentials_or_secrets",
          confidence: "supported",
          source: "task_text",
          matchedBehavior: expect.stringMatching(new RegExp(behavior, "i")),
          policyRule: expect.stringMatching(/manual approval/i),
          excerpt: expect.any(String)
        })
      ])
    });
  });

  it("auto-finalizes a reviewed passing local-only task with no risky scope", async () => {
    const { service, store } = await serviceWithTask({
      ...readyTask(),
      title: "Set up local Vite + TypeScript foundation",
      requirements:
        "Set up a local-only Vite and TypeScript app foundation. No external integration, credentials, brokerage connection, payment, cloud deployment, destructive data action, or protected-branch operation is in scope."
    });

    const result = await service.finalizeTask(TASK_ID);
    const saved = await store.getTask(TASK_ID);

    expect(result.status).toBe("completed");
    expect(saved?.status).toBe("completed");
  });

  it.each([
    ["deployment", "Add a deploy script and production deployment workflow."],
    ["production_database_migration", "Perform a production database migration."],
    ["data_deletion", "Delete user data from the project."],
    ["credentials_or_secrets", "Rotate API keys and update secrets."],
    ["payments_or_spending", "Add subscription payment handling."],
    ["brokerage_or_trading", "Connect a brokerage account for real trading."],
    ["external_service_integration", "Integrate with an external service."],
    ["network_exposure", "Change firewall rules for public network exposure."]
  ] as const)("finalizeTask blocks %s risk", async (riskFlag, requirements) => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(result.riskFlags).toContain(riskFlag);
    expect(result.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/Risk flags require manual approval/)]));
  });

  it("records supported evidence for actual deployment configuration", async () => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements: 'Update package.json with "deploy": "vercel --prod" for production release.'
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(result.approval).toMatchObject({
      riskEvidence: expect.arrayContaining([
        expect.objectContaining({
          flag: "deployment",
          confidence: "supported",
          source: "task_text",
          policyRule: expect.stringMatching(/Deployment/)
        })
      ])
    });
  });

  it("records supported evidence for actual payment implementation", async () => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements: "Integrate the Stripe payment SDK and create checkout sessions for subscriptions."
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(result.approval).toMatchObject({
      riskEvidence: expect.arrayContaining([
        expect.objectContaining({
          flag: "payments_or_spending",
          confidence: "supported",
          matchedBehavior: expect.stringMatching(/stripe|checkout|subscriptions/i)
        })
      ])
    });
  });

  it.each([
    "Create and switch to a feature branch for this work.",
    "Create an isolated worktree for the task.",
    "Commit project changes with a descriptive commit message.",
    "Push the non-protected feature branch to the configured remote.",
    "Create or update a draft pull request."
  ])("finalizeTask allows ordinary Git repository work: %s", async (requirements) => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("completed");
  });

  it.each([
    ["dangerous_git_operation", "Force push the branch."],
    ["dangerous_git_operation", "Delete the remote feature branch."],
    ["dangerous_git_operation", "Rewrite Git history with git reset --hard."],
    ["dangerous_git_operation", "Push rebased history to the remote."],
    ["dangerous_git_operation", "Change Git remote URLs."],
    ["dangerous_git_operation", "Change repository permissions."],
    ["dangerous_git_operation", "Change branch protections."],
    ["dangerous_git_operation", "Change organization settings."],
    ["dangerous_git_operation", "Push directly to main."],
    ["dangerous_git_operation", "Merge the pull request into a protected branch."]
  ] as const)("finalizeTask blocks %s risk for %s", async (riskFlag, requirements) => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements
    });

    const result = await service.finalizeTask(TASK_ID);

    expect(result.status).toBe("manual_approval_required");
    expect(result.riskFlags).toContain(riskFlag);
  });

  it("manual approve requires reviewed risk evidence when risk flags are present", async () => {
    const { service } = await serviceWithTask({
      ...readyTask(),
      requirements: "Add a deploy script and production deployment workflow."
    });

    await expect(service.approveTask({ taskId: TASK_ID, reason: "Approved after review." })).rejects.toThrow(
      /reviewedRiskEvidence=true/
    );
  });

  it("manual approve succeeds for a valid approval-required task and records an audit entry", async () => {
    const { service, store } = await serviceWithTask(
      {
        ...readyTask(),
        requirements: "Add a deploy script and production deployment workflow."
      },
      { withRun: true }
    );

    const result = await service.approveTask({
      taskId: TASK_ID,
      reason: "I reviewed the deployment risk evidence.",
      reviewedRiskEvidence: true
    });
    const saved = await store.getTask(TASK_ID);
    const run = (await store.listAutopilotRuns())[0];

    expect(result.status).toBe("completed");
    expect(saved?.approvalActions?.[0]).toMatchObject({
      kind: "approved",
      reason: "I reviewed the deployment risk evidence.",
      priorRiskFlags: ["deployment"],
      resultingStatus: "completed"
    });
    expect(run.pauseReason).toMatch(/manually approved/);
  });

  it("manual approval rejects missing verification, failed review, and incomplete build", async () => {
    const missingVerification = await serviceWithTask(readyTask(), { buildReport: "" });
    await expect(
      missingVerification.service.approveTask({ taskId: TASK_ID, reason: "Approve." })
    ).rejects.toThrow(/required build, verification, and review gates/);

    const failedReview = await serviceWithTask({
      ...readyTask(),
      review: { status: "failed", result: "needs-fixes", logPath: REVIEW_LOG }
    });
    await expect(failedReview.service.approveTask({ taskId: TASK_ID, reason: "Approve." })).rejects.toThrow(
      /required build, verification, and review gates|not ready-for-approval/
    );

    const incompleteBuild = await serviceWithTask({
      ...readyTask(),
      build: { status: "running", logPath: BUILD_LOG, pid: process.pid }
    });
    await expect(incompleteBuild.service.approveTask({ taskId: TASK_ID, reason: "Approve." })).rejects.toThrow(
      /required build, verification, and review gates|not ready-for-approval/
    );
  });

  it("decline keeps the run paused without losing work", async () => {
    const { service, store } = await serviceWithTask(readyTask(), { withRun: true });

    const result = await service.declineTaskApproval({ taskId: TASK_ID, reason: "Need user review." });
    const saved = await store.getTask(TASK_ID);
    const run = (await store.listAutopilotRuns())[0];

    expect(result.status).toBe("ready-for-approval");
    expect(saved?.status).toBe("ready-for-approval");
    expect(saved?.approvalActions?.[0]).toMatchObject({ kind: "declined", reason: "Need user review." });
    expect(run.status).toBe("paused");
    expect(run.pauseReason).toMatch(/Need user review/);
  });
});

async function serviceWithTask(
  task: TaskRecord,
  options: Record<string, unknown> & { buildReport?: string; reviewReport?: string; withRun?: boolean; legacyBuildReport?: boolean } = {}
) {
  await fs.writeFile(BUILD_LOG, "build log\n", "utf8");
  await fs.writeFile(REVIEW_LOG, "review log\n", "utf8");
  const suffix = STATE_FILES.length;
  const stateFile = dataPath(`approval-${suffix}.json`);
  const registryFile = dataPath(`approval-projects-${suffix}.json`);
  const projectPath = dataPath(`approval-project-${suffix}`);
  STATE_FILES.push(stateFile, registryFile, projectPath);
  await fs.mkdir(projectPath, { recursive: true });
  const runId = options.withRun ? "autopilot-approval-test" : "none";
  const canonicalBuildPath = taskBuildReportFile(projectPath, TASK_ID);
  const canonicalReviewPath = taskReviewReportFile(projectPath, TASK_ID);
  const buildPath = options.legacyBuildReport ? path.join(projectPath, "BUILD_REPORT.md") : canonicalBuildPath;
  await fs.mkdir(taskReportsDir(projectPath, TASK_ID), { recursive: true });
  await fs.writeFile(
    buildPath,
    renderReportFixture(options.buildReport ?? approvalBuildReport(), {
      executionRoot: projectPath,
      reportPath: buildPath,
      runId
    }),
    "utf8"
  );
  await fs.writeFile(
    canonicalReviewPath,
    renderReportFixture(options.reviewReport ?? approvalReviewReport(), {
      executionRoot: projectPath,
      reportPath: canonicalReviewPath,
      runId
    }),
    "utf8"
  );
  const savedTask = { ...task, projectId: "approval-project" };
  const state: TaskState = { tasks: [savedTask] };
  if (options.withRun) {
    state.autopilotRuns = [approvalRun()];
  }
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const store = new StateStore(stateFile);
  const projects = new ProjectRegistry(registryFile, () => "2026-06-24T03:10:00.000Z");
  await projects.registerProject({
    id: "approval-project",
    name: "Approval Test Project",
    path: projectPath,
    buildCommand: "npm run build",
    testCommand: "npm test",
    checkCommand: "npm run check",
    defaultBranchName: "main",
    allowedGitBehavior: "feature branches, descriptive commits, non-protected branch pushes, and draft pull requests"
  });
  const service = new JobService(store, new NullTaskNotifier(), {
    projects,
    now: () => "2026-06-24T03:10:00.000Z",
    ...omitBuildReportOption(options)
  });
  return { service, store };
}

async function serviceWithTwoReadyTasksWithOnlyFirstEvidence() {
  await fs.writeFile(BUILD_LOG, "build log\n", "utf8");
  await fs.writeFile(REVIEW_LOG, "review log\n", "utf8");
  const suffix = STATE_FILES.length;
  const stateFile = dataPath(`approval-two-tasks-${suffix}.json`);
  const registryFile = dataPath(`approval-two-task-projects-${suffix}.json`);
  const projectPath = dataPath(`approval-two-task-project-${suffix}`);
  STATE_FILES.push(stateFile, registryFile, projectPath);
  await fs.mkdir(projectPath, { recursive: true });

  const firstBuildPath = taskBuildReportFile(projectPath, TASK_ID);
  await fs.mkdir(taskReportsDir(projectPath, TASK_ID), { recursive: true });
  await fs.writeFile(
    firstBuildPath,
    renderReportFixture(approvalBuildReport(), {
      executionRoot: projectPath,
      reportPath: firstBuildPath,
      runId: "none"
    }),
    "utf8"
  );

  const first = { ...readyTask(), projectId: "approval-two-task-project" };
  const second = { ...readyTaskFor(SECOND_TASK_ID), projectId: "approval-two-task-project" };
  await fs.writeFile(stateFile, `${JSON.stringify({ tasks: [second, first] }, null, 2)}\n`, "utf8");
  const store = new StateStore(stateFile);
  const projects = new ProjectRegistry(registryFile, () => "2026-06-24T03:10:00.000Z");
  await projects.registerProject({
    id: "approval-two-task-project",
    name: "Approval Two Task Project",
    path: projectPath,
    buildCommand: "npm run build",
    testCommand: "npm test",
    checkCommand: "npm run check",
    defaultBranchName: "main",
    allowedGitBehavior: "feature branches, descriptive commits, non-protected branch pushes, and draft pull requests"
  });
  const service = new JobService(store, new NullTaskNotifier(), {
    projects,
    now: () => "2026-06-24T03:10:00.000Z"
  });
  return { service, store };
}

function omitBuildReportOption(
  options: Record<string, unknown> & { buildReport?: string; reviewReport?: string; withRun?: boolean; legacyBuildReport?: boolean }
): Record<string, unknown> {
  const { buildReport: _buildReport, reviewReport: _reviewReport, withRun: _withRun, legacyBuildReport: _legacyBuildReport, ...rest } = options;
  return rest;
}

function renderReportFixture(report: string, values: { executionRoot: string; reportPath: string; runId: string }): string {
  return report
    .replaceAll("__EXECUTION_ROOT__", values.executionRoot)
    .replaceAll("__REPORT_PATH__", values.reportPath)
    .replaceAll("__RUN_ID__", values.runId);
}

function approvalRun(): AutopilotRunRecord {
  return {
    id: "autopilot-approval-test",
    projectId: "approval-project",
    briefId: "brief-approval-test",
    status: "paused",
    phase: "paused",
    createdAt: "2026-06-24T03:00:00.000Z",
    updatedAt: "2026-06-24T03:00:00.000Z",
    startedAt: "2026-06-24T03:00:00.000Z",
    currentTaskId: TASK_ID,
    nextAction: null,
    decisionsUsed: 0,
    tasksStarted: 1,
    fixAttemptsByTaskId: {},
    recoveryAttemptsByTaskId: {},
    queue: [],
    decisions: [],
    timeline: [],
    codexThreads: {},
    limits: {
      maxRuntimeMs: 28800000,
      maxManagerDecisions: 10,
      maxTasks: 5,
      maxFixAttemptsPerTask: 1
    }
  };
}

function approvalBuildReport(
  options: { taskId?: string; omitCommand?: string; extraFinalStatus?: "passed" | "failed" | "blocked" } = {}
): string {
  const commands = [
    ["npm test", "passed"],
    ["npm run check", "passed"],
    ["npm run build", "passed"]
  ].filter(([command]) => command !== options.omitCommand);
  return [
    "# Build Report",
    "",
    "Report Type: build",
    `Task ID: ${options.taskId ?? TASK_ID}`,
    "Run ID: __RUN_ID__",
    "Execution Root: __EXECUTION_ROOT__",
    "Branch: main",
    "Timestamp: 2026-06-24T03:10:00.000Z",
    "Report Path: __REPORT_PATH__",
    "",
    "## Commands Run and Results",
    "",
    ...commands.map(([command, result], index) =>
      `PROJECT_PILOT_COMMAND_RESULT {"command":${JSON.stringify(command)},"attempt":1,"status":${JSON.stringify(result)},"exitCode":0,"startedAt":"2026-06-24T03:0${index}:01.000Z","endedAt":"2026-06-24T03:0${index}:02.000Z"}`
    ),
    "",
    "Final Status: passed",
    ...(options.extraFinalStatus ? ["", `Final Status: ${options.extraFinalStatus}`] : [])
  ].join("\n");
}

function approvalBuildReportWithTestRetry(): string {
  return [
    "# Build Report",
    "",
    "Report Type: build",
    `Task ID: ${TASK_ID}`,
    "Run ID: __RUN_ID__",
    "Execution Root: __EXECUTION_ROOT__",
    "Branch: main",
    "Timestamp: 2026-06-24T03:10:00.000Z",
    "Report Path: __REPORT_PATH__",
    "",
    "## Commands Run and Results",
    "",
    'PROJECT_PILOT_COMMAND_RESULT {"command":"npm test","attempt":1,"status":"failed","exitCode":1}',
    'PROJECT_PILOT_COMMAND_RESULT {"command":"npm test","attempt":2,"status":"passed","exitCode":0}',
    'PROJECT_PILOT_COMMAND_RESULT {"command":"npm run check","attempt":1,"status":"passed","exitCode":0}',
    'PROJECT_PILOT_COMMAND_RESULT {"command":"npm run build","attempt":1,"status":"passed","exitCode":0}',
    "",
    "Final Status: passed"
  ].join("\n");
}

function approvalBuildReportWithFailedTestOnly(): string {
  return [
    "# Build Report",
    "",
    "Report Type: build",
    `Task ID: ${TASK_ID}`,
    "Run ID: __RUN_ID__",
    "Execution Root: __EXECUTION_ROOT__",
    "Branch: main",
    "Timestamp: 2026-06-24T03:10:00.000Z",
    "Report Path: __REPORT_PATH__",
    "",
    "## Commands Run and Results",
    "",
    'PROJECT_PILOT_COMMAND_RESULT {"command":"npm test","attempt":1,"status":"failed","exitCode":1}',
    'PROJECT_PILOT_COMMAND_RESULT {"command":"npm run check","attempt":1,"status":"passed","exitCode":0}',
    'PROJECT_PILOT_COMMAND_RESULT {"command":"npm run build","attempt":1,"status":"passed","exitCode":0}',
    "",
    "Final Status: failed"
  ].join("\n");
}

function durableVerification(status: "passed" | "failed" | "unknown" = "passed"): TaskRecord["verification"] {
  return ["npm test", "npm run check", "npm run build"].map((command) => ({
    command,
    attempt: 1,
    startedAt: "2026-06-24T03:00:01.000Z",
    endedAt: "2026-06-24T03:00:02.000Z",
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
    status,
    outputRef: "durable-state",
    isCurrent: true,
    evidence: {
      source: "build-worker",
      taskId: TASK_ID,
      executionRoot: "durable-test-root",
      expectedCommands: ["npm test", "npm run check", "npm run build"],
      outputRef: "durable-state",
      recordedAt: "2026-06-24T03:00:02.000Z",
      explanation: "Persisted by build worker."
    }
  }));
}

function approvalReviewReport(): string {
  return [
    "# Review Report",
    "",
    "Report Type: review",
    `Task ID: ${TASK_ID}`,
    "Run ID: __RUN_ID__",
    "Execution Root: __EXECUTION_ROOT__",
    "Branch: main",
    "Timestamp: 2026-06-24T03:10:00.000Z",
    "Report Path: __REPORT_PATH__",
    "Result: pass",
    "",
    "## Reasons",
    "",
    "- Build, check, and review passed.",
    "- No prohibited risky operation was found."
  ].join("\n");
}

function readyTask(): TaskRecord {
  return readyTaskFor(TASK_ID);
}

function readyTaskFor(taskId: string): TaskRecord {
  return {
    ...baseTask(),
    id: taskId,
    status: "ready-for-approval",
    build: {
      status: "passed",
      logPath: BUILD_LOG,
      startedAt: "2026-06-24T03:00:01.000Z",
      endedAt: "2026-06-24T03:00:02.000Z",
      exitCode: 0
    },
    review: {
      status: "passed",
      result: "pass",
      logPath: REVIEW_LOG,
      startedAt: "2026-06-24T03:00:03.000Z",
      endedAt: "2026-06-24T03:00:04.000Z",
      exitCode: 0
    }
  };
}

function taskForStatus(status: TaskStatus): TaskRecord {
  if (status === "ready-for-approval") {
    return readyTask();
  }

  if (status === "completed") {
    return {
      ...readyTask(),
      status,
      completedAt: "2026-06-24T03:00:05.000Z"
    };
  }

  if (status === "needs-fixes") {
    return {
      ...readyTask(),
      status,
      review: {
        status: "failed",
        result: "needs-fixes",
        logPath: REVIEW_LOG
      }
    };
  }

  if (status === "blocked") {
    return {
      ...readyTask(),
      status,
      review: {
        status: "blocked",
        result: "blocked",
        logPath: REVIEW_LOG
      }
    };
  }

  if (status === "reviewing") {
    return {
      ...baseTask(),
      status,
      review: {
        status: "running",
        logPath: REVIEW_LOG,
        pid: process.pid,
        startedAt: "2026-06-24T03:00:03.000Z"
      }
    };
  }

  if (status === "building") {
    return {
      ...baseTask(),
      status,
      build: {
        status: "running",
        logPath: BUILD_LOG,
        pid: process.pid,
        startedAt: "2026-06-24T03:00:01.000Z"
      }
    };
  }

  return {
    ...baseTask(),
    status,
    build: {
      status:
        status === "build-passed" ? "passed" : status === "failed" ? "failed" : status === "stopped" ? "stopped" : "queued",
      logPath: BUILD_LOG
    }
  };
}

function baseTask(): TaskRecord {
  return {
    id: TASK_ID,
    title: "Approval test",
    requirements: "Approve only eligible tasks.",
    acceptanceCriteria: ["Only task state changes."],
    status: "queued",
    createdAt: "2026-06-24T03:00:00.000Z",
    updatedAt: "2026-06-24T03:00:00.000Z",
    build: {
      status: "queued",
      logPath: BUILD_LOG
    }
  };
}

async function snapshotTargetProject(): Promise<Record<string, { mtimeMs: number; size: number }>> {
  const snapshot: Record<string, { mtimeMs: number; size: number }> = {};
  await collectTargetSnapshot(ALLOWLISTED_PROJECT_ROOT, snapshot);
  return snapshot;
}

async function collectTargetSnapshot(dir: string, snapshot: Record<string, { mtimeMs: number; size: number }>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relative = path.relative(ALLOWLISTED_PROJECT_ROOT, fullPath);
    if (entry.isDirectory()) {
      await collectTargetSnapshot(fullPath, snapshot);
      continue;
    }
    if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      snapshot[relative] = { mtimeMs: stat.mtimeMs, size: stat.size };
    }
  }
}
