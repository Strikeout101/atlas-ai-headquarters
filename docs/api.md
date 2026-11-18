# API Contract Baseline

This document defines a contributor-facing API baseline for Claw-Empire.
It is intentionally compact and focused on frequently used endpoints.
Current baseline target: `v1.2.4` (local snapshot, 2026-03-07).

## Base

- Base URL (local): `http://127.0.0.1:8790`
- API prefix: `/api`
- Health endpoints: `/healthz`, `/api/health`
- Swagger UI: `/api/docs`
- OpenAPI JSON: `/api/openapi.json`

## Authentication

- Loopback/local usage usually works without extra headers.
- Remote/non-loopback deployments can require:
  - `Authorization: Bearer <API_AUTH_TOKEN>`
- Inbox webhook endpoint requires:
  - `x-inbox-secret: <INBOX_WEBHOOK_SECRET>`
- Browser session bootstrap (`GET /api/auth/session`) returns `csrf_token`.
  - For cookie-authenticated mutation requests (`POST/PUT/PATCH/DELETE`), send:
    - `x-csrf-token: <csrf_token>`
- Interrupt injection endpoint (`POST /api/tasks/:id/inject`) additionally requires:
  - `session_id`
  - `interrupt_token` (or header `x-task-interrupt-token`)
  - Terminal API (`GET /api/tasks/:id/terminal`) exposes `interrupt.session_id` + `interrupt.control_token`
- Swagger note:
  - `/api/docs` opens with an automatic `/api/auth/session` bootstrap attempt (loopback/local case).
  - If you still get `401 unauthorized`, set `Bearer <API_AUTH_TOKEN>` via Swagger `Authorize`.

## Common Error Shape

Error payloads can vary by route, but API clients should handle:

```json
{
  "error": "error_code",
  "message": "human-readable detail"
}
```

The frontend client wraps non-2xx responses with `ApiRequestError` (`status`, `code`, `details`, `url`).

## Messenger Session Contract (v1.2.3)

Messenger channel settings are stored in `settings.key = "messengerChannels"` and can include:

- `token`: channel token (encrypted at rest with AES-256-GCM using `OAUTH_ENCRYPTION_SECRET`, fallback: `SESSION_SECRET`)
- `sessions[]`:
  - `id`
  - `name`
  - `targetId`
  - `enabled` (default true)
  - `agentId` (optional, binds session to a specific agent for direct chat/task routing)

Supported channel ids (OpenClaw parity):

- `telegram`
- `whatsapp`
- `discord`
- `googlechat`
- `slack`
- `signal`
- `imessage`

Runtime behavior highlights:

- Task report relays are route-pinned to the task's originating messenger target (`[messenger-route]` audit marker in task logs).
- Channel spread is prevented for route-pinned task reports.
- Typing indicators are emitted during direct-chat generation for Telegram/Discord; other channels are no-op.
- Native direct send runtime exists for all OpenClaw-parity channels (`telegram`, `whatsapp`, `discord`, `googlechat`, `slack`, `signal`, `imessage`).
- Per-channel setup requirements differ (e.g., WhatsApp Cloud API token + phone number id, Google Chat webhook URL or `key|token`, Signal RPC base URL, macOS iMessage runtime).
- New project creation path in direct-chat escalation is restricted by `PROJECT_PATH_ALLOWED_ROOTS`.

## Core Endpoint Groups

### Messenger (Built-in Channels)

| Method | Path                               | Purpose                                                          |
| ------ | ---------------------------------- | ---------------------------------------------------------------- |
| GET    | `/api/messenger/sessions`          | List runtime messenger sessions resolved from persisted settings |
| GET    | `/api/messenger/receiver/telegram` | Telegram webhook/poll receiver status                            |
| GET    | `/api/messenger/receiver/discord`  | Discord polling receiver status                                  |
| POST   | `/api/messenger/discord/channels`  | Discover accessible Discord text channels by Bot token           |
| POST   | `/api/messenger/send`              | Send message by `sessionKey` or (`channel` + `targetId`)         |

`POST /api/messenger/send` request body:

```json
{
  "sessionKey": "telegram:my-session",
  "text": "hello"
}
```

or

```json
{
  "channel": "discord",
  "targetId": "123456789012345678",
  "text": "hello"
}
```

### Runtime / Org

