import { spawn } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ALLOWLISTED_PROJECT_ROOT, assertAllowedPath, assertRegisteredProjectRoot, dataPath } from "./paths.js";
export const CODEX_COMMAND = "codex";
export const CODEX_ACCESS_MODE = "full local access";
export const CODEX_APPROVAL_POLICY = "never";
export const CODEX_ACCESS_WARNING = "Tasks can access files and network outside the project folder.";
export function createTaskId() {
    return `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
export function createPlanId() {
    return `plan-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
export function assertTaskId(taskId) {
    if (!/^task-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(taskId)) {
        throw new Error("Invalid taskId.");
    }
    return taskId;
}
export function assertPlanId(planId) {
    if (!/^plan-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(planId)) {
        throw new Error("Invalid planId.");
    }
    return planId;
}
export function buildCodexExecArgs(projectRoot, sandbox = "danger-full-access") {
    const root = assertRegisteredProjectRoot(projectRoot);
    return ["--ask-for-approval", CODEX_APPROVAL_POLICY, "exec", "--cd", root, "--sandbox", sandbox, "--json"];
}
export function buildLogPath(taskId, kind) {
    assertTaskId(taskId);
    return dataPath(`${taskId}.${kind}.jsonl`);
}
export function buildPlanLogPath(planId) {
    assertPlanId(planId);
    return dataPath(`${planId}.plan.jsonl`);
}
export function spawnCodexJob(options) {
    const projectRoot = options.projectRoot ?? ALLOWLISTED_PROJECT_ROOT;
    const args = buildCodexExecArgs(projectRoot, options.sandbox ?? "danger-full-access");
    const logPath = assertAllowedPath(options.logPath);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = fs.createWriteStream(logPath, { flags: "a", encoding: "utf8" });
    const child = spawn(CODEX_COMMAND, args, {
        cwd: projectRoot,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
    });
    let stdoutText = "";
    child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stdoutText += text;
        if (stdoutText.length > 1_000_000) {
            stdoutText = stdoutText.slice(-1_000_000);
        }
        log.write(text);
    });
    child.stderr.on("data", (chunk) => {
        const line = JSON.stringify({
            type: "stderr",
            timestamp: new Date().toISOString(),
            text: chunk.toString("utf8")
        });
        log.write(`${line}\n`);
    });
    child.on("error", (error) => {
        log.write(`${JSON.stringify({ type: "error", timestamp: new Date().toISOString(), text: error.message })}\n`);
        options.onError(error);
    });
    child.on("exit", (exitCode, signal) => {
        log.write(`${JSON.stringify({ type: "exit", timestamp: new Date().toISOString(), exitCode, signal })}\n`);
        options.onExit(exitCode, signal, stdoutText);
    });
    child.on("close", (exitCode, signal) => {
        log.write(`${JSON.stringify({ type: "close", timestamp: new Date().toISOString(), exitCode, signal })}\n`);
        log.end();
        options.onClose?.(exitCode, signal, stdoutText);
    });
    child.stdin.end(options.prompt);
    return child;
}
