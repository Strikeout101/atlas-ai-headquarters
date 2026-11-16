# ATLAS: tasks, agents, events, and owner controls

Code-traced guide, November 16, 2026. This describes current behavior, including limitations. It does not change the workflow or claim that every provider has the same capabilities.

## 1. The pieces the app coordinates

- **Agent:** a saved identity with a name, department, role, personality, provider/model configuration and availability. An office avatar is not proof of an active model process. Agents are invoked for chat replies, meetings or task runs.
- **Department / team leader:** a routing and coordination layer. Leaders can select workers and request cross-department contributions. A direct request to a worker and a direct request to a leader take different paths.
- **Message:** a conversation or notification record. Messages can cause tasks, but a message and a task are different objects.
- **Task:** a durable request with an owner, project, description, status, result, logs and potentially subtasks, delegated child tasks and an execution session.
- **Project:** shared goal, working directory and agent-assignment scope. One project can hold many tasks. Project-level decisions can group several completed executions for review.
- **Execution session / run:** an actual attempt to do task work. A task can have several runs after pause, remediation, failure or context rollover.
- **Meeting:** short coordinated agent calls with recorded minutes, participants and conclusions. A meeting is separate from the worker execution.
- **Decision / approval:** a record waiting for a specific choice. Workflow decisions and permission to execute a specific external action are separate systems.
- **Task type:** general/development/design/analysis/presentation/documentation. It does not guarantee a short execution path. (Office and workflow packs were removed on 2026-11-16; there is one office and one way of working.)

## 2. All user-facing entry points

| Route | Current behavior | Appropriate use |
| --- | --- | --- |
| Agent Chat mode | Produces a reply or promotes the message to a task when the intent detector recognizes work. Keywords such as check, review, run, analyze, implement and request phrasing count. | Questions and discussion, while watching for task-escalation/project prompts. |
| Agent Task mode | Explicit task assignment. After project resolution, a worker runs directly; a leader enters the delegation path. | Give a specific agent work. |
| Agent Report mode | Creates report/deck authoring work through a specialized workflow. | Request a document/report/presentation deliverable. |
| Company Announcement | Broadcasts and requests leader acknowledgements. Cross-department or agent mentions can trigger delegation. | Company-wide context or coordination. A mentioned action can start work. |
| `$` directive | Company-wide directive coordinated by Planning, with project context and optional initial planning-meeting skip. Policy checks can recognize a coordination/hold instruction instead of immediately executing. | Multi-team objectives and coordinated work. |
| Work / task board: Create task | Creates a durable board record, normally Inbox. Choosing an assignee does not itself execute it. Use Run separately. | Prepare and inspect a task before starting. |
| Task Run | Starts the selected task; can select an eligible worker when unassigned. Project manual-agent restrictions affect selection. | Explicitly launch recorded work. |
| Today / Decision Inbox | Resolves workflow choices or external-action approvals. | Unblock the relevant gate. Read the option's action; not every approval resumes execution. |
| Task terminal intervention | Pauses a task, queues an extra instruction for the next run, and resumes. | Change a task's execution instructions. Ordinary chat is not this injection mechanism. |
| Configured messenger session | Routes incoming ordinary messages to its mapped agent; supports directive and decision-reply paths. | Interact outside the browser once the channel/session is configured. |
| This Codex development chat | Ordinary requests operate on this repository; `$` and `#` use the repository's orchestration instructions. | Maintain the app or explicitly orchestrate its board. This is distinct from the app's own agent chat. |

### Chat intent and project prompts

Chat is not an enforced conversation-only boundary. The current intent detector uses rules and keywords, not a guaranteed semantic distinction between discussing work and requesting it. A contextual yes/go ahead can recover an earlier work request. If project binding is unresolved, the app asks existing versus new project, then project selection or new project details. Confirming project details can immediately launch the resolved request.

A project progress inquiry has its own summary path. Prefer a concrete question such as "What is the status of task X?" for a progress update. A broadly worded "check the project" can be recognized as a new task.