| Method | Path                             | Purpose                                                         |
| ------ | -------------------------------- | --------------------------------------------------------------- |
| GET    | `/api/departments`               | List departments                                                |
| GET    | `/api/departments/:id`           | Get department detail with member list                          |
| POST   | `/api/departments`               | Create department                                               |
| PATCH  | `/api/departments/:id`           | Update department                                               |
| PATCH  | `/api/departments/reorder`       | Reorder departments                                             |
| GET    | `/api/agents`                    | List agents                                                     |
| GET    | `/api/agents/:id`                | Get agent detail                                                |
| GET    | `/api/meeting-presence`          | Current kickoff/review meeting seat occupancy                   |
| GET    | `/api/agents/active`             | Agents currently marked working with live session metadata      |
| GET    | `/api/agents/cli-processes`      | Detected CLI processes and task correlation                     |
| DELETE | `/api/agents/cli-processes/:pid` | Kill a detected CLI process by pid                              |
| GET    | `/api/cli-status`                | Installed CLI provider detection + authentication readiness     |
| POST   | `/api/agents`                    | Create agent                                                    |
| POST   | `/api/agents/:id/spawn`          | Spawn assigned task execution directly from an agent card       |
| PATCH  | `/api/agents/:id`                | Update agent                                                    |
| DELETE | `/api/agents/:id`                | Delete agent                                                    |
| POST   | `/api/sprites/process`           | Slice/upload sprite sheet preview set and suggest sprite number |
| POST   | `/api/sprites/register`          | Persist processed sprite variants under a sprite number         |
| GET    | `/api/stats`                     | Dashboard/company stats                                         |
| GET    | `/api/settings`                  | Read settings                                                   |
| PUT    | `/api/settings`                  | Save settings                                                   |

### Tasks / Execution

| Method | Path                             | Purpose                                                     |
| ------ | -------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/tasks`                     | List tasks (supports filters)                               |
| GET    | `/api/tasks/:id`                 | Task detail                                                 |
| POST   | `/api/tasks`                     | Create task                                                 |
| PATCH  | `/api/tasks/:id`                 | Update task                                                 |
| DELETE | `/api/tasks/:id`                 | Delete task                                                 |
| POST   | `/api/tasks/bulk-hide`           | Hide or unhide tasks by status group                        |
| POST   | `/api/tasks/:id/assign`          | Assign agent                                                |
| POST   | `/api/tasks/:id/run`             | Start task                                                  |
| POST   | `/api/tasks/:id/stop`            | Cancel or pause task                                        |
| POST   | `/api/tasks/:id/resume`          | Resume paused task                                          |
| POST   | `/api/tasks/:id/inject`          | Queue sanitized interrupt prompt (paused session)           |
| GET    | `/api/tasks/:id/terminal`        | Task terminal logs                                          |
| GET    | `/api/tasks/:id/meeting-minutes` | Meeting minutes                                             |
| GET    | `/api/tasks/:id/diff`            | Git diff/stat for task worktree branch                      |
| POST   | `/api/tasks/:id/merge`           | Manual merge of task worktree into project branch           |
| POST   | `/api/tasks/:id/discard`         | Discard task worktree and abandon branch changes            |
| GET    | `/api/worktrees`                 | Active task worktree registry                               |
| GET    | `/api/subtasks`                  | List subtasks (`active=1` limits to in-flight parent tasks) |
| POST   | `/api/tasks/:id/subtasks`        | Create subtask                                              |
| PATCH  | `/api/subtasks/:id`              | Update subtask                                              |

`GET /api/tasks` supports query filters: `status`, `department_id`, `agent_id`, `project_id`.

### Reports / Diagnostics

| Method | Path                                | Purpose                                                                 |
| ------ | ----------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/api/task-reports`                 | Root completed-task report list                                         |
| GET    | `/api/task-reports/:taskId`         | Consolidated report detail (logs, subtasks, meeting minutes, documents) |
| POST   | `/api/task-reports/:taskId/archive` | Regenerate/archive planning consolidated markdown for a task tree       |
| GET    | `/api/docs`                         | Swagger UI for the current OpenAPI contract                             |
| GET    | `/api/docs/swagger-bootstrap.js`    | Swagger bootstrap helper that primes `/api/auth/session`                |
| GET    | `/api/cli-usage`                    | Cached CLI quota/usage windows by provider                              |
| POST   | `/api/cli-usage/refresh`            | Refresh CLI quota/usage cache and broadcast update                      |

### Messaging / Inbox / Decision

