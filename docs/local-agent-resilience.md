# Local agent hierarchy and disconnection recovery

## Intended roster

- Codex and Claude are the two directors. Give each a clear domain and make both eligible to supervise local workers.
- Main PC: a Qwen 27B class worker.
- Homelab: a smaller Qwen worker.
- Precision 5690: a small Qwen or Gemma worker.

Each machine needs its own API provider record and agent assignment. Model IDs, endpoint addresses, capacity, and credentials remain deployment choices; they should not be hard coded in the game.

To configure the three workers, register an Ollama API provider for each reachable host under Settings > API, choose its installed model, and assign each worker `cli_provider = api` with that provider and model. Task execution automatically starts OpenCode on the Claw-Empire server and points it at the selected host. OpenCode is installed on the current main PC; deployments on another server need it installed there too. The model must support tool calls. Direct chat with an API agent remains a text reply, because chat has no task worktree.

## Current backend

Agents support `cli_provider = 'api'`, `api_provider_id`, and `api_model`. Ollama is an API provider type. Ollama task runs now use the existing OpenCode CLI runner with a per-run provider configuration. This gives the selected local model file and shell tools in the task worktree. Other API provider types still use a single streamed chat request and have no coding tool loop. OpenCode must be installed on the machine hosting Claw-Empire, and each selected Ollama model must support tool calls. Departments and team leaders exist, but there is no durable direct `manager_id` relation or company level director role.

The first recovery slice now treats an interrupted OpenAI compatible stream or a transient provider error as an outage. The task becomes `pending`, keeps its assigned agent and worktree, and records a `HANDOFF` task log. A disconnected worker becomes `offline`; an available department leader and the CEO are notified. A nonzero OpenCode exit with a healthy model endpoint also preserves work but leaves the worker idle for review. Once the agent is back online, the existing resume route can restart the task. That restart reattaches its worktree, including after a server restart, and the continuation prompt includes the handoff and prior output. Other run failures retain the existing failure behavior.

## Context exhaustion recovery

For Ollama workers using OpenCode, the runner reads completed-step token usage from its JSON event stream. Set an agent's optional **Context window (tokens)** when assigning its Ollama model under Settings > API. At 80% of that configured window, the runner interrupts after the step, stores a durable checkpoint, and starts a fresh OpenCode run in the same task worktree. A structured context-limit error also triggers this flow without the setting. A successful OpenCode exit remains a success even if OpenCode reported an error that it recovered internally.

The checkpoint records the task goal, worktree changes, completed and remaining subtasks, available test evidence, and recent output. Automatic resumes use a compact prompt and do not reuse the exhausted chat. Recovery state survives server restarts; a user pause or cancellation stops automatic continuation. Two consecutive rollovers with no worktree or subtask progress, or a seventh rollover, pause the task for director review and the existing model upgrade decision. A failed checkpoint or restart leaves the task pending with its worktree intact.

## Next backend phase

1. Add a durable reporting relationship from each local worker to one of the two directors, with a fallback director when the primary is unavailable. Department leader selection alone cannot express this roster.
2. Persist provider health and retry timing. Probe each host with a short timeout and exponential backoff; distinguish a down host from a model request failure. Never retry a task while another attempt is active.
3. On recovery, notify the assigned director and resume each pending task once from its saved worktree and handoff. Make this idempotent across server restarts and prevent automatic resume for user paused tasks.
4. Verify the OpenCode tool runner against each chosen Qwen or Gemma model, including file edits and tests. Keep non-Ollama API providers on bounded planning, review, or summarization tasks until they have a tool capable runtime.
5. Test a real disconnect during streaming, a server restart while offline, a reconnect, a director outage, and repeated flapping across the three machines.

The current slice prevents the main data loss path and provides coding tools for Ollama workers. Automatic reconnect, director based reassignment, and live model validation are not implemented yet.
