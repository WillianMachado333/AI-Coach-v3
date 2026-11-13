#!/usr/bin/env bash
# Installs the Coach Studio CLI and its Skill (macOS / Linux):
#   curl -fsSL __ORIGIN__/cli/install.sh | bash
# It downloads two files from this Studio into ~/.coach-studio and, if Claude
# Code's folder exists, copies the Skill into ~/.claude/skills/coach-studio.
# It changes nothing else on this computer and does not touch PATH.
set -euo pipefail
ORIGIN="__ORIGIN__"
DIR="${COACH_STUDIO_HOME:-$HOME/.coach-studio}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required (https://nodejs.org). Install it, then run this again." >&2
  exit 1
fi
if [ "$(node -p "Number(process.versions.node.split('.')[0])")" -lt 18 ]; then
  echo "Node.js 18 or newer is required; this is $(node -v). Update it, then run this again." >&2
  exit 1
fi

mkdir -p "$DIR"
curl -fsSL "$ORIGIN/cli/coach-studio.mjs" -o "$DIR/coach-studio.mjs"
curl -fsSL "$ORIGIN/cli/SKILL.md" -o "$DIR/SKILL.md"
printf '{"server":"%s"}\n' "$ORIGIN" > "$DIR/config.json"

SKILL_NOTE="Read the Skill at $DIR/SKILL.md"
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$HOME/.claude/skills/coach-studio"
  cp "$DIR/SKILL.md" "$HOME/.claude/skills/coach-studio/SKILL.md"
  SKILL_NOTE="Skill installed for Claude Code: $HOME/.claude/skills/coach-studio/SKILL.md"
fi

echo "Coach Studio CLI installed in $DIR (server $ORIGIN)."
echo "$SKILL_NOTE"
echo "Check it: node \"$DIR/coach-studio.mjs\" status"
echo "Sign in:  node \"$DIR/coach-studio.mjs\" login --no-wait"
