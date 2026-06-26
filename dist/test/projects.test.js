import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWLISTED_PROJECT_ROOT, DATA_DIR, dataPath } from "../src/paths.js";
import { DEFAULT_PROJECT_ID, ProjectRegistry } from "../src/projects.js";
const FILES = [];
afterEach(async () => {
    await Promise.allSettled(FILES.splice(0).map((file) => fs.unlink(file)));
});
describe("project registry", () => {
    it("migrates Trade Journal Lite into a local registry", async () => {
        const registryFile = dataPath("projects-migration-test.json");
        FILES.push(registryFile);
        const registry = new ProjectRegistry(registryFile, () => "2026-06-24T04:00:00.000Z");
        const state = await registry.listProjects();
        expect(state.activeProjectId).toBe(DEFAULT_PROJECT_ID);
        expect(state.projects).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: DEFAULT_PROJECT_ID,
                name: "Trade Journal Lite",
                path: ALLOWLISTED_PROJECT_ROOT
            })
        ]));
    });
    it("registers projects and updates active-project selection", async () => {
        const registryFile = dataPath("projects-active-test.json");
        FILES.push(registryFile);
        const projectPath = path.join(DATA_DIR, "registered-project");
        const registry = new ProjectRegistry(registryFile, () => "2026-06-24T04:00:00.000Z");
        const registered = await registry.registerProject({
            id: "registered-project",
            name: "Registered Project",
            path: projectPath,
            gitRemoteName: "origin",
            buildCommand: "npm run build",
            testCommand: "npm test",
            checkCommand: "npm run check",
            defaultBranchName: "main",
            allowedGitBehavior: "feature branch work"
        });
        const active = await registry.setActiveProject("registered-project");
        expect(registered.path).toBe(path.resolve(projectPath));
        expect(active.id).toBe("registered-project");
        await expect(registry.getActiveProject()).resolves.toMatchObject({ id: "registered-project" });
        await expect(registry.setActiveProject("missing")).rejects.toThrow(/Unknown projectId/);
    });
});
