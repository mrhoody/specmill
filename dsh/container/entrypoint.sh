#!/bin/sh
# Signs the agent's gh in from AGENT_GH_TOKEN, clones the test repository, and runs the superagent profile in the foreground.
set -eu
: "${DEEPSEEK_API_KEY:?Pass DEEPSEEK_API_KEY (the DeepSeek API key the agent and the reviewer use).}"

if [ -n "${AGENT_GH_TOKEN:-}" ]; then
  printf '%s\n' "$AGENT_GH_TOKEN" | gh-agent auth login --hostname github.com --with-token
fi
# Keep the token out of the DSH process; gh-agent reads it from its own config directory from here on.
unset AGENT_GH_TOKEN GH_TOKEN GITHUB_TOKEN
if gh-agent auth status --hostname github.com >/dev/null 2>&1; then
  echo "gh-agent signed in as $(gh-agent api user --jq .login)"
else
  echo "gh-agent is not signed in; pass AGENT_GH_TOKEN, or run: docker exec -it <container> gh-agent auth login" >&2
fi

# The local clone each Ticket's prepare command adds worktrees from (Settings → Execution).
if [ -n "${SUPERAGENT_REPO:-}" ] && [ ! -d "$HOME/src/repo/.git" ]; then
  gh-agent repo clone "$SUPERAGENT_REPO" "$HOME/src/repo"
fi

# DSH listens on 127.0.0.1:3082, which a published port cannot reach; forward the container's bridge address to it.
bridge=$(hostname -i | awk '{print $1}')
socat "TCP-LISTEN:3082,bind=$bridge,fork,reuseaddr" TCP:127.0.0.1:3082 &

cd "$HOME/specmill"
exec dsh --profile superagent --no-open
