# How tasks move through ATLAS

For the full system-wide guide covering all interaction modes, task states, automatic events, recovery and controls, see [ATLAS agent and task system guide](agent-task-system-guide.md). This shorter document focuses on the SSH example and basic lifecycle.

## Two independent kinds of approval

SSH command approval decides whether a specific command may execute on a specific host. Task review decides whether the overall requested outcome is complete. Automatically approving a read-only command does not bypass task review.

Host access is a third, separate control: enabled SSH hosts are available to all agents by default. In Homelab > select host > Agent access, enable **Restrict to selected agents** for sensitive hosts. Saved selections survive turning restrictions off. An empty selection on a restricted host allows no agents. Disabled hosts remain unavailable. Access is checked in discovery, request creation, and execution; an already approved command cannot bypass a subsequently enabled host restriction.

Known read-only commands are automatically approved by default. Commands that may change a host, read secrets, or cannot be classified as safe need the owner's exact-command approval. This is deliberately broader than only commands known to destroy data. Approvals remain scoped to the task, agent, host, and exact command, and can be used once.

## General task lifecycle

| Stage | What happens |
| --- | --- |
| Inbox | Request is recorded; assignment and project context are resolved. |
| Planned / assigned | Task is ready for an agent. A CEO directive may first convene a Planning meeting. Direct assignment and run do not require that meeting. |
| In progress | The assigned worker executes. It can use task-scoped tools, request command approval, and delegate subtasks when applicable. Repository tasks may create a Git worktree. |
| Review | A normal worker process exit enters review. This is not proof that the user's objective was achieved. Team leaders assess the output. |
| Decision Inbox | Certain review findings need a choice: address revisions, advance, or another available action. The decision's meaning depends on its stage. |
| Pending | Execution is on hold; inspect the terminal and task logs for the reason. This status alone does not identify an SSH approval problem. Resume schedules the assigned worker to run again. |
| Done | The task has passed completion/review handling. Planning can create an archive summary; repository work can include merge handling. |

The review phases are remediation, consolidation, and final decision. A successful first review can finish immediately; three rounds are not mandatory for every task. When review asks for revisions, later rounds can create substantial overhead. **Skip** in the review decision advances review; it does not execute the missing command or automatically mark the task complete.

The directive option to skip the planned meeting only skips the initial planning meeting. It does not disable review after execution. There is currently no general lightweight diagnostic mode that avoids meetings, worktree setup, and the Planning archive.

## What happened to the Media SSH test

1. The task was directly assigned to Marcus and run. There was no initial Planning meeting.
2. His target lookup returned an empty list because the host grant did not yet exist. He reported the blocker without connecting or pinging.
3. The CLI exited with code zero. The run-completion handler treated that as a completed execution and moved it to Review, despite the unmet objective.
4. Round-one reviewers requested access and evidence. The review decision was advanced with Skip, which scheduled consolidation and then final review. It did not rerun the ping.
5. The owner retried after access had been granted. The ping was automatically approved, returned four replies with zero packet loss, and the task finished Done.

The first execution was about 16 seconds. The successful retry was about 29 seconds, followed by about 50 seconds before Done. The overall elapsed interval also included waiting for user actions; it was not all model execution.

## Recommended simplification (not implemented here)

Add an explicit lightweight task mode for diagnostics and small operations:

**Assign -> Execute -> Verify evidence -> Done**

Represent an unmet prerequisite as **Blocked + a concrete reason**, then retry execution when resolved. Keep dangerous-command approval independent. Reserve leader meetings, remediation rounds, and repository merge handling for work that benefits from them. A process exit code should not be the sole signal of task success.

## Implementation references

- `server/modules/workflow/orchestration/run-complete-handler.ts`: successful process exit enters review.
- `server/modules/workflow/orchestration/meetings/leader-selection.ts`: review participant selection.
- `server/modules/workflow/orchestration/meetings/review-consensus-outcome.ts`: revision decisions and review-round advancement.
- `server/modules/routes/ops/messages/decision-inbox/review-round-reply.ts`: Skip decision handling.
- `server/modules/workflow/orchestration/session-review-tools.ts`: review phase definitions.
- `server/modules/workflow/orchestration/review-finalize-tools.ts`: final completion and archive handling.
- `server/modules/routes/core/tasks/execution-control.ts`: resume behavior.
- `server/modules/routes/collab/task-delegation.ts`: initial planned-meeting skip.
