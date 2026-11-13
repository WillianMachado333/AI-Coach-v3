#!/usr/bin/env bash
# Coach Studio CLI for macOS and Linux: lets an AI assistant that has a
# terminal (Claude Code, Codex, ...) read and manage Talent Transformation's AI
# coach (Erica) through Coach Studio, after the person signs in once with a
# link. bash and curl only: nothing to install first. (Windows twin:
# coach-studio.ps1.)
#
#   coach-studio.sh login [--no-wait] [--wait SECONDS] [--check] [--new]
#   coach-studio.sh status | tools | call TOOL [JSON | --stdin | --args-file FILE] | logout
#
# Sign-in is the OAuth device flow (RFC 8628): `login` prints a link and a short
# code; the person opens the link in the browser where they are signed in to
# Coach Studio, checks the code and allows; this script then holds a token for
# that person (their Studio role caps what it can do) in ~/.coach-studio.
set -u

VERSION="1.0.0"
DEFAULT_SERVER="__ORIGIN__"   # filled in when the Studio serves this file
UNSET="__""ORIGIN""__"
CLIENT_ID="coach-studio-cli"
GRANT="urn:ietf:params:oauth:grant-type:device_code"
DIR="${COACH_STUDIO_HOME:-$HOME/.coach-studio}"
CRED="$DIR/credentials"
PENDING="$DIR/pending"
CONFIG="$DIR/config"

ARGS=("$@")
CMD="${1:-help}"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
now() { date +%s; }

command -v curl >/dev/null 2>&1 || die "curl is needed and was not found."

has() { local a; for a in "${ARGS[@]}"; do [ "$a" = "$1" ] && return 0; done; return 1; }
value() { local i; for ((i = 0; i < ${#ARGS[@]}; i++)); do if [ "${ARGS[$i]}" = "$1" ]; then printf '%s' "${ARGS[$((i + 1))]-}"; return; fi; done; }
arg() { printf '%s' "${ARGS[$1]-}"; }

# key=value files, one per line, mode 600.
kv_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -n 1; }
kv_write() { local f="$1"; shift; mkdir -p "$DIR"; ( umask 077; : > "$f.tmp"; for kv in "$@"; do printf '%s\n' "$kv" >> "$f.tmp"; done ); mv "$f.tmp" "$f"; }
# Flat string / number out of the Studio's compact JSON answers.
json_str() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -n 1; }
json_num() { printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p" | head -n 1; }

server_url() {
  local s; s="$(value --server)"
  [ -n "$s" ] || s="${COACH_STUDIO_URL:-}"
  [ -n "$s" ] || s="$(kv_get "$CONFIG" server)"
  if [ -z "$s" ] && [ "$DEFAULT_SERVER" != "$UNSET" ]; then s="$DEFAULT_SERVER"; fi
  [ -n "$s" ] || die "No server address. Run the installer again, or pass --server https://..."
  printf '%s' "${s%/}"
}

# HTTP_CODE and BODY are set by every call. A 4xx/5xx is a result, not a failure.
http() { # method url token content-type data...
  local method="$1" url="$2" token="$3" ctype="$4"; shift 4
  local opts=(-sS -m 30 -X "$method" -w $'\n%{http_code}')
  [ -n "$token" ] && opts+=(-H "Authorization: Bearer $token")
  [ -n "$ctype" ] && opts+=(-H "Content-Type: $ctype")
  local out
  out="$(curl "${opts[@]}" "$@" "$url" 2>&1)" || die "Could not reach ${url#*//}: ${out%%$'\n'*}"
  HTTP_CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
post_form() { # url key=value...
  local url="$1"; shift
  local data=(); local kv
  for kv in "$@"; do data+=(--data-urlencode "$kv"); done
  http POST "$url" "" "application/x-www-form-urlencoded" "${data[@]}"
}

# ---- sign-in -----------------------------------------------------------------

save_credentials() { # server body
  local exp; exp="$(json_num "$2" expires_in)"
  kv_write "$CRED" "server=$1" "access_token=$(json_str "$2" access_token)" "refresh_token=$(json_str "$2" refresh_token)" \
    "access_exp=$(( $(now) + ${exp:-3600} ))" "scope=$(json_str "$2" scope)"
}

start_login() {
  local server name device_code user_code link interval expires
  server="$(server_url)"
  name="$(value --device-name)"; [ -n "$name" ] || name="$(hostname 2>/dev/null || echo unknown)"
  post_form "$server/oauth/device_authorization" "client_id=$CLIENT_ID" "device_name=$name"
  device_code="$(json_str "$BODY" device_code)"
  if [ "$HTTP_CODE" != 200 ] || [ -z "$device_code" ]; then
    die "Could not start the sign-in: $(json_str "$BODY" error_description)${HTTP_CODE:+ (HTTP $HTTP_CODE)}"
  fi
  user_code="$(json_str "$BODY" user_code)"; link="$(json_str "$BODY" verification_uri_complete)"
  interval="$(json_num "$BODY" interval)"; expires="$(json_num "$BODY" expires_in)"
  kv_write "$PENDING" "server=$server" "device_code=$device_code" "user_code=$user_code" "link=$link" \
    "interval=${interval:-5}" "expires_at=$(( $(now) + ${expires:-600} ))" "last_poll=0"
  say "Open this link in the browser where you are signed in to Coach Studio:"
  say ""
  say "  $link"
  say ""
  say "The page must show the code $user_code. Check it matches, choose the permissions, and click Allow."
  say "The link works for $(( ${expires:-600} / 60 )) minutes."
}

# One check of the device code: STATE = connected | waiting | denied | expired.
poll_once() {
  local server device_code interval last_poll wait err
  server="$(kv_get "$PENDING" server)"; device_code="$(kv_get "$PENDING" device_code)"
  interval="$(kv_get "$PENDING" interval)"; last_poll="$(kv_get "$PENDING" last_poll)"
  wait=$(( last_poll + interval + 1 - $(now) ))
  [ "$wait" -gt 0 ] && sleep "$wait"
  post_form "$server/oauth/token" "grant_type=$GRANT" "device_code=$device_code" "client_id=$CLIENT_ID"
  if [ "$HTTP_CODE" = 200 ] && [ -n "$(json_str "$BODY" access_token)" ]; then
    save_credentials "$server" "$BODY"; rm -f "$PENDING"; STATE=connected; SCOPE="$(json_str "$BODY" scope)"; return
  fi
  err="$(json_str "$BODY" error)"
  case "$err" in
    slow_down|authorization_pending)
      [ "$err" = slow_down ] && interval=$(( interval + 5 ))
      kv_write "$PENDING" "server=$server" "device_code=$device_code" "user_code=$(kv_get "$PENDING" user_code)" "link=$(kv_get "$PENDING" link)" \
        "interval=$interval" "expires_at=$(kv_get "$PENDING" expires_at)" "last_poll=$(now)"
      STATE=waiting ;;
    access_denied) rm -f "$PENDING"; STATE=denied ;;
    *) rm -f "$PENDING"; STATE=expired ;;
  esac
}

report() { # uses STATE and SCOPE; returns the exit code
  case "$STATE" in
    connected) say "STATUS: connected"; say "Permissions: ${SCOPE:-read:ops}"; return 0 ;;
    denied) say "STATUS: denied"; say "The person denied it. Nothing was connected."; return 1 ;;
    expired) say "STATUS: expired"; say 'The code expired or was already used. Run `login` again.'; return 1 ;;
    *) say "STATUS: waiting"; say 'Not allowed yet. Keep waiting with `login --wait 120`, or `login --check` for one check.'; return 2 ;;
  esac
}

