# Coach Studio CLI for Windows: lets an AI assistant that has a terminal (Claude
# Code, Codex, ...) read and manage Talent Transformation's AI coach (Erica)
# through Coach Studio, after the person signs in once with a link.
# Windows PowerShell only: nothing to install first.
#
#   coach-studio.ps1 login [--no-wait] [--wait SECONDS] [--check] [--new]
#   coach-studio.ps1 status | tools | call TOOL [JSON | --stdin | --args-file FILE] | logout
#
# Sign-in is the OAuth device flow (RFC 8628): `login` prints a link and a short
# code; the person opens the link in the browser where they are signed in to
# Coach Studio, checks the code and allows; this script then holds a token for
# that person (their Studio role caps what it can do) in
# ~\.coach-studio\credentials.json. The macOS / Linux twin is coach-studio.sh.
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$VERSION = '1.0.0'
$DEFAULT_SERVER = '__ORIGIN__'   # filled in when the Studio serves this file
$UNSET = '__' + 'ORIGIN' + '__'
$CLIENT_ID = 'coach-studio-cli'
$DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
$DIR = if ($env:COACH_STUDIO_HOME) { $env:COACH_STUDIO_HOME } else { Join-Path $HOME '.coach-studio' }
$CRED_FILE = Join-Path $DIR 'credentials.json'
$PENDING_FILE = Join-Path $DIR 'pending.json'
$CONFIG_FILE = Join-Path $DIR 'config.json'

$argv = @($args)
$cmd = if ($argv.Count -gt 0) { [string]$argv[0] } else { 'help' }

