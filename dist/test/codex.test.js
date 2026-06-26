import { describe, expect, it } from "vitest";
import path from "node:path";
import { ALLOWLISTED_PROJECT_ROOT, PROJECT_PILOT_ROOT } from "../src/paths.js";
import { CODEX_ACCESS_MODE, CODEX_ACCESS_WARNING, CODEX_APPROVAL_POLICY, assertTaskId, buildCodexExecArgs, createTaskId } from "../src/codex.js";
describe("codex command construction", () => {
    it("builds full-access exec arguments without a shell command string", () => {
        const args = buildCodexExecArgs(ALLOWLISTED_PROJECT_ROOT);
        expect(args).toEqual([
            "--ask-for-approval",
            "never",
            "exec",
            "--cd",
            ALLOWLISTED_PROJECT_ROOT,
            "--sandbox",
            "danger-full-access",
            "--json"
        ]);
        expect(args).not.toContain("--yolo");
        expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
        expect(args).not.toContain("workspace-write");
        expect(args).not.toContain("read-only");
    });
    it("rejects Codex execution outside the allowlisted project", () => {
        const unregisteredProjectRoot = path.join(PROJECT_PILOT_ROOT, "unregistered-project-fixture");
        expect(() => buildCodexExecArgs(unregisteredProjectRoot)).toThrow(/not registered/);
    });
    it("can build read-only planning arguments for a registered project", () => {
        expect(buildCodexExecArgs(ALLOWLISTED_PROJECT_ROOT, "read-only")).toEqual([
            "--ask-for-approval",
            "never",
            "exec",
            "--cd",
            ALLOWLISTED_PROJECT_ROOT,
            "--sandbox",
            "read-only",
            "--json"
        ]);
    });
    it("declares the dashboard-facing access metadata", () => {
        expect(CODEX_ACCESS_MODE).toBe("full local access");
        expect(CODEX_APPROVAL_POLICY).toBe("never");
        expect(CODEX_ACCESS_WARNING).toMatch(/outside the project folder/);
    });
    it("creates and validates task ids", () => {
        const taskId = createTaskId();
        expect(assertTaskId(taskId)).toBe(taskId);
        expect(() => assertTaskId("../../../bad")).toThrow(/Invalid taskId/);
    });
});
