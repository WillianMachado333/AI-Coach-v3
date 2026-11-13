# Installs the Coach Studio CLI and its Skill (Windows PowerShell):
#   irm __ORIGIN__/cli/install.ps1 | iex
# It downloads two files from this Studio into ~\.coach-studio and, if Claude
# Code's folder exists, copies the Skill into ~\.claude\skills\coach-studio.
# Nothing to install first: it is PowerShell, which comes with Windows.
# It changes nothing else and does not touch PATH.
$ErrorActionPreference = 'Stop'
$origin = '__ORIGIN__'
$dir = if ($env:COACH_STUDIO_HOME) { $env:COACH_STUDIO_HOME } else { Join-Path $HOME '.coach-studio' }

New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest "$origin/cli/coach-studio.ps1" -OutFile (Join-Path $dir 'coach-studio.ps1') -UseBasicParsing
Invoke-WebRequest "$origin/cli/SKILL.md" -OutFile (Join-Path $dir 'SKILL.md') -UseBasicParsing
$config = '{"server":"' + $origin + '"}'
[IO.File]::WriteAllText((Join-Path $dir 'config.json'), $config, (New-Object Text.UTF8Encoding($false)))

$skillNote = "Read the Skill at $(Join-Path $dir 'SKILL.md')"
$claude = Join-Path $HOME '.claude'
if (Test-Path $claude) {
    $skillDir = Join-Path $claude 'skills\coach-studio'
    New-Item -ItemType Directory -Force $skillDir | Out-Null
    Copy-Item (Join-Path $dir 'SKILL.md') (Join-Path $skillDir 'SKILL.md') -Force
    $skillNote = "Skill installed for Claude Code: $(Join-Path $skillDir 'SKILL.md')"
}

$cli = Join-Path $dir 'coach-studio.ps1'
Write-Host "Coach Studio CLI installed in $dir (server $origin)."
Write-Host $skillNote
Write-Host "Check it: powershell -NoProfile -ExecutionPolicy Bypass -File `"$cli`" status"
Write-Host "Sign in:  powershell -NoProfile -ExecutionPolicy Bypass -File `"$cli`" login --no-wait"
