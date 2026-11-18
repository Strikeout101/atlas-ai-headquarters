# Running ATLAS

## The service (day-to-day)

ATLAS runs as a stable build of the latest **committed** version, started at login and restarted after a crash.
Work in progress in the repo folder never reaches it until you press **Update**.

| What                        | Where                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Open ATLAS                  | http://127.0.0.1:8800 (phones on the home VPN: this PC's LAN address, port 8800)          |
| Start now                   | `start-atlas.bat`, or `.\scripts\atlas-service\atlas-service.ps1 start`                   |
| Start at every login        | `.\scripts\atlas-service\atlas-service.ps1 install` (once; `uninstall` removes it)        |
| Status                      | `.\scripts\atlas-service\atlas-service.ps1 status`, or Settings > General > Service       |
| Update to the latest commit | Settings > General > Service > **Update to latest commit**, or `atlas-service.ps1 update` |
| Restart / stop              | Settings > General > Service > **Restart**, or `atlas-service.ps1 restart` / `stop`       |
| Service state and releases  | `%LOCALAPPDATA%\ATLAS` (`service.json`, `supervisor.log`, `releases\<commit>`)            |
| Server logs                 | `logs\server\atlas-YYYY-MM-DD.log` (kept 14 days)                                         |

How it works (`scripts/atlas-service/supervisor.mjs`):

- Each release is a git worktree of one commit in `%LOCALAPPDATA%\ATLAS\releases`, with its own packages and built
  web app. The last three are kept.
- The server runs from the release, but its data stays in the repo folder: `claw-empire.sqlite`, `logs\`,
  `knowledge\`, `backups\` and `.env`.
- It restarts after a crash (waiting 2s, then 4s, 8s ... up to a minute) and when `/api/health` fails three checks in a
  row.
- **Update** builds the latest commit while the old version keeps running, switches over, and checks the new one. If
  it does not answer within 90 seconds it switches back to the previous version and says why in Settings.
- The login task runs as you, only while you are signed in, and stores no password.

### Development mode

`start-atlas-dev.bat` runs `pnpm dev` (web on 8800, API on 8790) with live reload. **Every saved server file restarts
it against the real database.** Stop the service first; both use port 8800. Codex and Claude test in the separate
browser-test runtime (`pnpm dev:e2e`, ports 8810/8811, its own database) instead.

## Backups

Settings > General > Backups.

- Every day at the chosen hour (default 3 AM), and at startup if the day's backup was missed, ATLAS copies the
  database to `backups\auto\claw-empire-<date>-<time>.sqlite`.
- Each copy is restore-tested: opened on its own, integrity-checked, and its row counts compared with the live
  database. A copy that fails is reported and never replaces or prunes good ones.
- Copies older than the retention (default 30 days) are deleted, but the newest three are always kept. Manual
  backups in `backups\` are never touched.
- **Copy off this PC:** set a folder (a NAS share such as `\\nas\backups\atlas`, an external drive, or a OneDrive
  folder). ATLAS checks it can write there, then copies every good backup and verifies the copy. If the folder is
  unreachable the local backup still succeeds and Settings shows the copy failed.

### Restoring a backup

```powershell
.\scripts\atlas-service\restore-backup.ps1 -Backup .\backups\auto\claw-empire-2026-11-18-030000.sqlite
```

The script checks the backup, stops the service, saves the current database as
`backups\before-restore-<time>.sqlite`, puts the backup in place, checks it, and starts the service again. Nothing is
deleted. Close a dev server window yourself first; the script refuses while one is running.

## Updates from upstream

ATLAS is a fork of claw-empire. The inherited auto-updater (which pulls upstream releases) is locked so it can never
overwrite this fork: it does not check upstream and refuses to apply updates unless `ATLAS_ALLOW_UPSTREAM_UPDATE=1`
is set in `.env`. Upstream changes are merged by hand in git.
