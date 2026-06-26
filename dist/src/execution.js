import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_PILOT_LIVE_ROOT, assertAllowedPath, isPathInsideRoot } from "./paths.js";
const CANONICAL_PROJECT_PILOT_LIVE_ROOT = canonicalPath(PROJECT_PILOT_LIVE_ROOT);
export function projectExecutionContext(project) {
    return {
        registeredRoot: canonicalPath(project.path),
        executionRoot: canonicalPath(project.executionRoot ?? project.path),
        maintenanceMode: project.maintenance?.enabled === true
    };
}
export function taskArtifactRoot(project) {
    return projectExecutionContext(project).executionRoot;
}
export function taskLocalLogPath(project, fileName) {
    if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
        throw new Error("Log file names may only contain letters, numbers, dot, underscore, and dash.");
    }
    const context = projectExecutionContext(project);
    if (!context.maintenanceMode) {
        return "";
    }
    return assertAllowedPath(path.join(context.executionRoot, ".project-pilot", "logs", fileName));
}
export function preflightWorkerLaunch(project, runner = runGit) {
    const context = projectExecutionContext(project);
    const diagnostics = {
        projectId: project.id,
        maintenanceMode: context.maintenanceMode,
        registeredRoot: context.registeredRoot,
        executionRoot: context.executionRoot
    };
    if (!context.maintenanceMode) {
        if (context.registeredRoot === CANONICAL_PROJECT_PILOT_LIVE_ROOT) {
            return {
                ok: false,
                executionRoot: context.executionRoot,
                reason: "Maintenance configuration is required for the live Project Pilot checkout.",
                diagnostics: {
                    ...diagnostics,
                    liveRoot: CANONICAL_PROJECT_PILOT_LIVE_ROOT
                }
            };
        }
        return { ok: true, executionRoot: context.executionRoot, diagnostics };
    }
    const configError = validatePersistedMaintenanceConfig(project);
    if (configError) {
        return { ok: false, executionRoot: context.executionRoot, reason: configError, diagnostics };
    }
    const liveRoot = canonicalPath(project.maintenance?.liveRoot ?? PROJECT_PILOT_LIVE_ROOT);
    const baseBranch = project.maintenance.baseBranch;
    const expectedBranch = project.maintenance.expectedBranch;
    diagnostics.liveRoot = liveRoot;
    diagnostics.baseBranch = baseBranch;
    diagnostics.expectedBranch = expectedBranch;
    const structuralError = validateMaintenanceRoots(context, liveRoot);
    if (structuralError) {
        return { ok: false, executionRoot: context.executionRoot, reason: structuralError, diagnostics };
    }
    try {
        const gitRoot = path.resolve(runner(["rev-parse", "--show-toplevel"], context.executionRoot).trim());
        diagnostics.gitRoot = gitRoot;
        if (gitRoot !== context.executionRoot) {
            return {
                ok: false,
                executionRoot: context.executionRoot,
                reason: `Maintenance execution root must be the repository root. Git reported ${gitRoot}.`,
                diagnostics
            };
        }
        const branch = runner(["branch", "--show-current"], context.executionRoot).trim();
        diagnostics.currentBranch = branch || "(detached)";
        if (!branch) {
            return { ok: false, executionRoot: context.executionRoot, reason: "Maintenance worktree is in detached HEAD state.", diagnostics };
        }
        if (branch !== expectedBranch) {
            return {
                ok: false,
                executionRoot: context.executionRoot,
                reason: `Maintenance worktree is on branch ${branch}; expected ${expectedBranch}.`,
                diagnostics
            };
        }
        const baseRef = resolveBaseRef(project, baseBranch, runner, context.executionRoot);
        diagnostics.baseRef = baseRef;
        runner(["merge-base", "--is-ancestor", baseRef, "HEAD"], context.executionRoot);
        const worktrees = parseWorktreeList(runner(["worktree", "list", "--porcelain"], context.executionRoot));
        diagnostics.worktreeCount = worktrees.length;
        diagnostics.isListedWorktree = worktrees.includes(context.executionRoot);
        if (!worktrees.includes(context.executionRoot)) {
            return {
                ok: false,
                executionRoot: context.executionRoot,
                reason: "Maintenance execution root is not listed by git worktree.",
                diagnostics
            };
        }
        const status = runner(["status", "--porcelain=v1"], context.executionRoot)
            .split(/\r?\n/)
            .map((line) => line.trimEnd())
            .filter(Boolean);
        diagnostics.dirtyFileCount = status.length;
        diagnostics.dirtyFiles = status.map(redactStatusLine).slice(0, 25);
        if (status.length > 0 && !project.maintenance?.allowDirtyWorkingTree) {
            return {
                ok: false,
                executionRoot: context.executionRoot,
                reason: "Maintenance worktree has uncommitted changes and no explicit dirty-working-tree reason.",
                diagnostics
            };
        }
        if (status.length > 0) {
            diagnostics.dirtyWorkingTreeReason = project.maintenance?.dirtyWorkingTreeReason;
        }
        return { ok: true, executionRoot: context.executionRoot, diagnostics };
    }
    catch (error) {
        return {
            ok: false,
            executionRoot: context.executionRoot,
            reason: `Git preflight failed: ${errorMessage(error)}`,
            diagnostics
        };
    }
}
export function validateMaintenanceExecutionConfig(project, input, runner = runGit) {
    assertNoSecrets(input);
    if (!input.enabled) {
        return {
            executionRoot: undefined,
            maintenance: undefined,
            preflight: {
                ok: true,
                executionRoot: canonicalPath(project.path),
                diagnostics: {
                    projectId: project.id,
                    maintenanceMode: false,
                    registeredRoot: canonicalPath(project.path),
                    executionRoot: canonicalPath(project.path)
                }
            }
        };
    }
    const registeredRoot = canonicalExistingDirectory(project.path, "registered root");
    const liveRoot = canonicalExistingDirectory(requiredString(input.liveRoot, "maintenance.liveRoot"), "maintenance.liveRoot");
    const executionRoot = canonicalExistingDirectory(requiredString(input.executionRoot, "executionRoot"), "executionRoot");
    const baseBranch = requiredString(input.baseBranch, "maintenance.baseBranch");
    const expectedBranch = requiredString(input.expectedBranch, "maintenance.expectedBranch");
    const dirtyWorkingTreeReason = optionalString(input.dirtyWorkingTreeReason);
    if (input.allowDirtyWorkingTree && !dirtyWorkingTreeReason) {
        throw new Error("maintenance.dirtyWorkingTreeReason is required when allowDirtyWorkingTree is true.");
    }
    if (registeredRoot !== liveRoot) {
        throw new Error("Registered project root and maintenance.liveRoot must resolve to the same canonical path.");
    }
    const candidate = {
        ...project,
        path: registeredRoot,
        executionRoot,
        maintenance: {
            enabled: true,
            liveRoot,
            baseBranch,
            expectedBranch,
            ...(input.allowDirtyWorkingTree ? { allowDirtyWorkingTree: true, dirtyWorkingTreeReason } : {})
        }
    };
    const preflight = preflightWorkerLaunch(candidate, runner);
    if (!preflight.ok) {
        throw new Error(preflight.reason ?? "Maintenance Git preflight failed.");
    }
    return { executionRoot, maintenance: candidate.maintenance, preflight };
}
export function maintenanceStatus(project, runner = runGit) {
    const preflight = readOnlyMaintenancePreflight(project, runner);
    const sanitizedPreflight = sanitizePreflight(preflight);
    const maintenance = project.maintenance?.enabled
        ? {
            enabled: true,
            liveRoot: redactSensitiveText(canonicalPath(project.maintenance.liveRoot)),
            executionRoot: redactSensitiveText(canonicalPath(project.executionRoot ?? project.path)),
            baseBranch: redactSensitiveText(project.maintenance.baseBranch),
            expectedBranch: redactSensitiveText(project.maintenance.expectedBranch),
            allowDirtyWorkingTree: project.maintenance.allowDirtyWorkingTree === true
        }
        : {
            enabled: false,
            liveRoot: redactSensitiveText(canonicalPath(project.path)),
            executionRoot: redactSensitiveText(canonicalPath(project.executionRoot ?? project.path)),
            baseBranch: redactSensitiveText(project.defaultBranchName),
            expectedBranch: null,
            allowDirtyWorkingTree: false
        };
    return {
        ...maintenance,
        status: preflight.ok ? "ready" : "blocked",
        readOnly: true,
        preflight: sanitizedPreflight,
        canStart: preflight.ok,
        cannotStartReason: preflight.ok ? null : sanitizedPreflight.reason
    };
}
export function maintenanceStatusFromError(projectId, error) {
    const reason = `Unable to inspect maintenance readiness: ${errorMessage(error)}`;
    const preflight = {
        ok: false,
        executionRoot: "",
        reason,
        diagnostics: {
            projectId,
            diagnosticReadOnly: true
        }
    };
    return {
        enabled: null,
        status: "blocked",
        readOnly: true,
        preflight: sanitizePreflight(preflight),
        canStart: false,
        cannotStartReason: redactSensitiveText(reason)
    };
}
function readOnlyMaintenancePreflight(project, runner) {
    try {
        return preflightWorkerLaunch(project, runner);
    }
    catch (error) {
        return {
            ok: false,
            executionRoot: redactSensitiveText(project.executionRoot ?? project.path),
            reason: `Maintenance readiness diagnostic failed: ${errorMessage(error)}`,
            diagnostics: {
                projectId: project.id,
                maintenanceMode: project.maintenance?.enabled === true,
                registeredRoot: redactSensitiveText(project.path),
                executionRoot: redactSensitiveText(project.executionRoot ?? project.path),
                diagnosticReadOnly: true
            }
        };
    }
}
function validateMaintenanceRoots(context, liveRoot) {
    if (!fs.existsSync(context.executionRoot) || !fs.statSync(context.executionRoot).isDirectory()) {
        return `Maintenance execution root is missing or not a directory: ${context.executionRoot}.`;
    }
    if (context.executionRoot === context.registeredRoot) {
        return "Maintenance execution root must be distinct from the registered project root.";
    }
    if (context.executionRoot === liveRoot || isPathInsideRoot(context.executionRoot, liveRoot)) {
        return "Maintenance execution root points at or inside the live Project Pilot checkout.";
    }
    if (liveRoot === context.executionRoot || isPathInsideRoot(liveRoot, context.executionRoot)) {
        return "Live Project Pilot checkout must not be inside the maintenance execution root.";
    }
    return undefined;
}
function resolveBaseRef(project, baseBranch, runner, cwd) {
    const candidates = [
        `refs/heads/${baseBranch}`,
        project.gitRemoteName ? `refs/remotes/${project.gitRemoteName}/${baseBranch}` : "",
        `refs/remotes/origin/${baseBranch}`
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            runner(["show-ref", "--verify", "--quiet", candidate], cwd);
            return candidate.replace(/^refs\/(?:heads|remotes)\//, "");
        }
        catch {
            // Try the next known local or remote branch ref.
        }
    }
    throw new Error(`Base branch is unknown to this worktree: ${baseBranch}.`);
}
function parseWorktreeList(output) {
    return output
        .split(/\r?\n/)
        .map((line) => line.match(/^worktree (.+)$/)?.[1])
        .filter((worktree) => Boolean(worktree))
        .map((worktree) => path.resolve(worktree));
}
function redactStatusLine(line) {
    return line.replace(/\S+/g, (part, offset) => (offset < 3 ? part : path.basename(part)));
}
function runGit(args, cwd) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });
}
function validatePersistedMaintenanceConfig(project) {
    const config = project.maintenance;
    if (!config?.enabled) {
        return undefined;
    }
    if (!project.executionRoot) {
        return "Maintenance executionRoot is not configured.";
    }
    if (!config.liveRoot) {
        return "maintenance.liveRoot is not configured.";
    }
    if (!config.baseBranch) {
        return "maintenance.baseBranch is not configured.";
    }
    if (!config.expectedBranch) {
        return "maintenance.expectedBranch is not configured.";
    }
    return undefined;
}
function canonicalExistingDirectory(value, field) {
    const resolved = path.resolve(value);
    if (!path.isAbsolute(value)) {
        throw new Error(`${field} must be absolute.`);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`${field} is missing or not a directory: ${resolved}.`);
    }
    return canonicalPath(resolved);
}
function canonicalPath(value) {
    const resolved = path.resolve(value);
    try {
        return fs.realpathSync.native(resolved);
    }
    catch {
        return resolved;
    }
}
function requiredString(value, field) {
    const trimmed = value?.trim();
    if (!trimmed) {
        throw new Error(`${field} is required.`);
    }
    if (!path.isAbsolute(trimmed) && /Root$/i.test(field)) {
        throw new Error(`${field} must be absolute.`);
    }
    if (containsSecret(trimmed)) {
        throw new Error(`${field} must not contain secrets or API tokens.`);
    }
    return trimmed;
}
function optionalString(value) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    if (containsSecret(trimmed)) {
        throw new Error("maintenance configuration must not contain secrets or API tokens.");
    }
    return trimmed;
}
function assertNoSecrets(input) {
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === "string" && containsSecret(value)) {
            throw new Error(`${key} must not contain secrets or API tokens.`);
        }
    }
}
function sanitizePreflight(preflight) {
    const diagnostics = {};
    for (const [key, value] of Object.entries(preflight.diagnostics)) {
        diagnostics[key] = typeof value === "string" ? redactSensitiveText(value) : value;
    }
    return {
        ...preflight,
        executionRoot: redactSensitiveText(preflight.executionRoot),
        reason: preflight.reason ? redactSensitiveText(preflight.reason) : undefined,
        diagnostics
    };
}
function containsSecret(value) {
    return /\bsk-[A-Za-z0-9_-]{8,}\b/.test(value) || /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/.test(value);
}
function redactSensitiveText(text) {
    return text
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
        .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]");
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
