import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertAllowedPath } from "./paths.js";

const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOENT", "EEXIST", "ENOTEMPTY"]);
const DEFAULT_RETRIES = 6;
const DEFAULT_BACKOFF_MS = 20;
const MAX_SNAPSHOTS = 8;

type JsonFileOperation = typeof fs;

export interface JsonFileHealth {
  filePath: string;
  valid: boolean;
  exists: boolean;
  lastSuccessfulReadAt?: string;
  lastSuccessfulWriteAt?: string;
  lastError?: string;
  lastRecovery?: string;
  snapshotCount: number;
  orphanTempFiles: string[];
}

export class StateStoreError extends Error {
  readonly code: string;
  readonly filePath: string;
  readonly causeError?: unknown;

  constructor(code: string, filePath: string, message: string, causeError?: unknown) {
    super(message);
    this.name = "StateStoreError";
    this.code = code;
    this.filePath = filePath;
    this.causeError = causeError;
  }
}

export class DurableJsonFile<T> {
  private static readonly queues = new Map<string, Promise<unknown>>();
  private static readonly health = new Map<string, JsonFileHealth>();

  private readonly filePath: string;
  private readonly defaultState: () => T;
  private readonly normalize: (value: unknown) => T;
  private readonly ops: JsonFileOperation;
  private readonly retries: number;
  private readonly backoffMs: number;

  constructor(
    filePath: string,
    defaultState: () => T,
    normalize: (value: unknown) => T,
    options: { ops?: JsonFileOperation; retries?: number; backoffMs?: number } = {}
  ) {
    this.filePath = assertAllowedPath(filePath);
    this.defaultState = defaultState;
    this.normalize = normalize;
    this.ops = options.ops ?? fs;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  async read(): Promise<T> {
    return await this.withQueue(async () => await this.readUnlocked());
  }

  async write(state: T): Promise<void> {
    await this.withQueue(async () => {
      await this.writeUnlocked(this.normalize(state));
    });
  }

  async update<R>(updater: (state: T) => R | Promise<R | { state: T; result: R }>): Promise<R> {
    return await this.withQueue(async () => {
      const state = await this.readUnlocked();
      const output = await updater(state);
      if (isUpdateOutput<T, R>(output)) {
        await this.writeUnlocked(this.normalize(output.state));
        return output.result;
      }
      await this.writeUnlocked(this.normalize(state));
      return output as R;
    });
  }

  async health(): Promise<JsonFileHealth> {
    const current = DurableJsonFile.health.get(this.filePath) ?? this.emptyHealth();
    return {
      ...current,
      ...(await this.scanArtifacts())
    };
  }

  private async withQueue<R>(operation: () => Promise<R>): Promise<R> {
    const previous = DurableJsonFile.queues.get(this.filePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    DurableJsonFile.queues.set(this.filePath, next.catch(() => undefined));
    return await next;
  }

  private async readUnlocked(): Promise<T> {
    await this.withRetry(() => this.ops.mkdir(path.dirname(this.filePath), { recursive: true }), "mkdir");
    try {
      const text = await this.readTextWithMissingFastPath();
      const parsed = parseJson(text, this.filePath);
      const state = this.normalize(parsed);
      await this.markHealth({ exists: true, valid: true, lastSuccessfulReadAt: nowIso(), lastError: undefined });
      return state;
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT") {
        await this.markHealth({ exists: false, valid: true, lastSuccessfulReadAt: nowIso(), lastError: undefined });
        return this.defaultState();
      }
      if (error instanceof StateStoreError && error.code === "invalid_json") {
        const recovered = await this.recoverFromCorruption(error);
        await this.markHealth({
          exists: true,
          valid: true,
          lastSuccessfulReadAt: nowIso(),
          lastRecovery: recovered.recovery,
          lastError: undefined
        });
        return recovered.state;
      }
      await this.markHealth({ valid: false, lastError: errorMessage(error) });
      throw this.toStateStoreError("read_failed", `Failed to read ${this.filePath}: ${errorMessage(error)}`, error);
    }
  }

  private async readTextWithMissingFastPath(): Promise<string> {
    try {
      return await this.ops.readFile(this.filePath, "utf8");
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        throw error;
      }
      return await this.withRetry(() => this.ops.readFile(this.filePath, "utf8"), "read");
    }
  }

