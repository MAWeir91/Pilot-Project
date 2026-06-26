export type JobStatus = "queued" | "running" | "passed" | "failed" | "stopped" | "blocked";

export type TaskStatus =
  | "queued"
  | "building"
  | "build-passed"
  | "reviewing"
  | "needs-fixes"
  | "ready-for-approval"
  | "completed"
  | "failed"
  | "blocked"
  | "stopped";

export type LegacyTaskStatus = "running" | "passed";
export type PersistedTaskStatus = TaskStatus | LegacyTaskStatus;

export type ReviewResult = "pass" | "needs-fixes" | "blocked";
export type PlanStatus = "queued" | "planning" | "plan-ready" | "plan-blocked";
export type ApprovalMode = "auto_for_safe_tasks" | "manual_approval_required";
export type ApprovalDecisionStatus = "eligible" | "manual_approval_required" | "completed";

export type RiskFlag =
  | "deployment"
  | "dangerous_git_operation"
  | "production_database_migration"
  | "data_deletion"
  | "credentials_or_secrets"
  | "payments_or_spending"
  | "brokerage_or_trading"
  | "external_service_integration"
  | "network_exposure";

export interface ApprovalDecision {
  mode: ApprovalMode;
  status: ApprovalDecisionStatus;
  eligible: boolean;
  reasons: string[];
  riskFlags: RiskFlag[];
  riskEvidence: RiskEvidence[];
}

export type RiskEvidenceSource = "changed_file" | "task_text" | "policy_rule" | "reviewer_finding" | "build_report";
export type RiskEvidenceConfidence = "supported" | "unsupported" | "needs-review";

export interface RiskEvidence {
  flag: RiskFlag;
  confidence: RiskEvidenceConfidence;
  source: RiskEvidenceSource;
  sourcePath: string;
  matchedBehavior: string;
  policyRule: string;
  excerpt: string;
}

export type ApprovalActionKind = "approved" | "declined";

export interface ApprovalActionRecord {
  kind: ApprovalActionKind;
  at: string;
  taskId: string;
  runId?: string;
  reason: string;
  reviewedRiskEvidence?: boolean;
  priorRiskFlags: RiskFlag[];
  riskEvidence: RiskEvidence[];
  resultingStatus: TaskStatus;
}

export type VerificationStatus = "passed" | "failed" | "unknown";
export type VerificationEvidenceSource = "build-worker" | "reconciled-from-evidence";
export type VerificationDisplayStatus = VerificationStatus | "reconciled-from-evidence";

export interface VerificationEvidenceRef {
  source: VerificationEvidenceSource;
  taskId: string;
  executionRoot: string;
  expectedCommands: string[];
  outputRef: string;
  recordedAt: string;
  explanation: string;
}

export interface VerificationRecord {
  command: string;
  attempt: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  status: VerificationStatus;
  outputRef?: string;
  isCurrent: boolean;
  evidence?: VerificationEvidenceRef;
}

export interface VerificationAuditEvent {
  at: string;
  kind: "verification-reconciled" | "verification-recorded";
  source: VerificationEvidenceSource;
  status: VerificationDisplayStatus;
  taskId: string;
  executionRoot: string;
  expectedCommands: string[];
  outputRef: string;
  explanation: string;
}

export interface TaskInput {
  projectId?: string;
  title: string;
  requirements: string;
  acceptanceCriteria: string[];
}

