<#
.SYNOPSIS
  Renames ATLAS on disk (work restructure, phase 8): the database file and the repo folder.

.DESCRIPTION
  Dry run by default: it only prints what it would do. Add -Apply to do it.
  With -Apply it:
    1. stops the ATLAS service and removes its login task (the task holds the old folder path);
    2. backs up the database to backups\before-rename-<time>.sqlite;
    3. renames claw-empire.sqlite (and its -wal/-shm files) to atlas.sqlite;
    4. renames the repo folder to the new name (default: atlas, next to the current folder);
    5. installs the login task again from the new folder and starts ATLAS.
  ATLAS also runs fine before this: it keeps using claw-empire.sqlite while that is the only database file.

  Close anything that has files open in the repo folder first (editors, terminals, Claude Code sessions in it),
  or step 4 fails. If it fails there, the database is already renamed and backed up; close those apps and run
  the script again with -Apply (it skips steps already done).

.EXAMPLE
  .\scripts\atlas-service\rename-to-atlas.ps1            # dry run
  .\scripts\atlas-service\rename-to-atlas.ps1 -Apply     # do it
#>
param(
  [switch]$Apply,
  [string]$NewName = "atlas"
)

$ErrorActionPreference = "Stop"
$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Parent = Split-Path $RepoDir -Parent
$Target = Join-Path $Parent $NewName
$OldDb = Join-Path $RepoDir "claw-empire.sqlite"
$NewDb = Join-Path $RepoDir "atlas.sqlite"
$Service = Join-Path $PSScriptRoot "atlas-service.ps1"
$Stamp = Get-Date -Format "yyyy-MM-dd-HHmmss"

function Step([string]$Text) { Write-Output ("{0} {1}" -f $(if ($Apply) { "[do]" } else { "[dry run]" }), $Text) }

if ((Split-Path $RepoDir -Leaf) -eq $NewName) {
  Write-Output "The repo folder is already named '$NewName'."
} elseif (Test-Path $Target) {
  throw "Can't rename: '$Target' already exists. Move it away or pick another -NewName."
}
if ((Test-Path $OldDb) -and (Test-Path $NewDb)) {
  throw "Both claw-empire.sqlite and atlas.sqlite exist in $RepoDir. Check which one is current before going on."
}

# 1. Stop the service and remove its login task.
Step "Stop ATLAS and remove the 'ATLAS' login task ($Service uninstall)"
if ($Apply -and (Get-ScheduledTask -TaskName "ATLAS" -ErrorAction SilentlyContinue)) {
  & $Service uninstall
  Start-Sleep -Seconds 5
}

# 2 and 3. Back up, then rename the database.
if (Test-Path $OldDb) {
  $Backups = Join-Path $RepoDir "backups"
  $Backup = Join-Path $Backups "before-rename-$Stamp.sqlite"
  Step "Back up $OldDb to $Backup"
  Step "Rename claw-empire.sqlite (and -wal/-shm) to atlas.sqlite"
  if ($Apply) {
    New-Item -ItemType Directory -Force $Backups | Out-Null
    Copy-Item $OldDb $Backup
    foreach ($suffix in @("-wal", "-shm")) {
      if (Test-Path ($OldDb + $suffix)) { Copy-Item ($OldDb + $suffix) ($Backup + $suffix) }
    }
    Move-Item $OldDb $NewDb
    foreach ($suffix in @("-wal", "-shm")) {
      if (Test-Path ($OldDb + $suffix)) { Move-Item ($OldDb + $suffix) ($NewDb + $suffix) }
    }
  }
} else {
  Write-Output "No claw-empire.sqlite here (already renamed, or the database lives elsewhere)."
}

# 4. Rename the folder.
$FinalDir = $RepoDir
if ((Split-Path $RepoDir -Leaf) -ne $NewName) {
  Step "Rename folder $RepoDir to $Target"
  if (-not $Apply) { $FinalDir = $Target }
  if ($Apply) {
    Set-Location $Parent
    try {
      Rename-Item -LiteralPath $RepoDir -NewName $NewName
      $FinalDir = $Target
    } catch {
      Write-Warning "The folder couldn't be renamed (something still has files open in it): $($_.Exception.Message)"
      Write-Warning "Close editors, terminals and Claude Code sessions in it, then run this script again with -Apply."
      Write-Warning "ATLAS is stopped. To start it from the old folder instead: $Service install"
      exit 1
    }
  }
}

# 5. Install the login task again from the new folder.
$NewService = Join-Path $FinalDir "scripts\atlas-service\atlas-service.ps1"
Step "Install and start the login task from $FinalDir ($NewService install)"
if ($Apply) { & $NewService install }

Write-Output ""
Write-Output "After the rename:"
Write-Output " - Open the project from $FinalDir in your editor and in Claude Code / Codex."
Write-Output " - Claude Code keeps per-folder memory under ~\.claude\projects\<folder name>; copy the old folder's"
Write-Output "   memory directory to the new name if you want it to carry over."
Write-Output " - Check ATLAS answers: http://127.0.0.1:8800/api/health"
if (-not $Apply) { Write-Output ""; Write-Output "Nothing was changed. Run again with -Apply to do it." }