  private async writeUnlocked(state: T): Promise<void> {
    await this.withRetry(() => this.ops.mkdir(path.dirname(this.filePath), { recursive: true }), "mkdir");
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    parseJson(payload, this.filePath);
    const tempFile = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let replaceBackup: string | undefined;
    try {
      const handle = await this.withRetry(() => this.ops.open(tempFile, "wx"), "open_temp");
      try {
        await this.withRetry(() => handle.writeFile(payload, "utf8"), "write_temp");
        await this.withRetry(() => handle.sync(), "sync_temp");
      } finally {
        await handle.close().catch(() => undefined);
      }

      await this.snapshotLiveIfValid();
      replaceBackup = `${this.filePath}.replace-${process.pid}-${randomUUID()}.bak`;
      await this.moveLiveAsideIfPresent(replaceBackup);
      await this.withRetry(() => this.ops.rename(tempFile, this.filePath), "rename_temp_to_live");
      await this.ops.unlink(replaceBackup).catch(() => undefined);
      await this.cleanupSnapshots();
      await this.markHealth({ exists: true, valid: true, lastSuccessfulWriteAt: nowIso(), lastError: undefined });
    } catch (error) {
      if (replaceBackup) {
        await this.restoreLiveIfMissing(replaceBackup);
      }
      await this.ops.unlink(tempFile).catch(() => undefined);
      await this.markHealth({ valid: false, lastError: errorMessage(error) });
      throw this.toStateStoreError("write_failed", `Failed to durably write ${this.filePath}: ${errorMessage(error)}`, error);
    }
  }