export interface ProjectRecord {
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
  maintenance?: ProjectMaintenanceConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMaintenanceConfig {
  enabled: boolean;
  liveRoot: string;
  baseBranch: string;
  expectedBranch: string;
  allowDirtyWorkingTree?: boolean;
  dirtyWorkingTreeReason?: string;
}

export interface ProjectRegistryState {
  projects: ProjectRecord[];
  activeProjectId?: string;
}

export interface JobRecord {
  status: JobStatus;
  logPath: string;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  error?: string;
}

export interface ReviewRecord extends JobRecord {
  result?: ReviewResult;
}

export interface TaskRecord {
  id: string;
  projectId?: string;
  sourcePlanId?: string;
  title: string;
  requirements: string;
  acceptanceCriteria: string[];
  status: PersistedTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  build: JobRecord;
  review?: ReviewRecord;
  verification?: VerificationRecord[];
  verificationEvents?: VerificationAuditEvent[];
  approvalActions?: ApprovalActionRecord[];
}

export interface TaskState {
  tasks: TaskRecord[];
  plans?: PlanRecord[];
  projectBriefs?: ProjectBriefRecord[];
  autopilotRuns?: AutopilotRunRecord[];
}

export interface TaskSummary {
  title: string;
  projectId: string;
  projectName: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  status: TaskStatus;
  codexAccessMode: string;
  codexApprovalPolicy: string;
  codexAccessWarning: string;
  approval: ApprovalDecision;
  verificationStatus: VerificationDisplayStatus;
  verificationSummary: string;
  buildSummary: string;
  reviewResult: ReviewResult | null;
  latestLogLines: string[];
}

export interface PlanInput {
  projectId: string;
  title: string;
  requirements: string;
  constraints: string;
}

export interface PlanRecord {
  id: string;
  projectId: string;
  title: string;
  requirements: string;
  constraints: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  logPath: string;
  reportPath: string;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  error?: string;
}

export interface PlanSummary {
  planId: string;
  projectId: string;
  projectName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: PlanStatus;
  summary: string;
  reportPath: string;
  error?: string;
  latestLogLines: string[];
}

export interface PlanDetails extends PlanSummary {
  requirements: string;
  constraints: string;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  statusHistory: PlanStatusHistoryEntry[];
  errors: string[];
  logTail: string;
  report: string | null;
  log: string;
}

export interface PlanStatusHistoryEntry {
  status: PlanStatus;
  at: string;
  source: string;
}

export interface TaskStatusHistoryEntry {
  status: TaskStatus;
  at: string;
  source: string;
}

export interface TaskDetails extends TaskSummary {
  requirements: string;
  acceptanceCriteria: string[];
  statusHistory: TaskStatusHistoryEntry[];
  errors: string[];
  buildLog: string;
  reviewLog: string;
  buildReport: string | null;
  reviewReport: string | null;
  verification: VerificationRecord[];
  verificationEvents: VerificationAuditEvent[];
  approvalActions?: ApprovalActionRecord[];
}

export type AutopilotStatus =
  | "queued"
  | "running"
  | "paused"
  | "blocked"
  | "usage-limited"
  | "completed"
  | "stopped"
  | "failed";

export type AutopilotPhase =
  | "idle"
  | "planning"
  | "consulting-architect"
  | "queuing-tasks"
  | "building"
  | "reviewing"
  | "fixing"
  | "finalizing"
  | "paused"
  | "completed"
  | "stopped";

export const MANAGER_DECISION_ACTIONS = [
  "create_plan",
  "revise_plan",
  "create_ordered_tasks",
  "start_next_task",
  "request_one_fix_attempt",
  "finalize_current_task",
  "skip_duplicate_task",
  "finalize_project",
  "pause_for_blocker",
  "stop"
] as const;

export type ManagerDecisionAction = (typeof MANAGER_DECISION_ACTIONS)[number];

export interface ProjectBriefInput {
  projectId: string;
  title: string;
  productSummary: string;
  requirements: string;
  constraints: string;
  decisions: string[];
  definitionOfDone: string[];
  planId?: string;
}

export interface ProjectBriefRecord extends ProjectBriefInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotTaskQueueItem {
  id: string;
  title: string;
  requirements: string;
  acceptanceCriteria: string[];
  source: "manager" | "fix" | "recovery";
  taskId?: string;
  status: "queued" | "active" | "completed" | "failed" | "skipped" | "blocked";
  fixAttemptForTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotTimelineEntry {
  at: string;
  kind:
    | "manager-decision"
    | "architect-consultation"
    | "builder-summary"
    | "reviewer-summary"
    | "status"
    | "notification";
  summary: string;
  data?: Record<string, unknown>;
}

export interface ManagerDecisionRecord {
  at: string;
  action: ManagerDecisionAction;
  summary: string;
  reason?: string;
}

export interface CodexThreadRecord {
  architectThreadId?: string;
  architectSummary?: string;
  builderSummary?: string;
  reviewerSummary?: string;
  updatedAt?: string;
}

export interface AutopilotRunLimits {
  maxManagerDecisions: number;
  maxTasks: number;
  maxFixAttemptsPerTask: number;
  maxRuntimeMs: number;
}

export interface AutopilotRuntimeSnapshot {
  activeRuntimeMs: number;
  wallClockElapsedMs: number;
  runtimeLimitMs: number;
  remainingActiveRuntimeMs: number;
  activeRuntimeStartedAt?: string;
}

export type AutopilotAttemptType = "manager" | "recovery" | "reviewer-fix";
export type AutopilotWorkerPhase = "build" | "review" | "recovery" | "fix" | "finalization";
export type AutopilotWorkerLeaseStatus = "active" | "completed" | "failed" | "dead" | "recovered";

export interface AutopilotWorkerLease {
  id: string;
  runId: string;
  taskId: string;
  phase: AutopilotWorkerPhase;
  pid?: number;
  command: string;
  startedAt: string;
  endedAt?: string;
  attemptType: AutopilotAttemptType;
  reportPath: string;
  expectedArtifact: string;
  logPath?: string;
  lastActivityAt?: string;
  status: AutopilotWorkerLeaseStatus;
  outcome?: string;
}

export interface AutopilotSchedulerState {
  lastTickAt?: string;
  nextScheduledTickAt?: string;
  inProgress?: boolean;
  dispatchStatus?: string;
  lastDispatchOutcome?: string;
  skippedDispatchReason?: string;
}

export interface AutopilotRunRecord {
  id: string;
  projectId: string;
  briefId: string;
  planId?: string;
  status: AutopilotStatus;
  phase: AutopilotPhase;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endedAt?: string;
  pausedAt?: string;
  pauseReason?: string;
  stopReason?: string;
  completionSummary?: string;
  currentTaskId?: string;
  lastCompletedTaskId?: string;
  activeRuntimeMs?: number;
  activeRuntimeStartedAt?: string;
  nextAction?: ManagerDecisionAction | null;
  decisionsUsed: number;
  tasksStarted: number;
  fixAttemptsByTaskId: Record<string, number>;
  recoveryAttemptsByTaskId?: Record<string, number>;
  queue: AutopilotTaskQueueItem[];
  decisions: ManagerDecisionRecord[];
  timeline: AutopilotTimelineEntry[];
  codexThreads: CodexThreadRecord;
  limits: AutopilotRunLimits;
  scheduler?: AutopilotSchedulerState;
  workers?: AutopilotWorkerLease[];
}
