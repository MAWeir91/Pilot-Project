import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWLISTED_PROJECT_ROOT, DATA_DIR, PROJECT_PILOT_ROOT, assertAllowedPath, dataPath, isPathInsideRoot } from "../src/paths.js";
describe("path allowlist", () => {
    it("allows paths inside project-pilot", () => {
        const allowed = path.join(PROJECT_PILOT_ROOT, "data", "tasks.json");
        expect(assertAllowedPath(allowed)).toBe(path.resolve(allowed));
    });
    it("allows paths inside the allowlisted trade-journal-lite project", () => {
        const allowed = path.join(ALLOWLISTED_PROJECT_ROOT, "TASK.md");
        expect(assertAllowedPath(allowed)).toBe(path.resolve(allowed));
    });
    it("rejects paths outside both project folders", () => {
        expect(() => assertAllowedPath(path.resolve(PROJECT_PILOT_ROOT, "..", "other", "file.txt"))).toThrow(/outside the Project Pilot allowlist/);
    });
    it("does not allow sibling paths with the same prefix", () => {
        const sibling = `${PROJECT_PILOT_ROOT}-backup`;
        expect(isPathInsideRoot(sibling, PROJECT_PILOT_ROOT)).toBe(false);
    });
    it("restricts generated data paths to safe file names", () => {
        expect(dataPath("task-123.build.jsonl")).toBe(path.join(DATA_DIR, "task-123.build.jsonl"));
        expect(() => dataPath("../escape.json")).toThrow(/Data file names/);
    });
});