  private async snapshotLiveIfValid(): Promise<void> {
    try {
      const text = await this.withRetry(() => this.ops.readFile(this.filePath, "utf8"), "read_live_for_snapshot");
      parseJson(text, this.filePath);
      const snapshot = `${this.filePath}.snapshot-${timestampForFile()}-${randomUUID()}.bak`;
      await this.withRetry(() => this.ops.copyFile(this.filePath, snapshot), "copy_snapshot");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof StateStoreError)) {
        throw error;
      }
    }
  }

  private async moveLiveAsideIfPresent(replaceBackup: string): Promise<void> {
    try {
      await this.ops.access(this.filePath);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    try {
      await this.withRetry(() => this.ops.rename(this.filePath, replaceBackup), "rename_live_to_replace_backup");
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  private async restoreLiveIfMissing(replaceBackup: string): Promise<void> {
    try {
      await this.ops.access(this.filePath);
    } catch {
      try {
        await this.withRetry(() => this.ops.rename(replaceBackup, this.filePath), "restore_live_after_failed_replace");
      } catch {
        // The original failure is more useful to callers than a best-effort restore failure.
      }
    }
  }

  private async recoverFromCorruption(error: StateStoreError): Promise<{ state: T; recovery: string }> {
    const corruptName = `${this.filePath}.corrupt-${timestampForFile()}-${randomUUID()}.json`;
    await this.withRetry(() => this.ops.rename(this.filePath, corruptName), "preserve_corrupt_live");
    const candidates = await this.validRecoveryCandidates();
    if (candidates.length === 0) {
      throw this.toStateStoreError(
        "invalid_json",
        `State file ${this.filePath} is invalid and no valid snapshot or temp candidate was found. Corrupt file preserved at ${corruptName}.`,
        error
      );
    }
    const selected = candidates[0];
    await this.withRetry(() => this.ops.copyFile(selected.filePath, this.filePath), "copy_recovery_candidate");
    return {
      state: this.normalize(selected.parsed),
      recovery: `Recovered ${this.filePath} from ${path.basename(selected.filePath)}; corrupt original preserved as ${path.basename(corruptName)}.`
    };
  }

  private async validRecoveryCandidates(): Promise<Array<{ filePath: string; mtimeMs: number; parsed: unknown }>> {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const entries = await this.withRetry(() => this.ops.readdir(dir, { withFileTypes: true }), "readdir_recovery");
    const candidates: Array<{ filePath: string; mtimeMs: number; parsed: unknown }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isRecoveryCandidate(base, entry.name)) {
        continue;
      }
      const candidatePath = path.join(dir, entry.name);
      try {
        const [stat, text] = await Promise.all([
          this.withRetry(() => this.ops.stat(candidatePath), "stat_recovery_candidate"),
          this.withRetry(() => this.ops.readFile(candidatePath, "utf8"), "read_recovery_candidate")
        ]);
        candidates.push({ filePath: candidatePath, mtimeMs: stat.mtimeMs, parsed: parseJson(text, candidatePath) });
      } catch {
        // Invalid candidates are deliberately ignored; recovery must be deterministic from valid files only.
      }
    }
    return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath));
  }

  private async cleanupSnapshots(): Promise<void> {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const entries = await this.withRetry(() => this.ops.readdir(dir, { withFileTypes: true }), "readdir_cleanup");
    const snapshots = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${base}.snapshot-`) || !entry.name.endsWith(".bak")) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      const stat = await this.withRetry(() => this.ops.stat(filePath), "stat_snapshot");
      snapshots.push({ filePath, mtimeMs: stat.mtimeMs });
    }
    for (const snapshot of snapshots.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(MAX_SNAPSHOTS)) {
      await this.withRetry(() => this.ops.unlink(snapshot.filePath), "cleanup_old_snapshot").catch(() => undefined);
    }
  }

  private async scanArtifacts(): Promise<Pick<JsonFileHealth, "snapshotCount" | "orphanTempFiles">> {
    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      const entries = await this.ops.readdir(dir, { withFileTypes: true });
      let snapshotCount = 0;
      const orphanTempFiles: string[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (entry.name.startsWith(`${base}.snapshot-`) && entry.name.endsWith(".bak")) {
          snapshotCount += 1;
        }
        if (entry.name.startsWith(`${base}.`) && entry.name.endsWith(".tmp")) {
          orphanTempFiles.push(entry.name);
        }
      }
      return { snapshotCount, orphanTempFiles: orphanTempFiles.sort() };
    } catch {
      return { snapshotCount: 0, orphanTempFiles: [] };
    }
  }

  private async withRetry<R>(operation: () => Promise<R>, label: string): Promise<R> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (!TRANSIENT_CODES.has(code ?? "") || attempt >= this.retries) {
          break;
        }
        await this.markHealth({ lastError: `state_store_retrying ${label}: ${code} attempt ${attempt + 1}` });
        await sleep(this.backoffMs * 2 ** attempt);
      }
    }
    throw this.toStateStoreError("transient_exhausted", `State store operation ${label} failed after retries: ${errorMessage(lastError)}`, lastError);
  }

  private toStateStoreError(code: string, message: string, error: unknown): StateStoreError {
    return error instanceof StateStoreError ? error : new StateStoreError(code, this.filePath, message, error);
  }

  private async markHealth(update: Partial<JsonFileHealth>): Promise<void> {
    DurableJsonFile.health.set(this.filePath, {
      ...(DurableJsonFile.health.get(this.filePath) ?? this.emptyHealth()),
      ...update,
      ...(await this.scanArtifacts())
    });
  }

  private emptyHealth(): JsonFileHealth {
    return { filePath: this.filePath, exists: false, valid: true, snapshotCount: 0, orphanTempFiles: [] };
  }
}

function parseJson(text: string, filePath: string): unknown {
  if (!text.trim()) {
    throw new StateStoreError("invalid_json", filePath, `State file ${filePath} is empty.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StateStoreError("invalid_json", filePath, `State file ${filePath} contains invalid JSON: ${errorMessage(error)}`, error);
  }
}

function isUpdateOutput<T, R>(value: unknown): value is { state: T; result: R } {
  return Boolean(value && typeof value === "object" && "state" in value && "result" in value);
}

function isRecoveryCandidate(base: string, name: string): boolean {
  return (
    (name.startsWith(`${base}.snapshot-`) && name.endsWith(".bak")) ||
    (name.startsWith(`${base}.`) && name.endsWith(".tmp")) ||
    (name.startsWith(`${base}.replace-`) && name.endsWith(".bak"))
  );
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoCode(error: unknown): string | undefined {
  if (error instanceof StateStoreError) {
    return errnoCode(error.causeError);
  }
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