Plain conversation uses an independent reply execution and can itself have provider tools; it should not be described as universally tool-free. Meeting/summary calls commonly use a restricted no-tools configuration. There is no exposed hard conversation-only lock.

### Worker versus leader

Direct work assigned through chat to an ordinary worker creates that worker's task and starts it. A team leader can decompose, find subordinate workers, request other departments and convene planning. Planning can run precursor collaboration before its own final execution. If an appropriate subordinate is unavailable, a leader can self-assign.

### Mentions and announcements

An `@mention` is functional routing, not merely a visual tag. Cross-department mentions in agent messages and announcements can ask the relevant team leader to delegate work. A bare global message sent through the generic message endpoint is stored/broadcast; the dedicated Announcement action additionally schedules leader responses and mention delegation.

### Messenger and prefix scope

The current inbox API treats ordinary non-`$` messages as mapped-session agent chat; it rejects them when no session agent is configured. They are not automatically announcements. This differs from older prose in the repository instructions. `$` uses the directive path. `#` is an instruction convention for the external orchestrator described in AGENTS.md; it is not a universal server-side task prefix. Messenger reset commands clear conversation state; they do not cancel tasks. Supported channels and usable agent sessions depend on configuration; this guide does not assert that a particular channel is connected.

## 3. Task states

| State | Meaning | What can happen next |
| --- | --- | --- |
| Inbox | Recorded work awaiting assignment/run, or work returned after an ordinary failure. | Assign / Run / edit / cancel. |
| Planned | Assigned and staged; some delegation paths start it automatically after coordination. | Run or automatic scheduled execution. It does not necessarily mean a human approved a written plan. |
| Collaborating | Associated departments or child tasks are contributing. | Main execution or further coordination when dependencies complete. |
| In progress | The worker execution is active. | Review, wait/pending, failure, pause or cancellation. |
| Review | Execution finished and review/completion gates are being processed. | Done, remediation runs, decision selection or additional review. |
| Pending | Paused, interrupted, waiting for an external approval or another special workflow condition. | Read the log and resolve the specific cause, then resume when appropriate. |
| Done | Completion handling has run. | Inspect evidence/artifacts/merge status; the label is not an independent proof of quality, delivery or merge success. |
| Cancelled | Execution was stopped/cancelled. | Resume can restore the task to a runnable state, but cancelled worktree changes may already have been discarded. |

There is no distinct top-level Failed or Blocked status. Subtasks do have blocked information. This is why an unsuccessful task may show Inbox or Pending rather than Failed, and Pending alone cannot tell you which action it needs.

## 4. Routing, planning and execution

1. **Resolve input and project:** record the request, determine scope and obtain the project goal/path. Some app routes have fallback behavior; explicit project binding is the clearest way to control the working directory.
2. **Choose task guidance and owner:** use explicit agent choice, project assignment scope, department and availability. Run without an assignee can choose an available eligible worker; selection considers department fit, idle/break availability, role, previous workload and provider readiness. This is not a guarantee of optimal skill matching.
3. **Optional coordination:** a leader may run a Planning-led kickoff, collect action items and create subtasks. Skipping the planned meeting only skips that meeting. It does not disable later review or necessarily disable task decomposition.
4. **Dispatch contributions:** related subtasks can be grouped by department into delegated child tasks. Do not assume all branches run concurrently: batches, same-agent constraints and parent/child dependencies affect order. The parent can remain Collaborating or wait while child work proceeds.
5. **Prepare execution:** select provider/model, establish a task session, prepare/reuse a working directory and Git worktree when applicable, and construct task context.
6. **Execute:** the worker uses its provider's capabilities. CLI workers can have file/shell tools. Ollama task workers use OpenCode on the ATLAS host pointed at the model endpoint; that does not move the execution filesystem to the model machine. Other API-provider paths can be text-only rather than a full tool loop. Meeting/chat calls have a different execution configuration from full tasks.
7. **Collect result:** record output and exit status. Check special waits and dependencies, then enter ordinary review or a specialized completion path.

### What an executing agent knows

