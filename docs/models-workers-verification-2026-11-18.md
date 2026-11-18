# Models and workers verification — 2026-11-18

## Real autonomous cycle: passed

At 02:42–02:43 America/New_York, a disposable SQLite database completed one Ventures internal diagnostic through the production planner, independent VP review, approval execution, autonomy admission, worker transport, task finalizer and autonomy settlement modules.

1. One goal targeted one completed internal task. The project goal specified computing `17 * 23` using synthetic data, with no tools or external actions.
2. A real Claude VP (`sonnet`) produced one bounded proposal.
3. A real Codex VP (`gpt-6.1-sol`, low reasoning) and a separate real Claude VP (`sonnet`) each approved the exact proposal. Both verdicts were persisted before task creation.
4. The autonomy engine reserved one start under its existing daily cap and launched a real Claude worker (`sonnet`).
5. The worker returned `{"product":391}`. The harness verified the exact arithmetic result and called the production review finalizer.
6. The task and its autonomy work settled to Done, the ledger recorded completion, and observed goal progress became 1.

Usage came from fresh authenticated production usage readers immediately before the run. Codex was at 46% of its five-hour window and 73% of its seven-day window; Claude was at 43% and 70%. The configured 80% threshold was respected. No usage values were fabricated, no approval was bypassed, and no production autonomy setting, goal or routine was enabled.

Local evidence: `.tmp/autonomy-real-cycle/82b6bb03-aeb6-40f4-8ac9-ca704f0bece5/evidence.json`, its SQLite database, model logs and `worker-result.json`. This document preserves the sanitized outcome; raw local evidence is intentionally outside git.

Reproduce from the repo root, using existing authenticated CLI subscriptions:

```powershell
pnpm exec tsx scripts/qa/autonomy-real-cycle.ts --run
```

The script creates a new disposable database and workspace under `.tmp/autonomy-real-cycle/` each time. It fails when genuine usage, planning, independent votes, worker execution or result verification fail. It makes real subscription model calls only with `--run`.

### What this proves and what it does not

This proves the goal → planner → dual-VP approval → admitted real model worker → recorded result path with actual authenticated providers. Completion uses a deterministic arithmetic oracle; it does not run the multi-agent team-leader consensus meeting. Owner-security readiness is supplied by the isolated harness rather than a browser login. The worker uses the real no-tools CLI transport; this does not prove a coding worktree merge, production business delivery, email sending or a long unattended schedule.

## Problems found through real calls

- Claude emitted the same JSON as stream text, assistant text and final result. `prettyStreamJson` duplicated it, breaking strict planner/reviewer JSON parsing. The normalizer now emits the text once while preserving result-only replies; five regressions cover the variants.
- A project-linked task proposal had no business in the VP review prompt. The Codex VP escalated according to the missing-business rule. Review now resolves the project's business before describing its approval rules.
- The planner had the project id but not its core goal. Its production prompt now includes the project's id, name and core goal; the successful run used the unmodified production prompt.
- Subscription admission originally required both subscriptions for every worker. It now checks the actual routed worker provider, or the exact eligible configured local route before the first route is saved. A later fallback/upgrade is checked again at launch. Used subscriptions still require fresh valid usage; unknown worker providers fail closed. Planning checks the selected VP, and independent reviewers retain their own availability checks.

An earlier Codex worker returned the correct JSON and emitted `turn.completed`, but its CLI process did not close before the 60-second transport timeout. That run was recorded as failed rather than treating partial output as success. This was one observed timeout, not an established root cause. The successful cycle used a Claude worker; Codex still performed a genuine independent VP review.

## Real local tool worker

The configured Precision host answered its OpenAI-compatible `/models` endpoint and advertised cached model `5690-flint`. Its Ollama `/api/tags` endpoint returned 404; discovery and execution must use the configured compatible endpoint.

Direct no-tools generation also passed: `5690-flint` returned `391` for `17 * 23` through `/chat/completions`, HTTP 200, in 6,724 ms. Local evidence: `.tmp/section11-cycle/local-chat-evidence.json`. This proves the generation host responds; it does not prove tool execution.

The first isolated local routing/tool-worker attempt selected the expected API provider and model but timed out after 90 seconds before producing worker output or `proof.txt`. OpenCode logs showed workspace/snapshot initialization, so this is not evidence of a successful local worker. A second attempt with an independent empty git repository also timed out silently. A third attempt (run by Claude on 2026-11-18 with `scripts/qa/ollama-real-worker.ts --run`) used the production `createCliRuntimeTools.spawnCliAgent` and the corrected native v2 permission rules. Routing again chose `api` / `5690-flint` correctly, but OpenCode printed nothing for 80 seconds and the run was stopped (exit 1, no `proof.txt`). Plain chat with the same model works, so the open question is OpenCode tool calling against this local model (model support for tools, OpenCode's provider config, or a slow first turn). The local tool worker is **not** verified; local routing stays off in production.

Reproduce without enabling production routing:

```powershell
pnpm exec tsx scripts/qa/ollama-real-worker.ts --run
```

The local script reads the enabled host configuration through a read-only connection, copies it into a fresh disposable database, enables routing only in that database, invokes the production router and local tool-worker launch adapter, and requires an actual `proof.txt` containing `LOCAL_WORKER_OK`. It never prints the host address or credentials and never commits or pushes.