| Method | Path                            | Purpose                    |
| ------ | ------------------------------- | -------------------------- |
| GET    | `/api/messages`                 | Message history            |
| POST   | `/api/messages`                 | Send message               |
| POST   | `/api/announcements`            | Broadcast announcement     |
| POST   | `/api/directives`               | Send directive             |
| DELETE | `/api/messages`                 | Clear messages             |
| POST   | `/api/inbox`                    | External webhook ingestion |
| GET    | `/api/decision-inbox`           | Decision inbox items       |
| POST   | `/api/decision-inbox/:id/reply` | Decision reply             |

### Skills / Providers / OAuth

| Method | Path                            | Purpose                                                   |
| ------ | ------------------------------- | --------------------------------------------------------- |
| GET    | `/api/skills`                   | Skill catalog                                             |
| GET    | `/api/skills/available`         | Learned skill inventory available for reuse               |
| GET    | `/api/skills/detail`            | Skill detail                                              |
| POST   | `/api/skills/learn`             | Start learn job                                           |
| GET    | `/api/skills/learn/:jobId`      | Learn job status                                          |
| GET    | `/api/skills/history`           | Learn history                                             |
| POST   | `/api/skills/unlearn`           | Unlearn skill                                             |
| POST   | `/api/skills/custom`            | Upload custom skill                                       |
| GET    | `/api/skills/custom`            | List custom skills                                        |
| DELETE | `/api/skills/custom/:skillName` | Delete custom skill                                       |
| GET    | `/api/api-providers`            | List API providers                                        |
| POST   | `/api/api-providers`            | Create API provider                                       |
| PUT    | `/api/api-providers/:id`        | Update API provider                                       |
| DELETE | `/api/api-providers/:id`        | Delete API provider                                       |
| POST   | `/api/api-providers/:id/test`   | Probe upstream provider and refresh model cache           |
| GET    | `/api/api-providers/:id/models` | Read cached or refreshed provider model list              |
| GET    | `/api/api-providers/presets`    | Built-in provider preset base URLs/auth conventions       |
| GET    | `/api/oauth/status`             | OAuth status                                              |
| POST   | `/api/oauth/disconnect`         | OAuth disconnect                                          |
| POST   | `/api/oauth/refresh`            | OAuth token refresh                                       |
| POST   | `/api/oauth/accounts/activate`  | Activate, add, remove, or toggle a stored OAuth account   |
| PUT    | `/api/oauth/accounts/:id`       | Update OAuth account metadata and model override          |
| GET    | `/api/oauth/models`             | OAuth-backed model catalog (Copilot/OpenCode/Antigravity) |
| GET    | `/api/cli-models`               | Local CLI model catalog (Claude/Codex/Gemini/OpenCode)    |

### Project / GitHub / Update

| Method | Path                                      | Purpose                                                          |
| ------ | ----------------------------------------- | ---------------------------------------------------------------- |
| GET    | `/api/projects`                           | List projects                                                    |
| POST   | `/api/projects`                           | Create project                                                   |
| GET    | `/api/projects/:id`                       | Project detail with assigned agents/tasks/reports/review events  |
| PATCH  | `/api/projects/:id`                       | Update project                                                   |
| DELETE | `/api/projects/:id`                       | Delete project                                                   |
| GET    | `/api/projects/path-check`                | Validate project path                                            |
| GET    | `/api/projects/path-suggestions`          | Suggested paths                                                  |
| GET    | `/api/projects/path-browse`               | Browse allowed project roots/subdirectories for manual selection |
| POST   | `/api/projects/path-native-picker`        | Native path picker                                               |
| GET    | `/api/projects/:id/branches`              | Local git branches for a project path                            |
| GET    | `/api/github/status`                      | GitHub integration status                                        |
| GET    | `/api/github/repos`                       | Repositories                                                     |
| GET    | `/api/github/repos/:owner/:repo/branches` | Remote GitHub branch list                                        |
| POST   | `/api/github/clone`                       | Clone repository                                                 |
| GET    | `/api/github/clone/:cloneId`              | Clone progress/status polling                                    |
| GET    | `/api/update-status`                      | Update status                                                    |
| GET    | `/api/update-auto-status`                 | Auto-update daemon status and lock state                         |
| POST   | `/api/update-auto-config`                 | Toggle auto update                                               |
| POST   | `/api/update-apply`                       | Trigger update apply flow immediately                            |

### Accounts and Approvals