The execution prompt can include the task description, project context, department instructions, agent role/personality, selected skills, recent changes, a limited recent conversation excerpt (default ten messages), prior run/continuation context, review memos and injected instructions. Rollover uses a compact checkpoint. Agents do not automatically share an unlimited live memory of every other conversation or project.

General task context is not a full live synchronization channel: use the task intervention controls to deliberately alter an active task. Recent conversation can inform later runs without guaranteeing that the current worker has read a newly sent chat message.

The office animation is a presentation of status, collaboration and meeting events. Terminal output and system logs are stronger evidence of actual work than movement or a status bubble.

## 5. Ordinary review and completion

- A normal zero-exit worker run commonly moves to Review. A process can exit zero after saying it is blocked; the ordinary path does not universally validate semantic success first.
- Relevant leaders assess the result; Planning generally participates. Reviews can approve immediately or request remediation. Three rounds are not mandatory for every successful task.
- The phases are **remediation**, **consolidation**, and **final decision**. Round-one findings can produce an owner decision with selected improvements. Choosing improvements can create delegated remediation work. Skip advances the review phase; it does not rerun missing execution.
- Project-linked root work can wait at a project-level review-ready decision before a meeting. Selecting a representative task or starting review is a coordination action, not permission to run an SSH command.
- Outstanding subtasks/child work and special workflow gates can delay finalization. Review continuation may launch additional runs.
- Completion updates task/agent state and produces notifications, reports and potentially a consolidated Planning archive. Report presentation can be delayed until the archive is ready.
- Repository finalization can attempt to auto-commit task-worktree changes and merge. GitHub-linked handling can merge to dev and create a PR; ordinary local handling merges into the project branch. This existing automatic behavior is separate from the instruction in AGENTS.md that agents must ask before committing.
- **Current limitation:** merge failures are logged/notified, but the finalization path can still set Done. A Done task can therefore still need manual merge resolution; inspect Diff/merge and the system log. A created PR also does not mean that PR has been merged or deployed.

## 6. Specialized branches

- **Reports:** specialized report completion can close without the ordinary leader review meeting, while still generating an archive/report.
- **Presentation workflow:** can create a Design checkpoint child, put the parent Pending, then automatically rerun the parent to regenerate the final deck after Design completes. This is a deliberate workflow wait, not an SSH permission failure.

Report routing has a current project-linking caveat: although chat collects project metadata, its report handler is invoked without forwarding that metadata. It derives linkage from a path in the request or the target agent's current task. Confirm the report task's actual project/path. A presentation Design checkpoint can be skipped if no Design agent exists; final regeneration does not imply a second Design confirmation.

Two kinds of child work can appear: named company-agent delegated tasks and a CLI provider's native subagents/tools. Native delegation events can become tracked subtasks without creating a separately named company agent. External-department work is grouped into departmental batches and dispatched sequentially. Delegated children commonly wait in Review for parent consolidation instead of independently repeating the entire review process; parent final approval consolidates them.

## 7. Permission and decision layers

| Layer | Effect | Resume behavior |
| --- | --- | --- |
| Host access | All enabled hosts are shared by default; optional per-host agent allowlists limit sensitive hosts. | Opening access does not itself restart a pending task. |
| SSH exact-command approval | Known read-only checks auto-approve by default. Commands that may change state, read secrets or are not recognized as safe wait. Requests are bound to task/agent/host/exact command and consumed once. | Approving a waiting request does not automatically resume its worker. |
| Email approval | Worker prepares a linked exact message and sender. Owner approval sends that message. Failed/unknown delivery needs inspection; unknown is not a safe automatic resend. | Sending approved mail does not itself resume the task that prepared it. |
| Model choice/upgrade | A configured model director can choose among available candidates or decide upgrade requests; owner controls can also decide. Existing work is preserved for continuation. | Approved director escalation has a resume path; ordinary owner routes may require a separate resume. Read the task event. |
| Workflow decision | Choose review work, start project review or resume after timeout. | The chosen option determines whether more work or another review phase starts. |
| Runtime permissions | CLI provider flags and tool restrictions govern the subprocess itself. | Separate from app decisions and from the app's YOLO setting. |

