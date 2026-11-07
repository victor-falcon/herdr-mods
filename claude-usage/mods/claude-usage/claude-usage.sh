#!/bin/sh
# Prints one Claude account's usage (one `control_response` JSON line) and exits.
#
# Usage: claude-usage.sh <config dir | ->   ("-": the default ~/.claude)
#
# Runs the `claude` CLI briefly and sends it the `get_usage` control request;
# the CLI signs in with that account's own login. Reads no tokens or credential
# files, sends no prompt and starts no turn. `--safe-mode` keeps hooks, MCP
# servers and customizations out of it.
# Adapted from nozikov/herdr-usage-limits (MIT), after jmalicki/herdr-mod-ai-usage.
#
# Exit: 0 = printed the reply, 127 = claude CLI not found, 1 = no reply in 15 s.

# An API key would make the CLI skip the subscription, which has the limits.
unset ANTHROPIC_API_KEY CLAUDECODE CLAUDE_CODE_ENTRYPOINT
if [ "${1:--}" = "-" ]; then unset CLAUDE_CONFIG_DIR; else export CLAUDE_CONFIG_DIR="$1"; fi

CLAUDE=$(command -v claude 2>/dev/null) || CLAUDE="$HOME/.local/bin/claude"
[ -x "$CLAUDE" ] || exit 127

dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-claude-usage.XXXXXX") || exit 1
out="$dir/out"
mkfifo "$dir/in" || { rm -rf "$dir"; exit 1; }

"$CLAUDE" -p --safe-mode --no-session-persistence \
  --input-format stream-json --output-format stream-json --verbose \
  <"$dir/in" >"$out" 2>/dev/null &
pid=$!
exec 3>"$dir/in"
printf '%s\n' '{"type":"control_request","request_id":"herdr-usage","request":{"subtype":"get_usage","skip_behaviors":true}}' >&3

i=0
while [ "$i" -lt 75 ]; do
  if grep -q '"control_response"' "$out" 2>/dev/null; then break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
  i=$((i + 1))
done
exec 3>&-
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null

status=1
if grep -m1 '"control_response"' "$out"; then status=0; fi
rm -rf "$dir"
exit $status
