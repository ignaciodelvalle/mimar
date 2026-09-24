#Requires -Version 5.1
<#
.SYNOPSIS
  QA-night synthetic monitor loop. Runs e2e/synthetic-monitor.spec.ts against the
  deployed staging origin every N minutes, logs pass/fail + timing per flow to a
  rotating file, and prints a LOUD ALERT line on any failure so the PO can watch
  the console overnight.

.DESCRIPTION
  The four critical flows live in e2e/synthetic-monitor.spec.ts:
    (a) owner login + credential renders
    (b) anon /p credential: 200 + no PII + no-store
    (c) govt maltrato rows + panorama canvas paints
    (d) anon denuncia wizard reaches the reference-code screen

  The staging origin is resolved by the spec itself (e2e/_base-url.ts):
  STAGING_URL env wins, else the staging_url file, else localhost:3000. This
  wrapper simply forwards -StagingUrl into that env var when provided.

.PARAMETER IntervalMinutes
  Minutes to wait between runs. Default 30.

.PARAMETER StagingUrl
  Staging origin to hit (e.g. https://dim-staging-xxxx.vercel.app). If omitted,
  the spec falls back to the staging_url file / localhost. The URL changes per
  deploy — pass the current one.

.PARAMETER Once
  Run a single cycle and exit (for cron / one-shot checks).

.PARAMETER LogDir
  Directory for rotating logs. Default: tmp/qa-monitor-logs (gitignored).

.EXAMPLE
  pwsh scripts/qa-monitor.ps1 -StagingUrl https://dim-staging-abc123.vercel.app

.EXAMPLE
  pwsh scripts/qa-monitor.ps1 -IntervalMinutes 15 -StagingUrl https://dim-staging-abc123.vercel.app
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 30,
  [string]$StagingUrl = "",
  [switch]$Once,
  [string]$LogDir = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($LogDir)) {
  $LogDir = Join-Path $repoRoot "tmp/qa-monitor-logs"
}
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# One rotating log per calendar day; keeps the tail readable overnight.
$logFile = Join-Path $LogDir ("qa-monitor-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

function Write-Log {
  param([string]$Line)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $out = "[$stamp] $Line"
  Add-Content -Path $logFile -Value $out
  Write-Host $out
}

function Write-Alert {
  param([string]$Line)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $out = "[$stamp] !!! ALERT !!! $Line"
  Add-Content -Path $logFile -Value $out
  # Loud on the console — red banner so an overnight watcher can't miss it.
  Write-Host ""
  Write-Host "==================================================================" -ForegroundColor Red
  Write-Host $out -ForegroundColor Red
  Write-Host "==================================================================" -ForegroundColor Red
  Write-Host ""
}

function Invoke-MonitorCycle {
  $started = Get-Date
  if (-not [string]::IsNullOrWhiteSpace($StagingUrl)) {
    $env:STAGING_URL = $StagingUrl
  }
  $target = if ($env:STAGING_URL) { $env:STAGING_URL } else { "(staging_url file / localhost)" }
  Write-Log "RUN start  target=$target"

  # JSON reporter → per-test pass/fail + duration without parsing console noise.
  $jsonPath = Join-Path $env:TEMP ("qa-monitor-run-{0}.json" -f ([guid]::NewGuid().ToString("N")))
  $env:PLAYWRIGHT_JSON_OUTPUT_NAME = $jsonPath

  Push-Location $repoRoot
  try {
    # workers=2 max — the staging DB is free-tier; be gentle.
    & pnpm exec playwright test e2e/synthetic-monitor.spec.ts `
        --config=playwright.local3000.config.ts `
        --workers=2 --reporter=json *> $null
    $exit = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)

  # Parse the JSON reporter output for per-flow timing.
  $passed = 0; $failed = 0; $failedNames = @()
  if (Test-Path $jsonPath) {
    try {
      $report = Get-Content $jsonPath -Raw | ConvertFrom-Json
      foreach ($suite in $report.suites) {
        foreach ($spec in ($suite.suites.specs + $suite.specs)) {
          if ($null -eq $spec) { continue }
          $ok = $true
          $dur = 0
          foreach ($t in $spec.tests) {
            foreach ($r in $t.results) {
              $dur += [int]$r.duration
              if ($r.status -ne "passed" -and $r.status -ne "skipped") { $ok = $false }
            }
          }
          $secs = [math]::Round($dur / 1000, 1)
          if ($ok) {
            $passed++
            Write-Log ("  PASS  {0}  ({1}s)" -f $spec.title, $secs)
          } else {
            $failed++
            $failedNames += $spec.title
            Write-Log ("  FAIL  {0}  ({1}s)" -f $spec.title, $secs)
          }
        }
      }
    } catch {
      Write-Log "  (could not parse JSON report: $($_.Exception.Message))"
    }
    Remove-Item $jsonPath -Force -ErrorAction SilentlyContinue
  }

  if ($exit -ne 0 -or $failed -gt 0) {
    $names = if ($failedNames.Count -gt 0) { $failedNames -join "; " } else { "run exited $exit (harness/deploy error)" }
    Write-Alert "Synthetic monitor FAILED ($failed flow(s)) after ${elapsed}s -> $names"
  } else {
    Write-Log "RUN ok     $passed flow(s) passed in ${elapsed}s"
  }
}

Write-Log "qa-monitor starting (interval=${IntervalMinutes}m, once=$($Once.IsPresent), log=$logFile)"

do {
  try {
    Invoke-MonitorCycle
  } catch {
    Write-Alert "monitor cycle threw: $($_.Exception.Message)"
  }

  if ($Once) { break }

  # Rotate the log filename at day boundaries.
  $logFile = Join-Path $LogDir ("qa-monitor-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
  Write-Log "sleeping ${IntervalMinutes}m until next cycle..."
  Start-Sleep -Seconds ($IntervalMinutes * 60)
} while ($true)