function Say([string]$text) { [Console]::Out.WriteLine($text) }
function Fail([string]$message, [int]$code = 1) { [Console]::Error.WriteLine($message); exit $code }
function Has([string]$name) { return ($argv -contains $name) }
function Value([string]$name) {
    $i = [Array]::IndexOf($argv, $name)
    if ($i -ge 0 -and ($i + 1) -lt $argv.Count) { return [string]$argv[$i + 1] }
    return $null
}
function NowS { return [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function ReadJson([string]$file) {
    if (-not (Test-Path $file)) { return $null }
    try { return (Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json) } catch { return $null }
}
function WriteJson([string]$file, $obj) {
    New-Item -ItemType Directory -Force $DIR | Out-Null
    [IO.File]::WriteAllText($file, ($obj | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
}
function Remove([string]$file) { if (Test-Path $file) { Remove-Item -Force $file -ErrorAction SilentlyContinue } }
function ParseJson([string]$text) { try { return ($text | ConvertFrom-Json) } catch { return $null } }

function ServerUrl {
    $s = Value '--server'
    if (-not $s) { $s = $env:COACH_STUDIO_URL }
    if (-not $s) { $c = ReadJson $CONFIG_FILE; if ($c -and $c.server) { $s = [string]$c.server } }
    if (-not $s -and $DEFAULT_SERVER -ne $UNSET) { $s = $DEFAULT_SERVER }
    if (-not $s) { Fail 'No server address. Run the installer again, or pass --server https://...' }
    return $s.TrimEnd('/')
}

# One HTTP call: { Status; Text; Headers }. A 4xx/5xx is a result, not an exception.
function Send-Http([string]$Method, [string]$Url, [string]$Body, [string]$ContentType, [string]$Token) {
    $h = @{}
    if ($Token) { $h['Authorization'] = 'Bearer ' + $Token }
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Method $Method -Uri $Url -Headers $h -ContentType $ContentType -Body ([Text.Encoding]::UTF8.GetBytes($Body)) -TimeoutSec 30
        return @{ Status = [int]$r.StatusCode; Text = [string]$r.Content; Headers = $r.Headers }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { Fail ('Could not reach ' + ([Uri]$Url).Host + ': ' + $_.Exception.Message) }
        $text = ''
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = [string]$_.ErrorDetails.Message }
        else { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $text = $sr.ReadToEnd() } catch { } }
        return @{ Status = [int]$resp.StatusCode; Text = $text; Headers = $resp.Headers }
    }
}
function Post-Form([string]$Url, [hashtable]$Fields) {
    $pairs = @()
    foreach ($k in $Fields.Keys) { $pairs += ([Uri]::EscapeDataString($k) + '=' + [Uri]::EscapeDataString([string]$Fields[$k])) }
    $r = Send-Http 'POST' $Url ($pairs -join '&') 'application/x-www-form-urlencoded' $null
    $r.Json = ParseJson $r.Text
    return $r
}

# ---- sign-in -----------------------------------------------------------------

function Save-Credentials([string]$server, $t) {
    $exp = if ($t.expires_in) { [int]$t.expires_in } else { 3600 }
    WriteJson $CRED_FILE ([ordered]@{ server = $server; access_token = [string]$t.access_token; refresh_token = [string]$t.refresh_token; access_exp = ((NowS) + $exp); scope = [string]$t.scope; saved_at = (NowS) })
}

function Start-Login {
    $server = ServerUrl
    $name = Value '--device-name'
    if (-not $name) { $name = $env:COMPUTERNAME }
    $r = Post-Form ($server + '/oauth/device_authorization') @{ client_id = $CLIENT_ID; device_name = [string]$name }
    $j = $r.Json
    if ($r.Status -ne 200 -or -not $j -or -not $j.device_code) {
        $why = if ($j -and $j.error_description) { $j.error_description } elseif ($j -and $j.error) { $j.error } else { 'HTTP ' + $r.Status }
        Fail ('Could not start the sign-in: ' + $why)
    }
    $interval = if ($j.interval) { [int]$j.interval } else { 5 }
    $expiresIn = if ($j.expires_in) { [int]$j.expires_in } else { 600 }
    WriteJson $PENDING_FILE ([ordered]@{ server = $server; device_code = [string]$j.device_code; user_code = [string]$j.user_code; link = [string]$j.verification_uri_complete; interval = $interval; expires_at = ((NowS) + $expiresIn); last_poll = 0 })
    Say 'Open this link in the browser where you are signed in to Coach Studio:'
    Say ''
    Say ('  ' + $j.verification_uri_complete)
    Say ''
    Say ('The page must show the code ' + $j.user_code + '. Check it matches, choose the permissions, and click Allow.')
    Say ('The link works for ' + [Math]::Round($expiresIn / 60) + ' minutes.')
}

# One check of the device code: connected | waiting | denied | expired.
function Poll-Once($p) {
    $wait = ([int]$p.last_poll + [int]$p.interval + 1) - (NowS)
    if ($wait -gt 0) { Start-Sleep -Seconds $wait }
    $r = Post-Form ($p.server + '/oauth/token') @{ grant_type = $DEVICE_GRANT; device_code = [string]$p.device_code; client_id = $CLIENT_ID }
    $p.last_poll = (NowS)
    if ($r.Status -eq 200 -and $r.Json -and $r.Json.access_token) {
        Save-Credentials $p.server $r.Json
        Remove $PENDING_FILE
        return @{ State = 'connected'; Scope = [string]$r.Json.scope }
    }
    $err = if ($r.Json) { [string]$r.Json.error } else { '' }
    if ($err -eq 'slow_down') { $p.interval = [int]$p.interval + 5 }
    if ($err -eq 'authorization_pending' -or $err -eq 'slow_down') { WriteJson $PENDING_FILE $p; return @{ State = 'waiting' } }
    Remove $PENDING_FILE
    if ($err -eq 'access_denied') { return @{ State = 'denied' } }
    return @{ State = 'expired' }
}

function Report($res) {
    switch ($res.State) {
        'connected' { Say 'STATUS: connected'; $s = if ($res.Scope) { $res.Scope } else { 'read:ops' }; Say ('Permissions: ' + $s); return 0 }
        'denied' { Say 'STATUS: denied'; Say 'The person denied it. Nothing was connected.'; return 1 }
        'expired' { Say 'STATUS: expired'; Say 'The code expired or was already used. Run `login` again.'; return 1 }
        default { Say 'STATUS: waiting'; Say 'Not allowed yet. Keep waiting with `login --wait 120`, or `login --check` for one check.'; return 2 }
    }
}

function Cmd-Login {
    if (Has '--check') {
        $p = ReadJson $PENDING_FILE
        if (-not $p) { Say 'STATUS: expired'; Say 'No sign-in is waiting. Run `login`.'; return 1 }
        if ([int]$p.expires_at -lt (NowS)) { Remove $PENDING_FILE; return (Report @{ State = 'expired' }) }
        return (Report (Poll-Once $p))
    }
    $explicitWait = Value '--wait'
    if ((Has '--wait') -and -not $explicitWait) { Fail '--wait needs a number of seconds' }
    $p = ReadJson $PENDING_FILE
    $resuming = [bool]($explicitWait -and -not (Has '--new') -and $p -and ([int]$p.expires_at -gt (NowS)))
    if (-not $resuming) { Start-Login; $p = ReadJson $PENDING_FILE }
    if (Has '--no-wait') { Say 'STATUS: waiting'; Say 'Then run `login --wait 120` (or `login --check`).'; return 2 }
    $seconds = if ($explicitWait) { [int]$explicitWait } else { 120 }
    $deadline = [Math]::Min((NowS) + $seconds, [int]$p.expires_at)
    while ($true) {
        $res = Poll-Once $p
        if ($res.State -ne 'waiting') { return (Report $res) }
        if (((NowS) + [int]$p.interval) -gt $deadline) { return (Report $res) }
    }
}

# ---- calling Coach Studio ----------------------------------------------------

function Refresh-Credentials($c) {
    $r = Post-Form ($c.server + '/oauth/token') @{ grant_type = 'refresh_token'; refresh_token = [string]$c.refresh_token; client_id = $CLIENT_ID }
    if ($r.Status -ne 200 -or -not $r.Json -or -not $r.Json.access_token) { return $null }
    Save-Credentials $c.server $r.Json
    return (ReadJson $CRED_FILE)
}
function Signed-Out { Fail ('STATUS: signed out' + [Environment]::NewLine + 'The sign-in expired or was revoked. Run `login` again.') }
function Get-Credentials {
    $c = ReadJson $CRED_FILE
    if (-not $c) { Fail ('STATUS: not connected' + [Environment]::NewLine + 'Run `login` first.') }
    if ([int]$c.access_exp - 60 -lt (NowS)) {
        $c = Refresh-Credentials $c
        if (-not $c) { Signed-Out }
    }
    return $c
}

$script:rpcId = 0
# Raw request body in, parsed JSON-RPC result out.
function Invoke-Mcp([string]$method, [string]$paramsJson) {
    $c = Get-Credentials
    $script:rpcId++
    $payload = '{"jsonrpc":"2.0","id":' + $script:rpcId + ',"method":"' + $method + '","params":' + $paramsJson + '}'
    $r = Send-Http 'POST' ($c.server + '/mcp') $payload 'application/json' ([string]$c.access_token)
    if ($r.Status -eq 401) {
        $c = Refresh-Credentials $c
        if (-not $c) { Signed-Out }
        $r = Send-Http 'POST' ($c.server + '/mcp') $payload 'application/json' ([string]$c.access_token)
    }
    if ($r.Status -eq 429) { $ra = $r.Headers['Retry-After']; if (-not $ra) { $ra = 30 }; Fail ('Too many calls: wait ' + $ra + ' seconds and try again.') }
    if ($r.Status -eq 400) { Fail 'The arguments are not valid JSON. In PowerShell, quotes inside a command-line argument get lost: use --args-file FILE, or pipe the JSON in with --stdin.' }
    $j = ParseJson $r.Text
    if ($r.Status -ne 200 -or -not $j) { Fail ('Coach Studio answered HTTP ' + $r.Status) }
    if ($j.error) { Fail ('Coach Studio: ' + $j.error.message) }
    return $j.result
}

function Cmd-Status {
    $c = Get-Credentials
    $res = Invoke-Mcp 'tools/list' '{}'
    $scope = if ($c.scope) { [string]$c.scope } else { 'read:ops' }
    Say 'STATUS: connected'
    Say ('Server: ' + ([Uri]$c.server).Host)
    Say ('Permissions: ' + $scope)
    Say ('Tools available: ' + @($res.tools).Count)
    return 0
}

function Cmd-Tools {
    $res = Invoke-Mcp 'tools/list' '{}'
    foreach ($t in @($res.tools)) {
        $kind = if ($t.annotations -and $t.annotations.readOnlyHint) { 'read' } else { 'WRITE' }
        $desc = ([string]$t.description -split '(?<=\.)\s')[0]
        if ($desc.Length -gt 160) { $desc = $desc.Substring(0, 160) }
        Say ($t.name + '  [' + $kind + ']  ' + $desc)
    }
    return 0
}

function Cmd-Call {
    $name = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    if (-not $name -or $name.StartsWith('--')) { Fail 'Usage: call TOOL [JSON | --stdin | --args-file FILE]' }
    if ($name -notmatch '^[A-Za-z0-9_.-]+$') { Fail 'That is not a tool name. Run `tools` to see them.' }
    $raw = '{}'
    $file = Value '--args-file'
    $third = if ($argv.Count -gt 2) { [string]$argv[2] } else { '' }
    if ($file) { $raw = [IO.File]::ReadAllText($file) }
    elseif ($third -eq '--stdin') { $raw = [Console]::In.ReadToEnd() }
    elseif ($third -and -not $third.StartsWith('--')) { $raw = $third }
    $raw = $raw.Trim()
    if (-not $raw) { $raw = '{}' }
    $parsed = ParseJson $raw
    if ($null -eq $parsed -or $raw[0] -ne '{') { Fail 'The arguments are not valid JSON. In PowerShell, quotes inside a command-line argument get lost: use --args-file FILE, or pipe the JSON in with --stdin.' }
    $result = Invoke-Mcp 'tools/call' ('{"name":"' + $name + '","arguments":' + $raw + '}')
    $text = (@($result.content) | ForEach-Object { $_.text }) -join [Environment]::NewLine
    Say $text
    if ($result.isError) { return 1 }
    return 0
}

function Cmd-Logout {
    $c = ReadJson $CRED_FILE
    if ($c) { try { Send-Http 'POST' ($c.server + '/oauth/revoke') ('token=' + [Uri]::EscapeDataString([string]$c.refresh_token)) 'application/x-www-form-urlencoded' $null | Out-Null } catch { } }
    Remove $CRED_FILE; Remove $PENDING_FILE
    Say 'STATUS: signed out'
    return 0
}

function Cmd-Help {
    Say ('coach-studio ' + $VERSION + ': read and manage Erica through Coach Studio.')
    Say ''
    Say '  login [--no-wait] [--wait SECONDS] [--check]   sign in: prints a link and a code for the person to allow'
    Say '  status                                          is it connected, with which permissions'
    Say '  tools                                           the tools available ([read] or [WRITE])'
    Say '  call TOOL [JSON | --stdin | --args-file FILE]   run one tool; JSON from a file, or piped in with --stdin'
    Say '  logout                                          revoke this sign-in and forget it'
    Say ''
    Say 'Lines starting with "STATUS:" say where things stand: connected, waiting, denied, expired, signed out, not connected.'
    return 0
}

$code = 0
switch ($cmd) {
    'login' { $code = Cmd-Login }
    'status' { $code = Cmd-Status }
    'tools' { $code = Cmd-Tools }
    'call' { $code = Cmd-Call }
    'logout' { $code = Cmd-Logout }
    { $_ -in @('help', '--help', '-h') } { $code = Cmd-Help }
    '--version' { Say $VERSION; $code = 0 }
    default { Fail ('Unknown command: ' + $cmd + '. Run `help`.') }
}
exit ([int](@($code)[-1]))
