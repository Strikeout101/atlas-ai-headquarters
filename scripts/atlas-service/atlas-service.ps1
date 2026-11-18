<#
.SYNOPSIS
  Manage the ATLAS service: a stable build of the latest commit, started at login, restarted after crashes.

.EXAMPLE
  .\scripts\atlas-service\atlas-service.ps1 install    # start ATLAS at every login (runs it now too)
  .\scripts\atlas-service\atlas-service.ps1 status
  .\scripts\atlas-service\atlas-service.ps1 update     # build and switch to the latest commit (rolls back if unhealthy)
  .\scripts\atlas-service\atlas-service.ps1 restart
  .\scripts\atlas-service\atlas-service.ps1 stop
  .\scripts\atlas-service\atlas-service.ps1 start
  .\scripts\atlas-service\atlas-service.ps1 uninstall  # remove the login task (stops ATLAS)

.NOTES
  The task runs as you, only while you are signed in, and stores no password. Data stays in the repo folder
  (database, logs, knowledge). Releases and service state live in %LOCALAPPDATA%\ATLAS.
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("install", "uninstall", "start", "stop", "restart", "update", "status")]
  [string]$Command = "status",
  [int]$Port = 8800,
  # For testing on another folder; the login task always uses the default.
  [string]$ServiceDir = (Join-Path $env:LOCALAPPDATA "ATLAS"),
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$TaskName = "ATLAS"
$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Supervisor = Join-Path $PSScriptRoot "supervisor.mjs"
$StateFile = Join-Path $ServiceDir "service.json"
$RequestFile = Join-Path $ServiceDir "request.json"
$LockFile = Join-Path $ServiceDir "supervisor.pid"

function Get-NodePath {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js was not found. Install Node 22 or newer first." }
  return $node.Source
}

function Test-SupervisorRunning {
  if (-not (Test-Path $LockFile)) { return $false }
  $procId = [int](Get-Content $LockFile -Raw)
  return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

function Send-Request([string]$Action) {
  if (-not (Test-SupervisorRunning)) { throw "ATLAS is not running. Start it with: atlas-service.ps1 start" }
  $temp = "$RequestFile.tmp"
  $json = @{ action = $Action; requested_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding $false))
  Move-Item -Force $temp $RequestFile
  Write-Output "Requested '$Action'. Follow it in $ServiceDir\supervisor.log"
}

function Show-Status {
  $running = Test-SupervisorRunning
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Output ("Login task:  " + $(if ($task) { "installed ($($task.State))" } else { "not installed" }))
  Write-Output ("Supervisor:  " + $(if ($running) { "running" } else { "not running" }))
  if (Test-Path $StateFile) {
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    $head = (git -C $RepoDir rev-parse HEAD).Trim()
    Write-Output ("Running:     " + $(if ($state.current_sha) { $state.current_sha.Substring(0, 12) } else { "-" }))
    Write-Output ("Repo HEAD:   " + $head.Substring(0, 12) + $(if ($head -ne $state.current_sha) { "  (update available)" } else { "" }))
    Write-Output ("Restarts:    " + $state.restarts)
    if ($state.last_update) { Write-Output ("Last update: " + $state.last_update.detail) }
  }
  try {
    $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$Port/api/health"
    Write-Output "Health:      OK (http://127.0.0.1:$Port)"
  } catch {
    Write-Output "Health:      not answering on port $Port"
  }
}

New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null

switch ($Command) {
  "install" {
    $node = Get-NodePath
    $action = New-ScheduledTaskAction -Execute $node -Argument "`"$Supervisor`" --port $Port" -WorkingDirectory $RepoDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
      -Description "ATLAS AI Headquarters: stable build on port $Port, restarted after crashes. Managed by $PSCommandPath" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Installed the '$TaskName' login task and started it. The first start builds a release (a few minutes)."
    Write-Output "Open http://127.0.0.1:$Port (phones on the VPN: this PC's LAN address, port $Port)."
  }
  "uninstall" {
    if (Test-SupervisorRunning) { Send-Request "stop"; Start-Sleep -Seconds 5 }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Removed the '$TaskName' login task. Releases remain in $ServiceDir\releases."
  }
  "start" {
    if (Test-SupervisorRunning) { Write-Output "ATLAS is already running."; break }
    $defaultDir = Join-Path $env:LOCALAPPDATA "ATLAS"
    if ($ServiceDir -eq $defaultDir -and -not $DataDir -and (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
      Start-ScheduledTask -TaskName $TaskName
    } else {
      $node = Get-NodePath
      $argList = "`"$Supervisor`" --port $Port --service-dir `"$ServiceDir`""
      if ($DataDir) { $argList += " --data-dir `"$DataDir`"" }
      Start-Process -FilePath $node -ArgumentList $argList -WorkingDirectory $RepoDir -WindowStyle Hidden
    }
    Write-Output "Starting ATLAS on port $Port."
  }
  "stop" { Send-Request "stop" }
  "restart" { Send-Request "restart" }
  "update" { Send-Request "update" }
  "status" { Show-Status }
}
