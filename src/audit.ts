import type { AutopilotRunRecord, AutopilotTimelineEntry } from "./types.js";

export type AuditExplanationCategory =
  | "blocked"
  | "approval"
  | "retry-recovery"
  | "finalization"
  | "user-action-needed"
  | "status";

export interface AuditExplanation {
  at: string;
  kind: AutopilotTimelineEntry["kind"];
  summary: string;
  category: AuditExplanationCategory;
  explanation: string;
  userActionRequired: boolean;
}

export interface AutopilotAuditSummary {
  userActionRequired: boolean;
  runStateExplanation: string;
  explanations: AuditExplanation[];
}

export function buildAutopilotAuditSummary(run: AutopilotRunRecord): AutopilotAuditSummary {
  const explanations = run.timeline.slice(-30).map(explainTimelineEntry);
  const stateExplanation = runStateExplanation(run);
  const userActionRequired =
    ["blocked", "paused", "usage-limited"].includes(run.status) ||
    explanations.some((entry) => entry.userActionRequired);

  return {
    userActionRequired,
    runStateExplanation: stateExplanation,
    explanations
  };
}

export function explainTimelineEntry(entry: AutopilotTimelineEntry): AuditExplanation {
  const text = entry.summary;
  const category = classifyTimelineEntry(text);
  const userActionRequired =
    category === "user-action-needed" ||
    category === "approval" ||
    (category === "blocked" && !/recovery queued|resumed|reconciled/i.test(text));

  return {
    at: entry.at,
    kind: entry.kind,
    summary: text,
    category,
    explanation: explanationForCategory(category, text),
    userActionRequired
  };
}

function classifyTimelineEntry(text: string): AuditExplanationCategory {
  if (/manual approval|approval declined|manually approved|requires approval|requires manual/i.test(text)) {
    return "approval";
  }
  if (/finalized|auto-finalized|completed|finalize_project|Project complete|reviewed and finalized/i.test(text)) {
    return "finalization";
  }
  if (/recovery|reconciled|retry|corrected|resume/i.test(text)) {
    return "retry-recovery";
  }
  if (/blocked|state_store_unavailable|preflight|OPENAI_API_KEY|manager_api|budget reached|Maximum tasks/i.test(text)) {
    return "blocked";
  }
  if (/Paused|Stopped|user-controlled resume|user action/i.test(text)) {
    return "user-action-needed";
  }
  return "status";
}

function explanationForCategory(category: AuditExplanationCategory, text: string): string {
  switch (category) {
    case "approval":
      return "Approval policy requires an explicit operator decision before Project Pilot can mark this work complete or continue automatically.";
    case "blocked":
      return "Project Pilot stopped automatic progress because a configuration, limit, state-store, manager API, or maintenance preflight condition must be resolved first.";
    case "retry-recovery":
      return "This entry records a bounded retry, correction, worker reconciliation, or operational recovery path rather than a new unrestricted work attempt.";
    case "finalization":
      return "This entry records task or project finalization after the configured build, review, verification, and approval gates were evaluated.";
    case "user-action-needed":
      return "The run is intentionally waiting for an operator-controlled action such as resume, stop, approval, or limit adjustment.";
    case "status":
      return "Status event recorded for audit context.";
  }
}

function runStateExplanation(run: AutopilotRunRecord): string {
  if (run.status === "blocked") {
    return `Run is blocked. User action is required before automatic work can continue: ${run.pauseReason ?? "no detailed blocker recorded"}`;
  }
  if (run.status === "usage-limited") {
    return `Run reached a configured usage limit and is waiting for an explicit limit update or resume decision: ${run.pauseReason ?? "usage limit reached"}`;
  }
  if (run.status === "paused") {
    return `Run is paused for operator control: ${run.pauseReason ?? "no pause reason recorded"}`;
  }
  if (run.status === "completed") {
    return `Run completed and is ready for manual handoff/review: ${run.completionSummary ?? "completed"}`;
  }
  if (run.status === "stopped") {
    return `Run was stopped by an explicit action: ${run.stopReason ?? "stopped"}`;
  }
  if (run.status === "failed") {
    return "Run failed and should be inspected before restarting work.";
  }
  return "Run is eligible for scheduler progress subject to queue, runtime, and worker state.";
}
