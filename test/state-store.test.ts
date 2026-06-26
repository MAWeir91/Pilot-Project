import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJsonFile, StateStoreError } from "../src/durable-json.js";
import { dataPath } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import type { TaskState } from "../src/types.js";

const FILES: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    FILES.map((file) => fs.rm(file, { force: true, recursive: true }).catch(() => undefined))
  );
  FILES.length = 0;
});

describe("durable state store", () => {
  it("serializes simultaneous reads and updates of the same state file", async () => {
    const stateFile = track(dataPath("state-concurrency.json"));
    const store = new StateStore(stateFile);
    await store.write({ tasks: [] });

    await Promise.all(
      Array.from({ length: 25 }, async (_, index) => {
        await store.transaction((state) => {
          state.tasks.push({
            id: `task-${index}`,
            title: `Task ${index}`,
            requirements: "Do work.",
            acceptanceCriteria: ["Done."],
            status: "queued",
            createdAt: `2026-06-25T00:00:${String(index).padStart(2, "0")}.000Z`,
            updatedAt: "2026-06-25T00:00:00.000Z",
            build: { status: "queued", logPath: dataPath(`task-${index}.build.jsonl`) }
          });
        });
        await store.read();
      })
    );

    const saved = await store.read();
    expect(saved.tasks).toHaveLength(25);
    expect(new Set(saved.tasks.map((task) => task.id)).size).toBe(25);
  });

  it("retries transient EBUSY on read and write", async () => {
    const stateFile = track(dataPath("state-ebusy.json"));
    const durable = new DurableJsonFile<TaskState>(stateFile, () => ({ tasks: [] }), normalizeTaskState, {
      ops: flakyOps({ readFailures: 1, openFailures: 1 }),
      retries: 3,
      backoffMs: 1
    });

    await fs.writeFile(stateFile, JSON.stringify({ tasks: [] }), "utf8");
    await expect(durable.read()).resolves.toEqual({ tasks: [], plans: [], projectBriefs: [], autopilotRuns: [] });
    await expect(durable.write({ tasks: [] })).resolves.toBeUndefined();
  });

  it("returns a typed state-store error after retry exhaustion", async () => {
    const stateFile = track(dataPath("state-ebusy-exhausted.json"));
    await fs.writeFile(stateFile, JSON.stringify({ tasks: [] }), "utf8");
    const durable = new DurableJsonFile<TaskState>(stateFile, () => ({ tasks: [] }), normalizeTaskState, {
      ops: flakyOps({ readFailures: 10 }),
      retries: 2,
      backoffMs: 1
    });

    await expect(durable.read()).rejects.toMatchObject({ name: "StateStoreError", code: "transient_exhausted" });
  });

  it("an interrupted replacement never corrupts the prior live JSON file", async () => {
    const stateFile = track(dataPath("state-interrupted.json"));
    await fs.writeFile(stateFile, JSON.stringify({ tasks: [{ id: "existing" }] }), "utf8");
    const ops = flakyOps({ renameTempToLiveFailures: 1 });
    const durable = new DurableJsonFile<TaskState>(stateFile, () => ({ tasks: [] }), normalizeTaskState, {
      ops,
      retries: 0,
      backoffMs: 1
    });

    await expect(durable.write({ tasks: [{ id: "new" } as never] })).rejects.toBeInstanceOf(StateStoreError);
    const live = JSON.parse(await fs.readFile(stateFile, "utf8")) as TaskState;
    expect(live.tasks?.[0]?.id).toBe("existing");
  });

  it("recovers a corrupt live file from the newest valid snapshot", async () => {
    const stateFile = track(dataPath("state-corrupt.json"));
    const snapshot = track(`${stateFile}.snapshot-2026-06-25T00-00-00-000Z-valid.bak`);
    await fs.writeFile(stateFile, "{ broken", "utf8");
    await fs.writeFile(snapshot, JSON.stringify({ tasks: [{ id: "recovered" }] }), "utf8");
    const durable = new DurableJsonFile<TaskState>(stateFile, () => ({ tasks: [] }), normalizeTaskState);

    const recovered = await durable.read();
    expect(recovered.tasks[0]?.id).toBe("recovered");
    expect(await fs.readFile(stateFile, "utf8")).toMatch(/recovered/);
  });

  it("does not replace a valid live file with an orphan temp file", async () => {
    const stateFile = track(dataPath("state-valid-live.json"));
    const temp = track(`${stateFile}.22260.orphan.tmp`);
    await fs.writeFile(stateFile, JSON.stringify({ tasks: [{ id: "live" }] }), "utf8");
    await fs.writeFile(temp, JSON.stringify({ tasks: [{ id: "temp" }] }), "utf8");
    const durable = new DurableJsonFile<TaskState>(stateFile, () => ({ tasks: [] }), normalizeTaskState);

    const state = await durable.read();
    const health = await durable.health();
    expect(state.tasks[0]?.id).toBe("live");
    expect(health.orphanTempFiles).toContain(path.basename(temp));
  });
});

function track(file: string): string {
  FILES.push(file);
  return file;
}

function normalizeTaskState(value: unknown): TaskState {
  const parsed = (value ?? {}) as Partial<TaskState>;
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    plans: Array.isArray(parsed.plans) ? parsed.plans : [],
    projectBriefs: Array.isArray(parsed.projectBriefs) ? parsed.projectBriefs : [],
    autopilotRuns: Array.isArray(parsed.autopilotRuns) ? parsed.autopilotRuns : []
  };
}

function flakyOps(options: { readFailures?: number; openFailures?: number; renameTempToLiveFailures?: number }) {
  let readFailures = options.readFailures ?? 0;
  let openFailures = options.openFailures ?? 0;
  let renameTempToLiveFailures = options.renameTempToLiveFailures ?? 0;
  return {
    ...fs,
    async readFile(...args: Parameters<typeof fs.readFile>) {
      if (readFailures > 0) {
        readFailures -= 1;
        throw Object.assign(new Error("busy read"), { code: "EBUSY" });
      }
      return await fs.readFile(...args);
    },
    async open(...args: Parameters<typeof fs.open>) {
      if (openFailures > 0) {
        openFailures -= 1;
        throw Object.assign(new Error("busy open"), { code: "EBUSY" });
      }
      return await fs.open(...args);
    },
    async rename(oldPath: string, newPath: string) {
      if (String(oldPath).endsWith(".tmp") && renameTempToLiveFailures > 0) {
        renameTempToLiveFailures -= 1;
        throw Object.assign(new Error("busy rename"), { code: "EBUSY" });
      }
      return await fs.rename(oldPath, newPath);
    }
  } as typeof fs;
}
