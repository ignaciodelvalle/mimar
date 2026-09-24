# QA environment bootstrap for the local integration build.
# Checks Supabase containers, build freshness, starts the production server,
# smoke-tests key routes, and verifies seed accounts exist.
# Usage: pwsh scripts/qa-up.ps1 [-Port 3000]
#        powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/qa-up.ps1
#
# BOTH invocations must work. PowerShell 7 (`pwsh`) is not installed on every
# machine that runs this — on 2026-08-09 the documented `pwsh` form died with
# exit 127 on the PO's box and the fallback to Windows PowerShell 5.1 then
# failed the smoke below on a perfectly healthy app. Keep this script
# 5.1-compatible; do not reach for pwsh-only syntax.
param([int]$Port = 3000)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host "== DIM QA up =="

# 1. Supabase containers
$db = docker ps --filter "name=supabase_db_DIM" --format "{{.Status}}"
if (-not $db) {
    Write-Host "Supabase is not running - starting (pnpm db:start)..."
    cmd /c "pnpm db:start"
    if ($LASTEXITCODE -ne 0) { Write-Error "supabase start failed" }
} else {
    Write-Host "Supabase: $db"
}

# 2. Build freshness (warn only - QA may intentionally target an older build)
$buildIdPath = Join-Path $repo ".next/BUILD_ID"
if (-not (Test-Path $buildIdPath)) {
    Write-Error "No production build found (.next/BUILD_ID missing). Run: pnpm build"
}
$buildTime = (Get-Item $buildIdPath).LastWriteTimeUtc
$headEpoch = [long](git log -1 --format=%ct)
$headTime = [DateTimeOffset]::FromUnixTimeSeconds($headEpoch).UtcDateTime
$headSha = git log -1 --format=%h
if ($headTime -gt $buildTime) {
    Write-Warning "Build is OLDER than HEAD ($headSha). QA may not reflect the latest commits. Run: pnpm build"
} else {
    Write-Host "Build is fresh relative to HEAD ($headSha)."
}

# 3. Server
# Stale-server guard (incident 2026-07-23, twice): a server started BEFORE the
# last rebuild keeps serving its old in-memory BUILD_ID while .next on disk has
# a new one — every page then 400s on the dead chunk hashes. "Something listens
# on :3000" is NOT enough; the served build must MATCH the disk build. We probe
# a page and look for the on-disk BUILD_ID in its /_next/static asset URLs; on
# mismatch the stale server is killed and a fresh one started.
$diskBuildId = (Get-Content $buildIdPath -Raw).Trim()

