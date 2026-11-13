#!/usr/bin/env bash
# Installs the Coach Studio CLI and its Skill (macOS / Linux):
#   curl -fsSL __ORIGIN__/cli/install.sh | bash
# It downloads two files from this Studio into ~/.coach-studio and, if Claude
# Code's folder exists, copies the Skill into ~/.claude/skills/coach-studio.
# Nothing to install first: it uses bash and curl, which come with the computer.
# It changes nothing else and does not touch PATH.
set -euo pipefail
ORIGIN="__ORIGIN__"
DIR="${COACH_STUDIO_HOME:-$HOME/.coach-studio}"

command -v curl >/dev/null 2>&1 || { echo "curl is needed and was not found." >&2; exit 1; }

mkdir -p "$DIR"
curl -fsSL "$ORIGIN/cli/coach-studio.sh" -o "$DIR/coach-studio.sh"
curl -fsSL "$ORIGIN/cli/SKILL.md" -o "$DIR/SKILL.md"
chmod +x "$DIR/coach-studio.sh"
printf 'server=%s\n' "$ORIGIN" > "$DIR/config"

SKILL_NOTE="Read the Skill at $DIR/SKILL.md"
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$HOME/.claude/skills/coach-studio"
  cp "$DIR/SKILL.md" "$HOME/.claude/skills/coach-studio/SKILL.md"
  SKILL_NOTE="Skill installed for Claude Code: $HOME/.claude/skills/coach-studio/SKILL.md"
fi

echo "Coach Studio CLI installed in $DIR (server $ORIGIN)."
echo "$SKILL_NOTE"
echo "Check it: bash \"$DIR/coach-studio.sh\" status"
echo "Sign in:  bash \"$DIR/coach-studio.sh\" login --no-wait"
