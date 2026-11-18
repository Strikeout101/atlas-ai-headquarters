# ATLAS docs

Which documents describe ATLAS as it is now, and which are dated history. Pending work is tracked in `CHECKLIST.md` at the repo root, not here.

## Current reference

| Document                                                 | What it covers                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [agent-tools.md](agent-tools.md)                         | The agent tool gateway: every operation agents can call and the rules the server enforces. Agents read it with `knowledge.get {"topic":"tools"}`. |
| [agent-task-system-guide.md](agent-task-system-guide.md) | How tasks, agents, delegation and runs work, traced from the code.                                                                                |
| [task-flow.md](task-flow.md)                             | How a task moves through its states.                                                                                                              |
| [api.md](api.md) and [openapi.json](openapi.json)        | The HTTP API (partial coverage; openapi is checked in CI).                                                                                        |
| [business-mailboxes.md](business-mailboxes.md)           | Mailcow connections and approved email sending.                                                                                                   |
| [social-integrations.md](social-integrations.md)         | Instagram connection (read-only).                                                                                                                 |
| [ssh-host-manager.md](ssh-host-manager.md)               | Homelab SSH hosts, approvals and grants.                                                                                                          |
| [local-agent-resilience.md](local-agent-resilience.md)   | Local/API model workers and context rollover.                                                                                                     |
| [models-and-workers.md](models-and-workers.md)           | Routine local routing, separate directors, worker performance, public research tools and merge completion.                                        |
| [operations.md](operations.md)                           | Running ATLAS as a service, updates, backups and restoring.                                                                                       |
| [phase3-vp-approvals.md](phase3-vp-approvals.md)         | The two VPs and who approves what.                                                                                                                |
| [phase4-autonomy.md](phase4-autonomy.md)                 | Goals, opportunities, routines and the autonomy engine.                                                                                           |
| [phase5-finance.md](phase5-finance.md)                   | Deals, ledger, spending requests and read-only Square.                                                                                            |
| [phase6-listings.md](phase6-listings.md)                 | Etsy and itch.io listing packages and the fee budget.                                                                                             |
| [DESIGN.md](DESIGN.md)                                   | UI and visual style.                                                                                                                              |

## Private, not in git

| Location                | What it holds                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `knowledge/systems.md`  | The systems registry: hosts, addresses, ports, accounts and where each system is controlled. Its `## Summary` goes into every task prompt. Template: `knowledge.example/systems.md`. |
| `SETUP-INFO-NEEDED.txt` | The owner's setup answers and handoffs. Template: `SETUP-INFO-NEEDED.example.txt`.                                                                                                   |

Agent memories (facts and lessons) live in the database and are reviewed under Team > Knowledge.

## Dated history

Kept for context; check against the code before relying on them. Upstream claw-empire release notes, plans and install/deploy files were removed on 2026-11-18; they remain in git history and in the `upstream` remote.

| Document                                                                               | Notes                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [operations-setup-2026-11-12.md](operations-setup-2026-11-12.md)                       | Owner setup notes from 2026-11-12.                                 |
| [models-workers-verification-2026-11-18.md](models-workers-verification-2026-11-18.md) | Real provider/autonomy verification evidence and remaining limits. |
| [agent-access-review-2026-11-14.md](agent-access-review-2026-11-14.md)                 | Access gap review from 2026-11-14; several gaps since closed.      |
| [DESIGN_SKILLS.md](DESIGN_SKILLS.md)                                                   | Upstream design for skill learning history.                        |
| [architecture/](architecture/)                                                         | Generated upstream diagrams from 2026-02-18; out of date.          |
| `art/`                                                                                 | Art credits.                                                       |