# Does whatever is on the port serve the build that is ON DISK RIGHT NOW?
# App-router HTML does not embed the buildId in its asset URLs, so grepping a
# page proves nothing — ask for THIS build's manifest instead. Only a server
# booted on the on-disk build can return it; a stale one 400s, which is exactly
# the dead-chunk symptom this guard exists to catch.
function Test-ServesDiskBuild {
    param([int]$Port, [string]$BuildId)
    try {
        $probe = Invoke-WebRequest -Uri "http://localhost:$Port/_next/static/$BuildId/_buildManifest.js" -UseBasicParsing -TimeoutSec 10
        return $probe.StatusCode -eq 200
    } catch {
        return $false
    }
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    if (Test-ServesDiskBuild -Port $Port -BuildId $diskBuildId) {
        Write-Host "Port $Port already listening and serving the on-disk build ($diskBuildId) - reusing."
    } else {
        Write-Warning "Server on port $Port serves a DIFFERENT build than .next on disk - restarting it."
        $stalePids = $listening | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($stalePid in $stalePids) {
            Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 3

        # THE KILL IS NOT ASSUMED TO HAVE WORKED (incident 2026-07-29). It used
        # to be fired with -ErrorAction SilentlyContinue and the script moved on
        # as if the port were free. When the stale process belongs to another
        # security context, Stop-Process fails with "Access is denied", the new
        # server cannot bind the port and dies, and the ZOMBIE keeps answering.
        # The smoke test below then passes -- a stale server still returns 200
        # for server-rendered HTML; only its chunks 400 -- and the script printed
        # "QA environment ready" over an app whose every page was unusable. Hours
        # were spent measuring a page that had loaded with no CSS at all.
        #
        # A guard that cannot fail loudly is worse than no guard: it sells
        # confidence it has not earned.
        $stillThere = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($stillThere) {
            $blockingPid = ($stillThere | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
            Write-Error @"
Could not free port $Port - PID $blockingPid is still listening after Stop-Process.

This usually means the process runs in a different security context (a
different user, or elevated). Nothing downstream can be trusted while it is
up: it will keep serving a dead build, HTML routes will still answer 200, and
every page will fail on 400'd chunks.

Fix it one of these ways, then re-run:
  * Close whatever owns it (an IDE task, another terminal, a service).
  * Kill it from an ELEVATED shell:  taskkill /PID $blockingPid /T /F
  * Or aim QA at a free port:        pwsh scripts/qa-up.ps1 -Port 3001
"@
            exit 1
        }
        $listening = $null
    }
}
if ($listening) {
    # fresh server confirmed above - nothing to do
} else {
    Write-Host "Starting production server on port $Port..."
    $env:PORT = $Port
    Start-Process -FilePath "cmd" -ArgumentList "/c", "pnpm", "start" -WorkingDirectory $repo -WindowStyle Hidden
}

# 4a. THE AUTHORITATIVE CHECK: the server now answering must serve the build on
# disk. This runs AFTER the start, not only before it -- the old script probed
# the build once, decided to restart, and never re-verified the outcome, so a
# restart that silently failed still reported success.
#
# It also has to come before the route smoke test, because the route check
# CANNOT catch this: a stale server server-renders HTML fine and returns 200 for
# every route below. Only its /_next chunks 400. Status codes on HTML routes are
# not evidence that the app works.
$buildOk = $false
for ($i = 0; $i -lt 45; $i++) {
    if (Test-ServesDiskBuild -Port $Port -BuildId $diskBuildId) { $buildOk = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $buildOk) {
    Write-Error @"
Server on port $Port is NOT serving the on-disk build ($diskBuildId).

Pages will load their HTML and then fail: chunks 400 with MIME text/html, the
app never hydrates, and stylesheets never apply -- so anything measured against
it is measuring an unstyled, dead page.

Check for a leftover process on the port, then re-run:
  Get-NetTCPConnection -LocalPort $Port -State Listen
"@
    exit 1
}
Write-Host "Serving the on-disk build ($diskBuildId) - verified after start."

# 4b. Smoke-test key routes
#
# A STATUS CODE IS A RESPONSE. This loop used to treat any thrown request as
# "no answer" and retry 30 times, which made it fail on a healthy app: /login
# is a 308 to /iniciar-sesion, and Windows PowerShell 5.1 does NOT auto-follow
# 308 (its HttpWebRequest only follows 301/302/303/307) — it throws, the catch
# swallowed the throw, and the smoke reported the server as dead. pwsh 7
# follows it and passes, so the failure only appeared on machines without
# PowerShell 7, which is exactly where the fallback invocation is needed.
#
# A gate that cries wolf is worse than no gate: it trains everyone to ignore
# the one time it is right. So redirects are now followed manually and only a
# CONNECTION failure (no status at all) or a 4xx/5xx counts as a failure.
$routes = @("/", "/login", "/perdidas")
foreach ($route in $routes) {
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        $status = $null
        try {
            # -MaximumRedirection 0 so both shells behave the same: we grade the
            # redirect itself rather than depending on either one's auto-follow.
            $resp = Invoke-WebRequest -Uri "http://localhost:$Port$route" -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0 -ErrorAction Stop
            $status = [int]$resp.StatusCode
        } catch {
            # 5.1 throws on every non-2xx; the status still rides on the response.
            if ($_.Exception.PSObject.Properties.Name -contains "Response" -and $_.Exception.Response) {
                $status = [int]$_.Exception.Response.StatusCode
            }
        }
        if ($null -ne $status -and $status -lt 400) {
            Write-Host ("smoke {0} -> {1}" -f $route, $status)
            $ok = $true
            break
        }
        if ($null -ne $status) {
            Write-Error ("smoke FAILED: {0} answered {1} on port {2}" -f $route, $status, $Port)
            $ok = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $ok) { Write-Error "smoke FAILED: $route never responded on port $Port" }
}

# 5. Seed accounts present?
# NOTE: refugio@dim.test is an organization CONTACT email (organizations table),
# not an auth account — the shelter-admin login accounts are orgadmin@dim.test
# (seed-test-users) and alejo@dim.test (seed-demo).
$expected = @(
    "admin@dim.test", "govt@dim.test", "vet@dim.test", "owner@dim.test",
    "orgadmin@dim.test", "alejo@dim.test", "carla@dim.test", "lilian@dim.test"
)
$emailsCsv = "'" + ($expected -join "','") + "'"
$found = docker exec supabase_db_DIM psql -U postgres -d postgres -t -A -c "select email from auth.users where email in ($emailsCsv)" |
    ForEach-Object { $_.Trim() } | Where-Object { $_ }
$missing = $expected | Where-Object { $found -notcontains $_ }
if ($missing) {
    Write-Warning ("Missing seed accounts: {0}. Run: pnpm tsx scripts/seed-demo-spine.ts" -f ($missing -join ", "))
} else {
    Write-Host "All expected seed accounts present."
}

Write-Host "QA environment ready: http://localhost:$Port"