| Method       | Path                                          | Purpose                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET/PATCH    | `/api/business/policies[/:business]`          | Per-business approval settings: `customer_sends` (owner, vp), `record_changes` and `code_pushes` (none, vp, owner), `owner_amount_minor` (deal-size limit, 0 = off), `tier_to_owner` (important, vip, off), `trust_ramp_after` |
| GET          | `/api/business/trust-offers`                  | Suggestions to let the VPs approve a kind of work the owner keeps approving                                                                                                                                                    |
| POST         | `/api/business/trust-offers/:business/:kind`  | Accept (`{accept:true}`) or snooze a suggestion                                                                                                                                                                                |
| GET/PUT      | `/api/business/spend-budgets`                 | Spending budgets per business and category; within one, both VPs may approve a spend request                                                                                                                                   |
| POST         | `/api/record-changes/:id/decide`              | Apply or deny an agent's held record change                                                                                                                                                                                    |
| GET/POST     | `/api/github-accounts`                        | GitHub repo accounts (fine-grained token each, never returned)                                                                                                                                                                 |
| PATCH/DELETE | `/api/github-accounts/:id`                    | Edit, set default, remove                                                                                                                                                                                                      |
| POST         | `/api/github-accounts/:id/test`               | Sign in with the token (GET /user)                                                                                                                                                                                             |
| GET          | `/api/github-accounts/for-project/:projectId` | Which account a project pushes with                                                                                                                                                                                            |
| POST         | `/api/code-pushes/:id/decide`                 | Push held reviewed work and open a pull request                                                                                                                                                                                |
| GET/POST     | `/api/square/connections`                     | Square accounts (Primrose has its own)                                                                                                                                                                                         |
| PATCH/DELETE | `/api/square/connections/:id`                 | Edit or remove one account                                                                                                                                                                                                     |
| PUT          | `/api/square/connections/:id/mappings`        | Map that account's locations to businesses                                                                                                                                                                                     |
| POST         | `/api/square/connections/:id/test`, `/sync`   | Load locations, read payments                                                                                                                                                                                                  |

All changes need the owner password session and CSRF. Paid accounts, accepting terms, destructive SSH and spending outside a budget always need the owner and are not settings. Routing reads structured facts (client tier on contacts, deal and quote amounts), never the wording of a message. The original `/api/square` routes still work and act on the first Square account.

### Agent Tools and Knowledge

| Method    | Path                                 | Purpose                                                                                                                                           |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST      | `/api/agent-tools`                   | Agent tool gateway for running tasks (task token in `x-agent-task-token`, local only). Operations are listed in [agent-tools.md](agent-tools.md). |
| GET       | `/api/knowledge/documents/:topic`    | Systems registry (`systems`) or master checklist (`checklist`), read-only                                                                         |
| GET       | `/api/knowledge/memories`            | Agent memories with counts; filters `status`, `business`, `reviewed`, `q`                                                                         |
| POST      | `/api/knowledge/memories`            | Owner adds a memory (reviewed from the start)                                                                                                     |
| GET/PATCH | `/api/knowledge/memories/:id`        | Read or edit a memory (editing marks it reviewed)                                                                                                 |
| POST      | `/api/knowledge/memories/:id/review` | Mark reviewed                                                                                                                                     |
| POST      | `/api/knowledge/memories/:id/status` | `active` or `archived`                                                                                                                            |

Memory changes need the owner password session and CSRF. Agent task tokens are refused on `/api/knowledge/*`; agents use `knowledge.get`, `memory.search` and `memory.add` through the gateway.

## Coverage Notes

- `docs/openapi.json` now includes the main contributor-facing detail/picker/report endpoints that were missing from the previous baseline.
- CI E2E should treat the following as regression-sensitive:
  - `/api/docs`, `/api/docs/swagger-bootstrap.js`, `/api/openapi.json`
  - `/api/projects/:id`, `/api/projects/:id/branches`, `/api/projects/path-browse`
  - `/api/tasks/bulk-hide`, `/api/tasks/:id/diff`, `/api/worktrees`
  - `/api/meeting-presence`, `/api/agents/active`, `/api/agents/cli-processes`
  - `/api/cli-usage`, `/api/api-providers/presets`, `/api/task-reports*`

## Known Follow-up

- Promote this baseline to OpenAPI (`/api/*.yaml`) in incremental slices:
  1. auth/session + settings
  2. tasks/subtasks
  3. inbox/directives
  4. project/github/update routes