Business profiles, contacts, tickets, quotes and drafts are available through task tools. Profile text does not grant permission to send mail. Social integration currently provides configured account/recent-media context; owner posting remains manual. Money-handling actions remain outside this workflow.

## 8. Failures, pauses and automatic events

| Event | Current consequence / owner action |
| --- | --- |
| Manual Pause | Interrupt worker, preserve session/worktree, set Pending. Resume when ready. |
| Inject instruction | Requires a paused task/session. Store instruction for next execution, then resume. The UI can perform pause + inject + resume together. |
| Cancel | Stop execution, clear workflow state and roll back task-worktree work. Linked delegated parent subtasks can become blocked. It cannot undo emails already sent or commands already executed on remote hosts. |
| Resume Pending | Assigned available agent can automatically run again with preserved context/worktree. Unassigned work returns to Inbox. |
| Resume Cancelled | Restore Planned/Inbox; this is not guaranteed recovery of discarded changes and does not use the same automatic-run branch as paused work. |
| Ordinary worker failure / timeout | Commonly returns to Inbox and cleans up the worktree. Read failure summary/output before retrying. Timeout can create a Decision Inbox resume choice. |
| Provider unavailable / interrupted worker | Preserve worktree and put task Pending; provider outage may mark agent Offline and notify leaders/owner. Resume after availability returns. Automatic reconnect-based reassignment is not a general guarantee. |
| Stale process / server restart | Runtime recovery checks can reconcile tasks with no live worker and expose them for recovery. Some rollover state is durable; arbitrary interrupted task work does not all resume automatically. |
| Ollama/OpenCode context pressure | At configured 80% threshold or recognized context exhaustion, save checkpoint and start fresh context in the same worktree. Six rollovers or two consecutive stalled rollovers trigger escalation rather than unlimited looping. User pause/cancel prevents automatic continuation. |
| Model too weak | Upgrade request/checkpoint can preserve work and wait for stronger-model decision. |
| Child completion | Updates parent subtasks and can release waiting parent/collaboration work. Cancelling/failing a child can leave a blocked dependency. |
| Report Design completion | Automatically releases parent for final regeneration. |
| Review decision | Can launch remediation, start a review meeting or advance a round. |
| External-action approval | Resolves that approval; normally still inspect/resume the task separately. |

### YOLO has a specific scope

App YOLO auto-selects supported Decision Inbox choices: timeout resume, project review-ready actions and review-round picks. It favors suggested/available options. It does not remove meetings, eliminate review, approve dangerous SSH commands or send email. The CLI provider's own `--yolo`/permission flags are a separate mechanism. Turning app YOLO on can start more work automatically; it is not a simple-task mode.

Normal task CLI runs currently use permissive provider flags independently of app YOLO. Thus app YOLO Off does not mean every local shell command waits for permission. The SSH/email gateway approval rules are separate from those provider flags.

Runtime defaults include a 15-minute CLI idle timeout, no hard runtime ceiling, an approximately 30-second orphan watchdog sweep with a 10-minute grace, and a 15-second delegation sweep. Deployment environment overrides can change these. The watchdog checks live-process state and recent logs before recovering apparently orphaned tasks. Startup also reconciles interrupted meetings/subtasks, working agents and recoverable review/rollover state. This is repair logic, not an unconditional restart of every Pending task.

### Agents suggesting work on their own

Every 10 minutes the server lets one eligible, idle agent think about its area (at most once every 6 hours per agent, `AUTONOMY_THINK_INTERVAL_MS` overrides). Team leaders are always eligible; other agents only when **Suggests tasks** is on in Team > Edit agent. The agent sees its personality, department, recent projects, its own recent tasks, open department tasks, filled-in business profiles and its earlier suggestions. It runs without tools and may suggest up to two tasks.

Suggestions appear on Today under Needs you. **Add to tasks** creates a planned task assigned to that agent; nothing starts until you run it. **Dismiss** is remembered so the idea is not repeated. Limits: two open suggestions per agent, twelve overall, and unanswered suggestions expire after seven days. A failed or unreadable reply is stored in `agent_autonomy_state.last_error`. Setting `autonomyProposalsEnabled` to `false` turns the whole feature off (no UI yet).

