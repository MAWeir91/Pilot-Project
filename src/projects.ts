import path from "node:path";
import { DurableJsonFile } from "./durable-json.js";
import {
  validateMaintenanceExecutionConfig,
  type GitCommandRunner,
  type GitPreflightResult,
  type MaintenanceExecutionInput
} from "./execution.js";
import { ALLOWLISTED_PROJECT_ROOT, PROJECTS_FILE, assertAllowedPath } from "./paths.js";
import type { ProjectMaintenanceConfig, ProjectRecord, ProjectRegistryState } from "./types.js";

export const DEFAULT_PROJECT_ID = "trade-journal-lite";

export interface RegisterProjectInput {
  id: string;
  name: string;
  path: string;
  executionRoot?: string;
  gitRemoteName?: string;
  buildCommand: string;
  testCommand: string;
  checkCommand: string;
  defaultBranchName: string;
  allowedGitBehavior: string;
  maintenance?: Partial<ProjectMaintenanceConfig> & Pick<ProjectMaintenanceConfig, "enabled">;
}

export interface MaintenanceExecutionUpdateInput extends MaintenanceExecutionInput {
  projectId: string;
}

export class ProjectRegistry {
  private readonly registryFile: string;
  private readonly now: () => string;
  private readonly file: DurableJsonFile<ProjectRegistryState>;

  constructor(registryFile = PROJECTS_FILE, now = () => new Date().toISOString()) {
    this.registryFile = assertAllowedPath(registryFile);
    this.now = now;
    this.file = new DurableJsonFile(this.registryFile, () => this.defaultState(), normalizeRegistryState);
  }

  async read(): Promise<ProjectRegistryState> {
    const state = await this.file.read();
    if (state.projects.length === 0) {
      const defaultState = this.defaultState();
      await this.write(defaultState);
      return defaultState;
    }
    return state;
  }

  async write(state: ProjectRegistryState): Promise<void> {
    await this.file.write(state);
  }

  async listProjects(): Promise<{ projects: ProjectRecord[]; activeProjectId?: string }> {
    const state = await this.read();
    return {
      projects: [...state.projects].sort((left, right) => left.name.localeCompare(right.name)),
      activeProjectId: state.activeProjectId
    };
  }

  async getProject(projectId: string): Promise<ProjectRecord> {
    assertProjectId(projectId);
    const state = await this.read();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new Error(`Unknown projectId: ${projectId}`);
    }
    return project;
  }

  async getActiveProject(): Promise<ProjectRecord> {
    const state = await this.read();
    const project = state.projects.find((candidate) => candidate.id === state.activeProjectId) ?? state.projects[0];
    if (!project) {
      throw new Error("No registered projects are available.");
    }
    return project;
  }

  async setActiveProject(projectId: string): Promise<ProjectRecord> {
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

  async registerProject(input: RegisterProjectInput): Promise<ProjectRecord> {
    const project = this.projectFromInput(input);
    return await this.file.update((state) => {
      const existingIndex = state.projects.findIndex((candidate) => candidate.id === project.id);
      if (existingIndex >= 0) {
        project.createdAt = state.projects[existingIndex].createdAt;
        state.projects[existingIndex] = project;
      } else {
        state.projects.push(project);
      }
      state.activeProjectId = state.activeProjectId ?? project.id;
      return project;
    });
  }

  async configureMaintenanceExecution(
    input: MaintenanceExecutionUpdateInput,
    runner?: GitCommandRunner
  ): Promise<{ project: ProjectRecord; preflight: GitPreflightResult }> {
    const projectId = assertProjectId(input.projectId);
    let preflight: GitPreflightResult | undefined;
    const project = await this.file.update((state) => {
      const existingIndex = state.projects.findIndex((candidate) => candidate.id === projectId);
      if (existingIndex < 0) {
        throw new Error(`Unknown projectId: ${projectId}`);
      }
      const existing = normalizeProject(state.projects[existingIndex]);
      const validated = validateMaintenanceExecutionConfig(existing, input, runner);
      preflight = validated.preflight;
      const updated: ProjectRecord = {
        ...existing,
        path: path.resolve(existing.path),
        executionRoot: validated.executionRoot,
        maintenance: validated.maintenance,
        updatedAt: this.now()
      };
      state.projects[existingIndex] = updated;
      return updated;
    });
    return { project, preflight: preflight! };
  }

  private defaultState(): ProjectRegistryState {
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
          allowedGitBehavior:
            "feature branches, isolated worktrees, descriptive commits, non-protected branch pushes, and draft pull requests",
          createdAt: now,
          updatedAt: now
        }
      ]
    };
  }

  private projectFromInput(input: RegisterProjectInput): ProjectRecord {
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
      executionRoot: optionalAbsolutePath(input.executionRoot, "executionRoot"),
      gitRemoteName: optionalText(input.gitRemoteName),
      buildCommand: requiredText(input.buildCommand, "buildCommand"),
      testCommand: requiredText(input.testCommand, "testCommand"),
      checkCommand: requiredText(input.checkCommand, "checkCommand"),
      defaultBranchName: requiredText(input.defaultBranchName, "defaultBranchName"),
      allowedGitBehavior: requiredText(input.allowedGitBehavior, "allowedGitBehavior"),
      maintenance: normalizeMaintenanceConfig(input.maintenance, projectPath, input.defaultBranchName),
      createdAt: now,
      updatedAt: now
    };
  }
}

