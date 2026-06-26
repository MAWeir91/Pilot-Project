import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { JobService } from "../src/jobs.js";
import { NullTaskNotifier } from "../src/notifications.js";
import { dataPath } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import { completeReadyTask, deriveTaskStatus } from "../src/task-status.js";
import type { TaskRecord, TaskState } from "../src/types.js";

const BASE_TASK: TaskRecord = {
  id: "task-2026-06-24T00-00-00-000Z-aaaaaaaa",
  title: "Test task",
  requirements: "Do the thing.",
  acceptanceCriteria: ["It works."],
  status: "queued",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
  build: {
    status: "queued",
    logPath: dataPath("task-2026-06-24T00-00-00-000Z-aaaaaaaa.build.jsonl")
  }
};

describe("task status transitions", () => {
  it.each([
    ["queued", { status: "queued" }, "queued"],
    ["active build", { status: "building", build: { status: "running" } }, "building"],
    ["legacy running", { status: "running", build: { status: "running" } }, "building"],
    ["successful build", { status: "build-passed", build: { status: "passed" } }, "build-passed"],
    ["legacy passed", { status: "passed", build: { status: "passed" } }, "build-passed"],
    ["active review", { status: "reviewing", review: { status: "running" } }, "reviewing"],
    ["stale reviewing status with passed review", { status: "reviewing", review: { status: "passed", result: "pass" } }, "ready-for-approval"],
    ["review needs fixes", { review: { status: "failed", result: "needs-fixes" } }, "needs-fixes"],
    ["review pass", { review: { status: "passed", result: "pass" } }, "ready-for-approval"],
    ["blocked review", { review: { status: "blocked", result: "blocked" } }, "blocked"],
    ["failed build", { build: { status: "failed", exitCode: 1 } }, "failed"],
    ["approved", { status: "completed", review: { status: "passed", result: "pass" } }, "completed"]
  ] as const)("derives %s as %s", (_name, patch, expected) => {
    expect(deriveTaskStatus(taskWith(patch))).toBe(expected);
  });

  it("only completes ready-for-approval tasks", () => {
    const ready = taskWith({ review: { status: "passed", result: "pass" } });

    const completed = completeReadyTask(ready, "2026-06-24T00:00:01.000Z");
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe("2026-06-24T00:00:01.000Z");
    expect(() => completeReadyTask(taskWith({ build: { status: "passed" } }), "2026-06-24T00:00:01.000Z")).toThrow(
      /not ready-for-approval/
    );
  });

  it("approveTask updates only a ready-for-approval task to completed", async () => {
    const stateFile = dataPath("task-status-test.json");
    const logPath = dataPath("task-2026-06-24T00-00-00-000Z-aaaaaaaa.review.jsonl");
    await fs.writeFile(logPath, "review line\n", "utf8");
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        tasks: [
          taskWith({
            build: {
              status: "passed",
              logPath,
              exitCode: 0,
              endedAt: "2026-06-24T00:00:00.500Z"
            },
            review: {
              status: "passed",
              result: "pass",
              logPath
            },
            verification: [
              { command: "npm test", attempt: 1, status: "passed", exitCode: 0, isCurrent: true },
              { command: "npm run check", attempt: 1, status: "passed", exitCode: 0, isCurrent: true },
              { command: "npm run build", attempt: 1, status: "passed", exitCode: 0, isCurrent: true }
            ]
          })
        ]
      } satisfies TaskState),
      "utf8"
    );

    const service = new JobService(new StateStore(stateFile), new NullTaskNotifier(), {
      now: () => "2026-06-24T00:00:01.000Z"
    });
    const result = await service.approveTask(BASE_TASK.id);
    const saved = await new StateStore(stateFile).getTask(BASE_TASK.id);

    expect(result.status).toBe("completed");
    expect(result.completedAt).toBe("2026-06-24T00:00:01.000Z");
    expect(result.message).toMatch(/marked completed/);
    expect(result.task.status).toBe("completed");
    expect(saved?.status).toBe("completed");
    expect(saved?.completedAt).toBe("2026-06-24T00:00:01.000Z");
    expect(saved?.build.status).toBe("passed");

    await fs.unlink(stateFile);
    await fs.unlink(logPath);
  });
});

function taskWith(patch: {
  status?: TaskRecord["status"];
  build?: Partial<TaskRecord["build"]>;
  review?: Partial<NonNullable<TaskRecord["review"]>>;
  verification?: TaskRecord["verification"];
}): TaskRecord {
  return {
    ...BASE_TASK,
    status: patch.status ?? BASE_TASK.status,
    build: {
      ...BASE_TASK.build,
      ...patch.build
    },
    review: patch.review
      ? {
          status: "queued",
          logPath: dataPath("task-2026-06-24T00-00-00-000Z-aaaaaaaa.review.jsonl"),
          ...patch.review
        }
      : undefined,
    verification: patch.verification
  };
}
