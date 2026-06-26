import { deriveTaskStatus } from "./task-status.js";
const DEFAULT_APPROVAL_MODE = "auto_for_safe_tasks";
const RISK_PATTERNS = [
    {
        flag: "deployment",
        patterns: [
            /\b(?:deploy|deployment|release|publish)\s+(?:script|command|workflow|pipeline|configuration|config|to production|production release)\b/i,
            /\b(?:vercel|netlify|firebase|render|fly\.io|cloudflare pages|aws|azure|gcp|github pages|gh-pages)\b[^\n.]{0,120}\b(?:deploy|hosting|production|publish|release)\b/i,
            /\b(?:npm run deploy|vercel --prod|netlify deploy|firebase deploy|wrangler deploy|gh-pages)\b/i,
            /"deploy"\s*:\s*"[^"]+"/i
        ]
    },
    {
        flag: "dangerous_git_operation",
        patterns: [
            /\bforce\s+push\b/i,
            /\bgit\s+push\b[^\n]*(?:--force|-f|--force-with-lease)\b/i,
            /\bdelete\s+(?:a\s+)?branch\b/i,
            /\bdelete\s+(?:the\s+)?(?:remote\s+)?[a-z0-9._/-]*\s*branch\b/i,
            /\bbranch deletion\b/i,
            /\bgit\s+branch\s+-D\b/i,
            /\bgit\s+push\b[^\n]*--delete\b/i,
            /\brewrite(?:ing)?\s+git\s+history\b/i,
            /\bgit\s+reset\s+--hard\b/i,
            /\bpushing rebased history\b/i,
            /\bpush\s+rebased\s+history\b/i,
            /\bchang(?:e|ing)\s+git\s+remote(?:s|\s+urls?)?\b/i,
            /\bgit\s+remote\s+(?:add|set-url|remove|rename)\b/i,
            /\brepository permissions?\b/i,
            /\bbranch protections?\b/i,
            /\borganization settings?\b/i,
            /\bpush(?:ing)?\s+directly\s+to\s+(?:main|master|protected branch)\b/i,
            /\bgit\s+push\b[^\n]*(?:origin\s+)?(?:main|master)\b/i,
            /\bmerge(?:ing)?\s+(?:the\s+)?pull requests?(?:\s+into)?\s+(?:main|master|a\s+protected branch|protected branch)\b/i
        ]
    },
    {
        flag: "production_database_migration",
        patterns: [/\bproduction\s+database\s+migration\b/i, /\bmigrate\s+production\s+database\b/i]
    },
    {
        flag: "data_deletion",
        patterns: [/\bdelete\s+(?:user|project)\s+data\b/i, /\bdrop\s+(?:user|project)\s+data\b/i]
    },
    {
        flag: "credentials_or_secrets",
        patterns: []
    },
    {
        flag: "payments_or_spending",
        patterns: [
            /\b(?:stripe|paypal|square|braintree|adyen|checkout session|payment intent|billing api|payment sdk)\b/i,
            /\b(?:add|create|implement|configure|integrate|store|send|process|handle)\b[^\n.]{0,120}\b(?:payments?|checkout|billing|subscriptions?|purchases?)\b/i,
            /\b(?:charge|spend|purchase)\s+(?:money|funds|real money)\b/i
        ]
    },
    {
        flag: "brokerage_or_trading",
        patterns: [
            /\b(?:connect|integrate|authenticate|trade|place order|submit order)\b[^\n.]{0,120}\b(?:brokerage|trading account|broker account|financial api)\b/i,
            /\b(?:real trading|live trading|brokerage api|financial api credentials?)\b/i
        ]
    },
    {
        flag: "external_service_integration",
        patterns: [
            /\b(?:integrate|connect|configure|call|send|sync)\b[^\n.]{0,120}\b(?:external service|third-party service|remote api|external api|webhook|cloud service)\b/i,
            /\b(?:fetch|axios|XMLHttpRequest)\b[^\n.]{0,160}\bhttps?:\/\//i
        ]
    },
    {
        flag: "network_exposure",
        patterns: [/\bfirewall\b/i, /\bnetwork exposure\b/i, /\bbind\s+(?:to\s+)?0\.0\.0\.0\b/i, /\bpublicly expose\b/i]
    }
];
const PASSED_RESULT_PATTERN = /\b(?:result|status|final status)\s*:\s*passed\b/i;
const FAILED_RESULT_PATTERN = /\b(?:result|status|final status)\s*:\s*(?:failed|error|blocked)\b/i;
const NO_COMMANDS_PATTERN = /\bno\s+(?:test|check|lint|build|configured|available|npm|package\.json)[^\n]*(?:command|commands|available|configuration|exists)/i;
const COMMAND_KEYWORDS = /\b(test|check|lint|build)\b/i;
export function approvalMode() {
    return process.env.PROJECT_PILOT_APPROVAL_MODE === "manual_approval_required"
        ? "manual_approval_required"
        : DEFAULT_APPROVAL_MODE;
}
export function evaluateApprovalPolicy(options) {
    const mode = options.mode ?? approvalMode();
    const reasons = [];
    const riskEvidence = detectRiskEvidence(options.task, options.buildReport, options.reviewReport);
    const riskFlags = uniqueRiskFlags(riskEvidence);
    const taskStatus = deriveTaskStatus(options.task);
    if (mode === "manual_approval_required") {
        reasons.push("Approval policy mode is manual_approval_required.");
    }
    if (options.task.build.status !== "passed") {
        reasons.push("Build status is not passed.");
    }
    if (options.task.review?.status !== "passed" || options.task.review?.result !== "pass") {
        reasons.push("Review result/status is not pass.");
    }
    const commandEvidence = evaluateCommandEvidence({
        buildReport: options.buildReport,
        configuredCommands: options.configuredCommands,
        verification: options.verification ?? options.task.verification
    });
    if (!commandEvidence.ok) {
        reasons.push(commandEvidence.reason);
    }
    if (riskFlags.length > 0) {
        reasons.push(`Risk flags require manual approval: ${riskFlags.join(", ")}.`);
    }
    if (hasReviewerBlocker(options.reviewReport)) {
        reasons.push("Reviewer blocker or unresolved high-priority issue exists.");
    }
    if (taskStatus !== "ready-for-approval" && taskStatus !== "completed") {
        reasons.push(`Task status is ${taskStatus}, not ready-for-approval.`);
    }
    const eligible = mode === "auto_for_safe_tasks" && reasons.length === 0;
    return {
        mode,
        status: taskStatus === "completed" ? "completed" : eligible ? "eligible" : "manual_approval_required",
        eligible,
        reasons: eligible ? ["Eligible for automatic completion."] : reasons,
        riskFlags,
        riskEvidence
    };
}
export function projectVerificationCommands(project) {
    return uniqueCommands([project.testCommand, project.checkCommand, project.buildCommand]);
}
export function parseVerificationRecords(options) {
    const configured = uniqueCommands(options.configuredCommands);
    if (!options.buildReport?.trim() || configured.length === 0) {
        return [];
    }
    const records = [];
    const attempts = new Map();
    for (const block of commandBlocks(options.buildReport)) {
        const command = extractCommand(block);
        if (!command || !configured.some((configuredCommand) => sameCommand(configuredCommand, command))) {
            continue;
        }
        const canonicalCommand = configured.find((configuredCommand) => sameCommand(configuredCommand, command)) ?? command;
        const attempt = (attempts.get(canonicalCommand) ?? 0) + 1;
        attempts.set(canonicalCommand, attempt);
        records.push({
            command: canonicalCommand,
            attempt,
            startedAt: options.startedAt,
            endedAt: options.endedAt,
            exitCode: resultStatus(block) === "passed" ? 0 : resultStatus(block) === "failed" ? 1 : null,
            status: resultStatus(block),
            outputRef: options.outputRef,
            isCurrent: false
        });
    }
    const latestByCommand = new Map();
    records.forEach((record, index) => {
        latestByCommand.set(record.command, index);
    });
    return records.map((record, index) => ({
        ...record,
        isCurrent: latestByCommand.get(record.command) === index
    }));
}
export function assertNoRiskFlagsForManualApproval(decision) {
    if (decision.riskFlags.length > 0) {
        throw new Error(`Manual approval is refused because risk flags are present: ${decision.riskFlags.join(", ")}.`);
    }
}
function detectRiskEvidence(task, buildReport, reviewReport) {
    const sources = riskSources(task, buildReport, reviewReport);
    const evidence = [];
    for (const source of sources) {
        evidence.push(...detectCredentialEvidence(source));
        for (const risk of RISK_PATTERNS.filter((candidate) => candidate.flag !== "credentials_or_secrets")) {
            for (const pattern of risk.patterns) {
                for (const match of source.text.matchAll(globalPattern(pattern))) {
                    const index = match.index ?? 0;
                    if (hasNegatedContext(source.text, index) || isEvidenceOfAbsence(source.text, index)) {
                        evidence.push(unsupportedEvidence(risk.flag, source, match[0], "Risk wording appears only in negative/exclusion context.", index));
                        continue;
                    }
                    const confidence = confidenceForSource(source, risk.flag, index);
                    evidence.push({
                        flag: risk.flag,
                        confidence,
                        source: source.source,
                        sourcePath: source.sourcePath,
                        matchedBehavior: match[0],
                        policyRule: confidence === "unsupported" ? reportOnlyPolicyRule(risk.flag) : policyRuleFor(risk.flag),
                        excerpt: sentenceAround(source.text, index).trim()
                    });
                }
            }
        }
    }
    return dedupeRiskEvidence(evidence);
}
function uniqueRiskFlags(evidence) {
    return [...new Set(evidence.filter((item) => item.confidence !== "unsupported").map((item) => item.flag))].sort();
}
function riskSources(task, buildReport, reviewReport) {
    const sources = [
        {
            source: "task_text",
            sourcePath: "task requirements",
            text: [task.title, task.requirements, ...task.acceptanceCriteria].join("\n")
        },
        {
            source: "build_report",
            sourcePath: "BUILD_REPORT.md",
            text: buildReport ?? ""
        },
        {
            source: "reviewer_finding",
            sourcePath: "REVIEW_REPORT.md",
            text: reviewReport ?? ""
        }
    ];
    return sources.filter((source) => source.text.trim().length > 0);
}
const SECRET_FILE_PATTERN = /(?:^|[\\/\s`"'])((?:\.env(?:\.[\w.-]+)?|credentials?\.(?:json|ya?ml|toml|ini)|secrets?\.(?:json|ya?ml|toml|ini)|\.npmrc|\.pypirc|id_rsa|id_ed25519))(?:$|[\\/\s`"',.:;])/gi;
const SECRET_VALUE_PATTERN = /\b(?:[A-Za-z0-9_]*?(?:api[_-]?key|secret|token|password|credential|client[_-]?secret)[A-Za-z0-9_]*?)\b\s*[:=]\s*['"]?([A-Za-z0-9_./+=-]{16,})['"]?/gi;
const ENV_SECRET_ACCESS_PATTERN = /\b(?:process\.env|import\.meta\.env|Deno\.env\.get)\s*(?:\.|\(\s*['"`])([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z0-9_]*)/gi;
const AUTH_FLOW_PATTERN = /\b(?:oauth|openid|jwt|bearer token|basic auth|authorization header|authentication flow|login credential|credential storage)\b/gi;
const REMOTE_SECRET_CONFIG_PATTERN = /\b(?:remote api|external api|api endpoint|authorization)\b[^\n]*(?:key|token|secret|credential)/gi;
const CREDENTIAL_OPERATION_PATTERN = /\b(?:add|create|store|save|persist|log|transmit|send|rotate|update|modify|read|access|handle)\b[^\n.]{0,120}\b(?:credentials?|secrets?|api\s*keys?|tokens?|passwords?)\b/gi;
function detectCredentialEvidence(source) {
    const evidence = [];
    const rules = [
        {
            pattern: SECRET_FILE_PATTERN,
            behavior: (match) => `credential/secret file reference: ${match[1] ?? match[0]}`,
            rule: "Credential/secret files require manual approval."
        },
        {
            pattern: SECRET_VALUE_PATTERN,
            behavior: (match) => `secret-like assignment for ${match[0].split(/[:=]/)[0].trim()}`,
            rule: "Secret-like values or assignments require manual approval."
        },
        {
            pattern: ENV_SECRET_ACCESS_PATTERN,
            behavior: (match) => `credential environment variable access: ${match[1] ?? match[0]}`,
            rule: "Credential environment-variable access requires manual approval."
        },
        {
            pattern: AUTH_FLOW_PATTERN,
            behavior: (match) => `authentication or token handling: ${match[0]}`,
            rule: "Authentication, token handling, or credential storage requires manual approval."
        },
        {
            pattern: REMOTE_SECRET_CONFIG_PATTERN,
            behavior: (match) => `remote API credential configuration: ${match[0]}`,
            rule: "Remote API credential configuration requires manual approval."
        },
        {
            pattern: CREDENTIAL_OPERATION_PATTERN,
            behavior: (match) => `credential/secret operation: ${match[0]}`,
            rule: "Credential or secret handling operations require manual approval."
        }
    ];
    for (const rule of rules) {
        for (const match of source.text.matchAll(globalPattern(rule.pattern))) {
            const index = match.index ?? 0;
            if (hasNegatedContext(source.text, index) || isEvidenceOfAbsence(source.text, index)) {
                evidence.push(unsupportedEvidence("credentials_or_secrets", source, rule.behavior(match), "Credential/secret wording appears only in negative/exclusion context.", index));
                continue;
            }
            const confidence = confidenceForSource(source, "credentials_or_secrets", index);
            evidence.push({
                flag: "credentials_or_secrets",
                confidence,
                source: source.source,
                sourcePath: source.sourcePath,
                matchedBehavior: rule.behavior(match),
                policyRule: confidence === "unsupported" ? reportOnlyPolicyRule("credentials_or_secrets") : rule.rule,
                excerpt: sentenceAround(source.text, index).trim()
            });
        }
    }
    return evidence;
}
function unsupportedEvidence(flag, source, matchedBehavior, policyRule, index) {
    return {
        flag,
        confidence: "unsupported",
        source: source.source,
        sourcePath: source.sourcePath,
        matchedBehavior,
        policyRule,
        excerpt: sentenceAround(source.text, index).trim()
    };
}
function confidenceForSource(source, flag, index) {
    if (source.source === "task_text" || source.source === "changed_file" || source.source === "policy_rule") {
        return "supported";
    }
    const excerpt = sentenceAround(source.text, index);
    if (hasImplementationFileEvidence(excerpt) && hasConcreteBehaviorFor(flag, excerpt)) {
        return "supported";
    }
    return "unsupported";
}
function reportOnlyPolicyRule(flag) {
    return `${policyRuleFor(flag)} Report-only or exclusion wording without concrete implementation evidence is unsupported and does not block automatic finalization.`;
}
function policyRuleFor(flag) {
    switch (flag) {
        case "deployment":
            return "Deployment or production release requires manual approval.";
        case "dangerous_git_operation":
            return "Dangerous Git operation requires manual approval.";
        case "production_database_migration":
            return "Production database migration requires manual approval.";
        case "data_deletion":
            return "Deletion of user/project data requires manual approval.";
        case "payments_or_spending":
            return "Payments, purchases, subscriptions, or spending money require manual approval.";
        case "brokerage_or_trading":
            return "Brokerage, financial credentials, or real trading require manual approval.";
        case "external_service_integration":
            return "External service integration requires manual approval.";
        case "network_exposure":
            return "Firewall or network exposure changes require manual approval.";
        case "credentials_or_secrets":
            return "Credential or secret handling requires manual approval.";
    }
}
function dedupeRiskEvidence(evidence) {
    const seen = new Set();
    return evidence.filter((item) => {
        const key = [item.flag, item.source, item.sourcePath, item.matchedBehavior, item.excerpt].join("\0");
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function globalPattern(pattern) {
    return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}
function hasNegatedContext(text, index) {
    const context = text.slice(Math.max(0, index - 160), index).toLowerCase();
    const sentence = sentenceAround(text, index).toLowerCase();
    const negation = /\b(no|not|never|without|avoid|refuse|must not|do not|does not|did not|cannot|can't)\b/;
    return negation.test(context) || negation.test(sentence);
}
function isEvidenceOfAbsence(text, index) {
    const sentence = sentenceAround(text, index).toLowerCase();
    return /\b(no|not|never|without|must not|do not|does not|did not|cannot|can't)\b/.test(sentence);
}
function sentenceAround(text, index) {
    const startCandidates = [text.lastIndexOf(".", index), text.lastIndexOf("\n", index), text.lastIndexOf(";", index)];
    const endCandidates = [text.indexOf(".", index), text.indexOf("\n", index), text.indexOf(";", index)].filter((value) => value >= 0);
    const start = Math.max(...startCandidates, -1) + 1;
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : text.length;
    return text.slice(start, end);
}
function hasImplementationFileEvidence(text) {
    return (/\b(?:src|app|lib|server|client|public|config|scripts|\.github)[\\/\w.-]*\.(?:ts|tsx|js|jsx|json|ya?ml|toml|md|env|ini|sh|ps1)\b/i.test(text) ||
        /\b(?:package\.json|vite\.config\.(?:ts|js)|tsconfig(?:\.[\w-]+)?\.json|README\.md|\.env(?:\.[\w.-]+)?)\b/i.test(text));
}
function hasConcreteBehaviorFor(flag, text) {
    const normalized = text.toLowerCase();
    switch (flag) {
        case "deployment":
            return /\b(deploy script|deployment workflow|release command|production environment|hosting provider|vercel --prod|netlify deploy|firebase deploy|wrangler deploy|gh-pages|npm run deploy)\b/i.test(normalized);
        case "payments_or_spending":
            return /\b(stripe|paypal|square|braintree|adyen|checkout session|payment intent|billing api|payment sdk|subscription flow|purchase flow|transaction endpoint|charge money)\b/i.test(normalized);
        case "credentials_or_secrets":
            return /\b(\.env|api[_ -]?key|secret|token|password|credential|oauth|authorization header|bearer token|process\.env|import\.meta\.env)\b/i.test(normalized);
        case "external_service_integration":
            return /\b(remote api|external api|external service|third-party service|webhook|cloud service|https?:\/\/|fetch|axios)\b/i.test(normalized);
        case "brokerage_or_trading":
            return /\b(brokerage api|financial api|trading account|real trading|live trading|place order|submit order)\b/i.test(normalized);
        case "dangerous_git_operation":
            return /\b(force push|--force|delete branch|git reset --hard|rewrite git history|branch protection|protected branch|organization settings|repository permissions|push directly to main|merge pull request)\b/i.test(normalized);
        case "production_database_migration":
            return /\b(production database migration|migrate production database)\b/i.test(normalized);
        case "data_deletion":
            return /\b(delete user data|delete project data|drop user data|drop project data|destructive data)\b/i.test(normalized);
        case "network_exposure":
            return /\b(firewall|bind to 0\.0\.0\.0|publicly expose|network exposure)\b/i.test(normalized);
    }
}
function extractRiskRelevantReportText(report) {
    if (!report) {
        return "";
    }
    return report
        .split(/\r?\n/)
        .filter((line) => {
        const normalized = line.toLowerCase();
        if (/\b(no|not|never|without|must not|do not|does not|did not|cannot|can't)\b/.test(normalized)) {
            return false;
        }
        if (/\bno[-\s]?external[-\s]?services?\b/.test(normalized) || /\blocal-only\b/.test(normalized)) {
            return false;
        }
        return true;
    })
        .join("\n");
}
function evaluateCommandEvidence(options) {
    const configuredCommands = uniqueCommands(options.configuredCommands ?? []);
    if (configuredCommands.length > 0) {
        const records = options.verification && options.verification.length > 0
            ? options.verification
            : parseVerificationRecords({
                buildReport: options.buildReport,
                configuredCommands
            });
        const missing = [];
        const failing = [];
        for (const command of configuredCommands) {
            const current = [...records].reverse().find((record) => sameCommand(record.command, command) && record.isCurrent);
            if (!current) {
                missing.push(command);
                continue;
            }
            if (current.status !== "passed") {
                failing.push(`${command} (${current.status})`);
            }
        }
        if (missing.length > 0) {
            return { ok: false, reason: `Configured command results are missing for: ${missing.join(", ")}.` };
        }
        if (failing.length > 0) {
            return { ok: false, reason: `Current configured command results are not passing for: ${failing.join(", ")}.` };
        }
        return { ok: true };
    }
    if (!options.buildReport?.trim()) {
        return { ok: false, reason: "BUILD_REPORT.md is missing, so configured command results cannot be verified." };
    }
    const relevantBlocks = commandBlocks(options.buildReport).filter((block) => COMMAND_KEYWORDS.test(block));
    if (relevantBlocks.length === 0) {
        if (NO_COMMANDS_PATTERN.test(options.buildReport)) {
            return { ok: true };
        }
        return { ok: false, reason: "No configured test/check/lint/build command evidence was found." };
    }
    const failed = relevantBlocks.filter((block) => !PASSED_RESULT_PATTERN.test(block) && !NO_COMMANDS_PATTERN.test(block));
    if (failed.length > 0) {
        return { ok: false, reason: "One or more configured test/check/lint/build commands did not have a passed result." };
    }
    return { ok: true };
}
function commandBlocks(buildReport) {
    return [...buildReport.matchAll(/-\s+`[\s\S]*?(?=\r?\n-\s+`|\r?\n## |\s*$)/g)].map((match) => match[0]);
}
function extractCommand(block) {
    return block.match(/-\s+`([^`]+)`/)?.[1]?.trim();
}
function resultStatus(block) {
    if (PASSED_RESULT_PATTERN.test(block)) {
        return "passed";
    }
    if (FAILED_RESULT_PATTERN.test(block)) {
        return "failed";
    }
    return "unknown";
}
function uniqueCommands(commands) {
    const unique = [];
    for (const command of commands) {
        const trimmed = command?.trim();
        if (trimmed && !unique.some((existing) => sameCommand(existing, trimmed))) {
            unique.push(trimmed);
        }
    }
    return unique;
}
function sameCommand(left, right) {
    return left.trim().replace(/\s+/g, " ").toLowerCase() === right.trim().replace(/\s+/g, " ").toLowerCase();
}
function hasReviewerBlocker(reviewReport) {
    if (!reviewReport) {
        return false;
    }
    const pattern = /\b(blocker|blocking|unresolved high-priority|high priority issue|critical issue)\b/gi;
    for (const match of reviewReport.matchAll(pattern)) {
        if (!hasNegatedContext(reviewReport, match.index ?? 0)) {
            return true;
        }
    }
    return false;
}