export function assertProjectId(projectId: string): string {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(projectId)) {
    throw new Error("Invalid projectId.");
  }
  return projectId;
}

function normalizeProject(project: ProjectRecord): ProjectRecord {
  return {
    ...project,
    path: path.resolve(project.path),
    executionRoot: project.executionRoot ? path.resolve(project.executionRoot) : undefined,
    maintenance: project.maintenance
      ? {
          ...project.maintenance,
          liveRoot: path.resolve(project.maintenance.liveRoot),
          baseBranch: optionalText(project.maintenance.baseBranch) ?? "",
          expectedBranch: optionalText(project.maintenance.expectedBranch) ?? ""
        }
      : undefined
  };
}

function normalizeRegistryState(value: unknown): ProjectRegistryState {
  const parsed = (value ?? {}) as Partial<ProjectRegistryState>;
  const projects = Array.isArray(parsed.projects) ? parsed.projects.map(normalizeProject) : [];
  return {
    projects,
    activeProjectId:
      parsed.activeProjectId && projects.some((project) => project.id === parsed.activeProjectId)
        ? parsed.activeProjectId
        : projects[0]?.id
  };
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required.`);
  }
  return trimmed;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalAbsolutePath(value: string | undefined, field: string): string | undefined {
  const trimmed = optionalText(value);
  if (!trimmed) {
    return undefined;
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`${field} must be absolute.`);
  }
  return path.resolve(trimmed);
}

function normalizeMaintenanceConfig(
  maintenance: RegisterProjectInput["maintenance"],
  projectPath: string,
  defaultBranchName: string
): ProjectMaintenanceConfig | undefined {
  if (!maintenance?.enabled) {
    return undefined;
  }

  const liveRoot = maintenance.liveRoot ? optionalAbsolutePath(maintenance.liveRoot, "maintenance.liveRoot")! : projectPath;
  const baseBranch = requiredText(maintenance.baseBranch ?? defaultBranchName, "maintenance.baseBranch");
  const expectedBranch = requiredText(maintenance.expectedBranch ?? baseBranch, "maintenance.expectedBranch");
  const dirtyWorkingTreeReason = optionalText(maintenance.dirtyWorkingTreeReason);
  if (maintenance.allowDirtyWorkingTree && !dirtyWorkingTreeReason) {
    throw new Error("maintenance.dirtyWorkingTreeReason is required when allowDirtyWorkingTree is true.");
  }

  return {
    enabled: true,
    liveRoot,
    baseBranch,
    expectedBranch,
    ...(maintenance.allowDirtyWorkingTree ? { allowDirtyWorkingTree: true, dirtyWorkingTreeReason } : {})
  };
}
