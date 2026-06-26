# Risk Classification and Manual Approval Repair Report

Date: 2026-06-25

## Root Cause

The approval policy was still too keyword-oriented for high-risk categories. Build/review/report wording that explicitly excluded risk, such as deployment and payments being out of scope, could be interpreted as a blocking `deployment` or `payments_or_spending` flag even when no implementation file, configuration, workflow, SDK, API, or product behavior supported that risk.

## Policy Changes

- Risk classification is now evidence-based across deployment, payments/spending, credentials/secrets, external integrations, brokerage/trading, protected/dangerous Git operations, network exposure, production database migrations, and destructive data actions.
- Negative or exclusion language such as "no deployment", "deployment excluded", "local-only", "no payments", "payments excluded", "no credentials", "no API keys", and "no external services" is recorded only as unsupported evidence and does not block automatic finalization.
- Report-only matches from `BUILD_REPORT.md` or `REVIEW_REPORT.md` block only when they cite a concrete changed file plus actual risky implementation/configuration behavior.
- Every risk finding records confidence (`supported`, `unsupported`, or `needs-review`), source, source path/label, matched behavior, policy rule, and excerpt.

## Approval UI And MCP Verification

- `approve_task`, `decline_task`, and `finalize_task` remain registered MCP tools.
- Dashboard approval-required tasks show Approve and Decline / Keep Paused controls only when the policy status is truly `manual_approval_required`.
- Task details show approval reasons and risk evidence, including confidence, source, rule, behavior, and excerpt.
- Manual approval still requires a reason and, when supported risk flags exist, confirmation that the evidence was reviewed.

## Current Task Migration

Task `task-2026-06-25T18-59-01-827Z-b1f243e3` was re-evaluated with the corrected policy.

Current result:

- Build remains passed with exit code 0.
- Current verification remains passed for `npm test`, `npm run check`, and `npm run build`.
- Independent review remains passed.
- Unsupported `deployment` and `payments_or_spending` blockers are no longer present.
- Current approval decision is eligible for automatic completion with no blocking risk flags.

The existing Trade Journal Lite Autopilot run remains paused. No approval, finalization, resume, new run, brief, plan, task, worktree, or worker was created.

## Tests Run

- `npx vitest run test/approval.test.ts` passed with 58 tests.
- `npm test` passed with 147 tests.
- `npm run check` passed with TypeScript build plus 147 tests.

Added/updated coverage for:

- "no deployment", "deployment excluded", "no payments", and "payments excluded" not producing blocking risk flags
- report-only keyword matches not producing approval blocks
- actual deployment configuration/release commands producing supported evidence
- actual payment SDK/checkout/subscription behavior producing supported evidence
- actual credential/token handling producing supported evidence
- unsupported risk flags being ignored by finalization
- approval controls and MCP approval behavior preserving hard build/review/verification gates

## Restart And Resume Instructions

Restart Project Pilot once:

```powershell
cd $HOME\Projects\ai-pilot\project-pilot
npm run dev
```

After restart, click Resume once on the existing Trade Journal Lite Autopilot run.

## Expected Behavior After Resume

Project Pilot should see task `task-2026-06-25T18-59-01-827Z-b1f243e3` as reviewed, verified, local-only, and eligible for automatic finalization. It should finalize that existing task under the current policy, then continue the existing run without creating duplicate runs, briefs, plans, tasks, worktrees, or workers.