cmd_login() {
  local explicit_wait resuming=0 deadline expires interval
  if has --check; then
    if [ ! -f "$PENDING" ]; then say "STATUS: expired"; say 'No sign-in is waiting. Run `login`.'; return 1; fi
    if [ "$(kv_get "$PENDING" expires_at)" -lt "$(now)" ]; then rm -f "$PENDING"; STATE=expired; report; return; fi
    poll_once; report; return
  fi
  explicit_wait="$(value --wait)"
  if has --wait && [ -z "$explicit_wait" ]; then die "--wait needs a number of seconds"; fi
  if [ -n "$explicit_wait" ] && ! has --new && [ -f "$PENDING" ] && [ "$(kv_get "$PENDING" expires_at)" -gt "$(now)" ]; then resuming=1; fi
  [ "$resuming" = 1 ] || start_login
  if has --no-wait; then say "STATUS: waiting"; say 'Then run `login --wait 120` (or `login --check`).'; return 2; fi
  deadline=$(( $(now) + ${explicit_wait:-120} ))
  expires="$(kv_get "$PENDING" expires_at)"; [ "$expires" -lt "$deadline" ] && deadline="$expires"
  while :; do
    poll_once
    if [ "$STATE" != waiting ]; then report; return; fi
    interval="$(kv_get "$PENDING" interval)"
    if [ $(( $(now) + interval )) -gt "$deadline" ]; then report; return; fi
  done
}

# ---- calling Coach Studio ----------------------------------------------------

signed_out() { die "STATUS: signed out"$'\n'"The sign-in expired or was revoked. Run \`login\` again."; }

refresh_credentials() { # sets SERVER; returns 1 when it cannot
  local refresh; refresh="$(kv_get "$CRED" refresh_token)"
  post_form "$SERVER/oauth/token" "grant_type=refresh_token" "refresh_token=$refresh" "client_id=$CLIENT_ID"
  [ "$HTTP_CODE" = 200 ] && [ -n "$(json_str "$BODY" access_token)" ] || return 1
  save_credentials "$SERVER" "$BODY"
}
load_credentials() { # sets SERVER and ACCESS, refreshing an expired token
  [ -f "$CRED" ] || die "STATUS: not connected"$'\n'"Run \`login\` first."
  SERVER="$(kv_get "$CRED" server)"
  if [ "$(kv_get "$CRED" access_exp)" -lt $(( $(now) + 60 )) ]; then refresh_credentials || signed_out; fi
  ACCESS="$(kv_get "$CRED" access_token)"
}

