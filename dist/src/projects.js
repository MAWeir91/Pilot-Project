import path from "node:path";
import { DurableJsonFile } from "./durable-json.js";
import { ALLOWLISTED_PROJECT_ROOT, PROJECTS_FILE, assertAllowedPath } from "./paths.js";
export const DEFAULT_PROJECT_ID = "trade-journal-lite";
export class ProjectRegistry {
    registryFile;
    now;
    file;
    constructor(registryFile = PROJECTS_FILE, now = () => new Date().toISOString()) {
        this.registryFile = assertAllowedPath(registryFile);
        this.now = now;
        this.file = new DurableJsonFile(this.registryFile, () => this.defaultState(), normalizeRegistryState);
    }
    async read() {
        const state = await this.file.read();
        if (state.projects.length === 0) {
            const defaultState = this.defaultState();
            await this.write(defaultState);
            return defaultState;
        }
        return state;
    }
    async write(state) {
        await this.file.write(state);
    }
    async listProjects() {
        const state = await this.read();
        return {
            projects: [...state.projects].sort((left, right) => left.name.localeCompare(right.name)),
            activeProjectId: state.activeProjectId
        };
    }
    async getProject(projectId) {
        assertProjectId(projectId);
        const state = await this.read();
        const project = state.projects.find((candidate) => candidate.id === projectId);
        if (!project) {
            throw new Error(`Unknown projectId: ${projectId}`);
        }
        return project;
    }
    async getActiveProject() {
        const state = await this.read();
        const project = state.projects.find((candidate) => candidate.id === state.activeProjectId) ?? state.projects[0];
        if (!project) {
            throw new Error("No registered projects are available.");
        }
        return project;
    }
    async setActiveProject(projectId) {
        assertProjectId(projectId);
        return await this.file.update((state) => {
            const project = state.projects.find((candidate) => candidate.id === projectId);
            if (!project) {
                throw new Error(`Unknown projectId: ${projectId}`);
            }
            state.activeProjectId = projectId;
            return project;
        });
    }
    async registerProject(input) {
        const project = this.projectFromInput(input);
        return await this.file.update((state) => {
            const existingIndex = state.projects.findIndex((candidate) => candidate.id === project.id);
            if (existingIndex >= 0) {
                project.createdAt = state.projects[existingIndex].createdAt;
                state.projects[existingIndex] = project;
            }
            else {
                state.projects.push(project);
            }
            state.activeProjectId = state.activeProjectId ?? project.id;
            return project;
        });
    }
    defaultState() {
        const now = this.now();
        return {
            activeProjectId: DEFAULT_PROJECT_ID,
            projects: [
                {
                    id: DEFAULT_PROJECT_ID,
                    name: "Trade Journal Lite",
                    path: ALLOWLISTED_PROJECT_ROOT,
                    gitRemoteName: "origin",
                    buildCommand: "npm run build",
                    testCommand: "npm test",
                    checkCommand: "npm run check",
                    defaultBranchName: "main",
                    allowedGitBehavior: "feature branches, isolated worktrees, descriptive commits, non-protected branch pushes, and draft pull requests",
                    createdAt: now,
                    updatedAt: now
                }
            ]
        };
    }
    projectFromInput(input) {
        const id = assertProjectId(input.id);
        const projectPath = path.resolve(input.path);
        if (!path.isAbsolute(input.path)) {
            throw new Error("Project path must be absolute.");
        }
        const now = this.now();
        return {
            id,
            name: requiredText(input.name, "name"),
            path: projectPath,
            gitRemoteName: optionalText(input.gitRemoteName),
            buildCommand: requiredText(input.buildCommand, "buildCommand"),
            testCommand: requiredText(input.testCommand, "testCommand"),
            checkCommand: requiredText(input.checkCommand, "checkCommand"),
            defaultBranchName: requiredText(input.defaultBranchName, "defaultBranchName"),
            allowedGitBehavior: requiredText(input.allowedGitBehavior, "allowedGitBehavior"),
            createdAt: now,
            updatedAt: now
        };
    }
}
export function assertProjectId(projectId) {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(projectId)) {
        throw new Error("Invalid projectId.");
    }
    return projectId;
}
function normalizeProject(project) {
    return {
        ...project,
        path: path.resolve(project.path)
    };
}
function normalizeRegistryState(value) {
    const parsed = (value ?? {});
    const projects = Array.isArray(parsed.projects) ? parsed.projects.map(normalizeProject) : [];
    return {
        projects,
        activeProjectId: parsed.activeProjectId && projects.some((project) => project.id === parsed.activeProjectId)
            ? parsed.activeProjectId
            : projects[0]?.id
    };
}
function requiredText(value, field) {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`${field} is required.`);
    }
    return trimmed;
}
function optionalText(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
