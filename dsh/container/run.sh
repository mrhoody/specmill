#!/bin/sh
# Builds and runs the disposable superagent container. Secrets come from your shell's environment, never from a file:
#   export DEEPSEEK_API_KEY=...   AGENT_GH_TOKEN=...   SUPERAGENT_REPO=owner/name
#   dsh/container/run.sh            # attached; Ctrl-C stops it
#   DETACH=1 dsh/container/run.sh   # in the background, surviving logout; stop with: docker stop specmill-superagent
# Open the http://127.0.0.1:3082/?token=... URL DSH prints. Stopping the container deletes it and all of its state.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
: "${DEEPSEEK_API_KEY:?export DEEPSEEK_API_KEY first}"

docker build -f "$root/dsh/container/Dockerfile" -t specmill-superagent "$root"
# Docker's default seccomp profile is enough: DSH's bash sandbox (the reviewer's shell) falls back from bubblewrap, which
# Colima's VM blocks, to Landlock, which works here with partial enforcement.
if [ -n "${DETACH:-}" ]; then mode=-d; else mode=-it; fi
exec docker run --rm "$mode" --name specmill-superagent \
  -p 127.0.0.1:3082:3082 \
  -e DEEPSEEK_API_KEY -e AGENT_GH_TOKEN -e SUPERAGENT_REPO \
  specmill-superagent
