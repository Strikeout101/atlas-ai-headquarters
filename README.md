<p align="center">
  <img src="public/atlas.svg" width="80" alt="ATLAS" />
</p>

<h1 align="center">ATLAS</h1>

<p align="center">
  The AI headquarters that runs the owner's businesses and homelab with teams of AI agents.
</p>

ATLAS runs AI agents (Codex, Claude, Gemini, OpenCode, Kimi and local models) as departments of one company. They plan
work, carry it out in git worktrees, review each other and report back. Two AI vice presidents approve routine work
for the owner. The owner still approves customer-facing work for the service businesses, all spending and anything
that can't be undone.

It runs three businesses (Small Business Tech, Primrose Events and AI Ventures) and the homelab. The aim is for
agents to run them on their own, with the owner approving only big deals, important clients, money and anything that
can't be undone.

ATLAS is a private fork of [claw-empire](https://github.com/GreenSheep01201/claw-empire) (Apache 2.0). The 3D office
and the core agent runtime come from upstream; the business, approval, autonomy and operations layers are ATLAS's
own. Upstream changes are merged by hand, and the built-in upstream updater is locked.

## Where things stand

- [`CHECKLIST.md`](CHECKLIST.md) is the single list of what works, what is pending and what only the owner can do.
- [`docs/README.md`](docs/README.md) lists which documents describe ATLAS today and which are history.
- [`AGENTS.md`](AGENTS.md) holds the rules every coding agent follows in this repo.

## What it does

| Area             | What ATLAS handles                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tasks and agents | Task board, departments, meetings, delegation, reviews and merges, with each run in its own git worktree.            |
| Approvals        | Per-business rules for who approves what (owner, VPs or no one), deal-size and client limits, trust ramp, budgets.   |
| Autonomy         | Goals, scored opportunities, research schedules, a daily start cap and usage limits per model subscription.          |
| Businesses       | Contacts, tickets, quotes, deals, ledger and spending requests; mailboxes; read-only Square; listing packages.       |
| Homelab          | SSH hosts where read-only commands run automatically and everything else needs approval.                             |
| Models           | Subscription CLIs plus a local model host, with routing by task kind and per-provider usage limits.                  |
| Agent knowledge  | Business profiles, a systems summary and reviewed memories in every task prompt.                                     |
| Reliability      | Runs as a service of the latest commit, restarts after a crash, updates with rollback, takes restore-tested backups. |

## Running it (Windows)

Needs Node.js 22+, pnpm (enabled through corepack) and git.

```powershell
pnpm install
```

| What                         | How                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Start ATLAS                  | `start-atlas.bat` (builds the latest commit and runs it on port 8800)                     |
| Start at every login         | `.\scripts\atlas-service\atlas-service.ps1 install`                                       |
| Update, restart, status      | Settings > General > Service, or `atlas-service.ps1 update` / `restart` / `status`        |
| Back up and restore          | Settings > General > Backups; `.\scripts\atlas-service\restore-backup.ps1 -Backup <file>` |
| Development with live reload | `start-atlas-dev.bat` (only while the service is stopped; edits hit the real database)    |

Open http://127.0.0.1:8800 and sign in with the owner password. Phones on the home VPN use this PC's LAN address on
port 8800. Full details: [`docs/operations.md`](docs/operations.md).

Settings and secrets live in `.env` (template: `.env.example`). Private notes about hosts and accounts live in
`knowledge/` (template: `knowledge.example/`) and never go in git.

## Development

| Check           | Command                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| Server tests    | `pnpm test:api`                                                           |
| Web tests       | `pnpm test:web`                                                           |
| Types           | `pnpm exec tsc -p tsconfig.node.json --noEmit` and `-p tsconfig.app.json` |
| Lint and format | `pnpm lint`, `pnpm format:check`                                          |
| API contract    | `pnpm openapi:check`                                                      |
| Browser tests   | `pnpm test:e2e` (own runtime on ports 8810/8811 with its own database)    |

Agents never commit without tests passing and the owner's approval; see `AGENTS.md`.

## License

[Apache 2.0](LICENSE). Based on claw-empire by GreenSheep01201 and contributors.
