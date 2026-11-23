<#
.SYNOPSIS
  Restore the ATLAS database from a backup file.

.DESCRIPTION
  1. Checks the backup opens and passes SQLite's integrity check.
  2. Stops ATLAS (the service, if running; a dev server must be closed by hand).
  3. Saves the current database as backups\before-restore-<time>.sqlite.
  4. Copies the backup into place and removes the old -wal and -shm files.
  5. Checks the restored database, then starts ATLAS again.
  Nothing is deleted: the database that was replaced stays in backups\.

.EXAMPLE
  .\scripts\atlas-service\restore-backup.ps1 -Backup .\backups\auto\atlas-2026-11-18-030000.sqlite
#>
param(
  [Parameter(Mandatory = $true)][string]$Backup,
  [string]$Database,
  [int]$Port = 8800,
  [string]$ServiceDir = (Join-Path $env:LOCALAPPDATA "ATLAS"),
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $Database) {
  $Database = Join-Path $RepoDir "atlas.sqlite"
  if (-not (Test-Path $Database)) { $Database = Join-Path $RepoDir "claw-empire.sqlite" }  # before the rename
}
$Backup = (Resolve-Path $Backup).Path
$Service = Join-Path $PSScriptRoot "atlas-service.ps1"

$DbTool = Join-Path $PSScriptRoot "db-tool.mjs"

# Windows PowerShell treats anything a program writes to stderr as an error when ErrorActionPreference is Stop.
function Invoke-DbTool {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { node --no-warnings $DbTool @args 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
  return $LASTEXITCODE -eq 0
}

function Test-Database([string]$Path) {
  return (Invoke-DbTool check $Path)
}

if (-not (Test-Database $Backup)) { throw "The backup failed its integrity check. Nothing was changed." }

$wasRunning = $false
$lock = Join-Path $ServiceDir "supervisor.pid"
if ((Test-Path $lock) -and (Get-Process -Id ([int](Get-Content $lock -Raw)) -ErrorAction SilentlyContinue)) {
  $wasRunning = $true
  & $Service stop -Port $Port -ServiceDir $ServiceDir | Out-Null
  for ($i = 0; $i -lt 30 -and (Test-Path $lock); $i++) { Start-Sleep -Seconds 1 }
}
# The dev server (port 8790) only matters when restoring the real database.
$ports = @($Port)
if ((Split-Path $Database -Parent) -eq $RepoDir) { $ports += 8790 }
$listening = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue
if ($listening) { throw "ATLAS is still running (a port is in use). Close the dev server window, then run this again." }

$stamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$saved = Join-Path (Join-Path (Split-Path $Database) "backups") "before-restore-$stamp.sqlite"
New-Item -ItemType Directory -Force -Path (Split-Path $saved) | Out-Null
if (Test-Path $Database) {
  if (-not (Invoke-DbTool snapshot $Database $saved)) { throw "Could not save the current database. Nothing was changed." }
  Write-Output "Saved the current database as $saved"
}

Remove-Item -Force -ErrorAction SilentlyContinue "$Database-wal", "$Database-shm"
Copy-Item -Force $Backup $Database
if (-not (Test-Database $Database)) {
  Copy-Item -Force $saved $Database
  throw "The restored database failed its check; the previous one was put back."
}
Write-Output "Restored $Backup"

if ($wasRunning -and -not $NoStart) {
  & $Service start -Port $Port -ServiceDir $ServiceDir -DataDir (Split-Path $Database) | Out-Null
  Write-Output "ATLAS is starting again."
}