mcp() { # method params-json: BODY is the JSON-RPC answer
  load_credentials
  local payload="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"
  http POST "$SERVER/mcp" "$ACCESS" "application/json" --data-binary "$payload"
  if [ "$HTTP_CODE" = 401 ]; then
    refresh_credentials || signed_out
    ACCESS="$(kv_get "$CRED" access_token)"
    http POST "$SERVER/mcp" "$ACCESS" "application/json" --data-binary "$payload"
  fi
  case "$HTTP_CODE" in
    200) ;;
    429) die "Too many calls: wait 30 seconds and try again." ;;
    400) die "The arguments are not valid JSON. Put the JSON in a file and use --args-file FILE, or pipe it in with --stdin." ;;
    *) die "Coach Studio answered HTTP $HTTP_CODE" ;;
  esac
  if printf '%s' "$BODY" | grep -q '"error":{"code"'; then
    die "Coach Studio: $(printf '%s' "$BODY" | sed -n 's/.*"error":{"code":-\{0,1\}[0-9]*,"message":"\([^"]*\)".*/\1/p')"
  fi
}

cmd_status() {
  mcp tools/list '{}'
  local count; count="$(printf '%s' "$BODY" | grep -o '"inputSchema"' | wc -l | tr -d ' ')"
  say "STATUS: connected"
  say "Server: ${SERVER#*//}"
  say "Permissions: $(kv_get "$CRED" scope | sed 's/^$/read:ops/')"
  say "Tools available: $count"
}

cmd_tools() {
  mcp tools/list '{}'
  printf '%s' "$BODY" | sed 's/{"name":"/\
{"name":"/g' | while IFS= read -r line; do
    case "$line" in '{"name":"'*) ;; *) continue ;; esac
    local name desc kind
    name="$(printf '%s' "$line" | sed -n 's/^{"name":"\([A-Za-z0-9_.-]*\)".*/\1/p')"
    desc="$(printf '%s' "$line" | sed -n 's/.*"description":"\([^"]*\)".*/\1/p' | sed 's/\\n/ /g; s/\. .*/./' | cut -c1-160)"
    case "$line" in *'"readOnlyHint":true'*) kind=read ;; *) kind=WRITE ;; esac
    say "$name  [$kind]  $desc"
  done
}

cmd_call() {
  local name raw="{}" file third
  name="$(arg 1)"
  { [ -n "$name" ] && [ "${name#--}" = "$name" ]; } || die "Usage: call TOOL [JSON | --stdin | --args-file FILE]"
  printf '%s' "$name" | grep -Eq '^[A-Za-z0-9_.-]+$' || die 'That is not a tool name. Run `tools` to see them.'
  file="$(value --args-file)"; third="$(arg 2)"
  if [ -n "$file" ]; then raw="$(cat "$file")"
  elif [ "$third" = "-" ] || [ "$third" = "--stdin" ]; then raw="$(cat)"
  elif [ -n "$third" ] && [ "${third#--}" = "$third" ]; then raw="$third"; fi
  raw="$(printf '%s' "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -n "$raw" ] || raw="{}"
  case "$raw" in '{'*'}') ;; *) die "The arguments are not valid JSON. Put the JSON in a file and use --args-file FILE, or pipe it in with --stdin." ;; esac
  mcp tools/call "{\"name\":\"$name\",\"arguments\":$raw}"
  if command -v jq >/dev/null 2>&1; then printf '%s\n' "$BODY" | jq -r '.result.content[0].text // .'; else printf '%s\n' "$BODY"; fi
  if printf '%s' "$BODY" | grep -q '"isError":true'; then return 1; fi
}

cmd_logout() {
  if [ -f "$CRED" ]; then
    ( post_form "$(kv_get "$CRED" server)/oauth/revoke" "token=$(kv_get "$CRED" refresh_token)" ) >/dev/null 2>&1 || true
  fi
  rm -f "$CRED" "$PENDING"
  say "STATUS: signed out"
}

cmd_help() {
  cat <<EOF
coach-studio $VERSION: read and manage Erica through Coach Studio.

  login [--no-wait] [--wait SECONDS] [--check]   sign in: prints a link and a code for the person to allow
  status                                          is it connected, with which permissions
  tools                                           the tools available ([read] or [WRITE])
  call TOOL [JSON | --stdin | --args-file FILE]   run one tool; JSON on the command line, from a file, or piped in with --stdin
  logout                                          revoke this sign-in and forget it

Lines starting with "STATUS:" say where things stand: connected, waiting, denied, expired, signed out, not connected.
EOF
}

case "$CMD" in
  login) cmd_login; exit $? ;;
  status) cmd_status; exit $? ;;
  tools) cmd_tools; exit $? ;;
  call) cmd_call; exit $? ;;
  logout) cmd_logout; exit $? ;;
  help|--help|-h) cmd_help ;;
  --version) say "$VERSION" ;;
  *) die "Unknown command: $CMD. Run \`help\`." ;;
esac
