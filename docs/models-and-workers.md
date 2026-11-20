# Models and workers

Current reference for checklist section 11, implemented 2026-11-18.

## Routing and directors

Open **Team > Model Director** to select a fallback director and separate technical and design directors. Design tasks use the design director; other tasks use the technical director. An unset specialist uses the fallback director. Directors choose from the worker's configured allowed models. Model upgrades still use the existing approval gateway.

**Routine work on Ollama** selects an enabled, discovered local host/model, task kinds and its configured context window. Local routing is explicit: only the selected kinds can use it. Worker identity and business permissions stay with the assigned agent. Per-task routing records the actual API provider and model, so resuming the task does not depend on the worker's global provider setting. Existing routes stay fixed until explicitly rerouted or upgraded.

Initial local prompts preserve the task description and mandatory department/injected/continuation instructions. If those cannot fit, execution chooses the worker's configured provider before launching. Local continuation prompts reserve 15% of their prompt allowance for new context; the overall prompt allowance leaves room for tools and output. Unavailable or invalid local configuration uses the configured worker path, whose subscription gate still applies.

Subscription headroom checks apply to the provider being used. An eligible first local task can be admitted without an unrelated subscription; the launch path checks again against the actual saved route. Codex and Claude calls still require fresh valid usage below the configured threshold. Pauses, stop controls, daily caps and proposal approvals continue to apply.

Local providers also have a daily invocation limit under **Autonomy > Limits** (default 20 per configured host, America/New_York day). Every autonomous worker or meeting invocation counts, including retries, resumes and failed starts. An invocation may use multiple model turns; this is not a token or dollar estimate. The task-start limit remains separate. The final transport reserves its invocation atomically, so simultaneous workers cannot all pass an old preflight count. Owner-started runs are unaffected. Idle-agent API thinking without a task attribution is skipped with a recorded explanation.

Autonomous calls to paid or unclassified API providers stay disabled: reported usage is not an enforceable dollar ceiling. Adding a paid API key alone does not enable autonomous spending. Paid autonomous execution requires a future provider-specific enforceable budget; local hosts classified as Ollama are treated as owner-configured self-hosted services.

## Worker performance

New worker invocations persist a record in `agent_worker_runs`, grouped by agent, provider and model. The director receives recent performance summaries and the page shows a compact table.

- Success/failure means the worker's exit outcome, not successful integration, a paid deal or business revenue.
- Rework counts additional attempts for the same task, including resumes and context continuation. It is not an assertion that the previous answer was wrong.
- Cancellation is separate from failure. Running and cancelled records do not enter the success-rate denominator.
- Native CLI and HTTP/API streams contribute only structured provider-reported tokens and USD cost. Missing costs remain unknown. Subscription usage is not converted into a dollar charge.
- OAuth fallback attempts are recorded against their actual account-specific model. A failed first account and successful fallback are separate attempts.

Telemetry begins with new runs; no historical cost is fabricated. One-shot planning and VP meetings are outside the worker-run table.

## Public research tools

Workers can use `web.search` and `web.read` through the task-scoped gateway. Search returns source URLs and snippets; reading returns bounded page text and links. All workers use the same operations, without platform credentials. See [agent tools](agent-tools.md) for JSON examples.

These tools cover public text pages. They do not operate authenticated sessions, execute page JavaScript or read PDFs. Destination checks block private networks, pin vetted DNS addresses and recheck redirects. Retrieved content is reference data, never permission or instructions.

## Merge completion

Review approval alone does not complete an integration. Failed local/GitHub merges leave the task in Review, preserve its worktree and queue callbacks, and report the failure and conflicting files when available. Resolve the problem and approve again to retry. A parent remains in Review if a collaboration child's integration fails. Completion reports and consolidated archives occur after the required merges succeed.

## Verification

Focused regression suites cover routing, settings, prompt budgets, performance, web access and merge holds/retries. `tests/e2e/model-workers.spec.ts` checks the controls at 1440px and 375px against a guarded disposable API database; its provider metadata is synthetic and it never starts a model.

Real provider evidence and the exact boundaries of the autonomy/local-worker smoke checks are recorded separately in [the dated verification report](models-workers-verification-2026-11-18.md). The harnesses require `--run` because they invoke actual configured providers, and their data belongs under `.tmp/`.