## 9. How to inspect and steer work

- **Today:** owner attention queue, running/review work, decisions, SSH/model/email approval cards and draft links.
- **Work task drawer:** status, assignee, subtasks, model route, recent activity and result; actions include Run, Pause, Resume, Cancel, Full log, Minutes, Diff/merge and Report when applicable.
- **Terminal:** actual worker commands/output plus system events. Use it to distinguish waiting, execution failure and semantic failure. Meetings have a Minutes view.
- **Task intervention:** use for an explicit instruction that must enter the next worker run. Chatting with the agent is not equivalent.
- **Decision Inbox:** use the specific structured option; a free-text follow-up can become more work or a contextual decision depending on the route.
- **Manual status editing:** changes metadata. It is not a substitute for Run, Pause, Resume or verification. Moving a card to Done does not perform its work or prove its output.
- **Hide:** removes tasks from the visible board without cancelling them. **Delete:** removes a task record through a separate destructive management action. Neither should be confused with a resumable Pause.
- **Diff/merge:** review repository changes and integration results; this is separate from the agent's prose report.
- **Agent/department/project settings:** change identity, provider/model, shared instructions and eligible participants for future routing. Editing configuration is different from injecting instructions into a live process.

## 10. Choosing a route deliberately

- Ask a named agent for status when you need an update; inspect the task if the response is ambiguous.
- Use Create task, inspect the description/project/assignee, then Run for the most explicit setup.
- Use a worker's Task mode for a bounded assignment with little pre-coordination. Post-run review still applies.
- Use a leader or directive when decomposition and cross-team coordination are useful.
- Use Report mode for report/deck output and expect its specialized design/archive steps.
- Use intervention to correct a running assignment. Use Pause to keep work; Cancel when you intend to stop and discard local task work.
- Inspect the exact Pending reason and resolve its own gate. Do not assume every wait is asking for your permission.

There is currently no general Quick/diagnostic mode that guarantees Assign -> Execute -> Verify -> Done without meetings/worktree/archive overhead. The scope of this document is understanding current behavior, not introducing that mode.

The cost of one visible task can include several kinds of model calls: chat acknowledgement, kickoff speakers and summary, model selection, worker execution, child-task execution, review speakers and consolidation, decision-option preparation and final archive. A meeting is not necessarily one model call, and waiting for a person or dependency is not model execution time.

## Code reference index

Entry points: `src/components/ChatPanel.tsx`, `server/modules/routes/ops/messages/{chat-routes,announcements-routes,directives-inbox-routes}.ts`, `server/modules/routes/collab/direct-chat-{intent-utils,handlers,task-flow}.ts`, `server/modules/routes/core/tasks/crud.ts`.

Assignment and execution: `server/modules/routes/collab/task-delegation.ts`, `server/modules/routes/collab/subtask-delegation*.ts`, `server/modules/routes/core/tasks/execution-run*.ts`, `server/modules/workflow/orchestration/execution-start-task.ts`.

Review/completion: `server/modules/workflow/orchestration/{run-complete-handler,review-finalize-tools,session-review-tools,report-workflow-tools}.ts`, `server/modules/workflow/orchestration/meetings/{leader-selection,review-consensus-outcome}.ts`, `server/modules/workflow/core/worktree/merge.ts`.

Owner controls and decisions: `src/components/{TerminalPanel,DecisionInboxModal}.tsx`, `src/components/work/TaskDrawer.tsx`, `src/components/today/TodayView.tsx`, `server/modules/routes/core/tasks/execution-control.ts`, `server/modules/routes/ops/messages/decision-inbox/*.ts`.

Context and tools: `server/modules/workflow/core/{conversation-context-tools,project-context-tools,cli-tools,one-shot-runner}.ts`, `server/modules/workflow/agents/context-rollover-*.ts`, `server/modules/model-routing.ts`, `server/modules/routes/ops/agent-tools.ts`, `docs/local-agent-resilience.md`.
