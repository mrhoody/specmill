# A disposable dsh-superagent + clean-reviewer runtime. Everything (profile, state, gh login, clones) lives in the
# container and goes away with it. Build from the repository root:  docker build -f dsh/container/Dockerfile -t specmill-superagent .
FROM node:24-bookworm

# dsh-superagent prerequisites (git, tmux, python3, gh), jq/curl for the Management API, socat to publish the loopback panel, bubblewrap for DSH's bash sandbox.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux python3 jq curl socat ca-certificates bubblewrap \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.7.0

# Run as an ordinary user: the agent's presets have full access to whatever this user can reach, which is only the container.
RUN useradd --create-home --shell /bin/bash agent
USER agent
WORKDIR /home/agent/specmill
ENV PATH=/home/agent/specmill/dsh/node_modules/.bin:/home/agent/.local/bin:$PATH

# Dependencies are installed here for Linux; the host's node_modules (built for macOS) are excluded by the .dockerignore.
# The root workspace file carries the build-script approvals (allowBuilds) and per-package lockfiles.
COPY --chown=agent:agent pnpm-workspace.yaml ./
COPY --chown=agent:agent dsh/package.json dsh/pnpm-lock.yaml dsh/
RUN cd dsh && pnpm install --frozen-lockfile
COPY --chown=agent:agent plugins/dsh-superagent plugins/dsh-superagent
COPY --chown=agent:agent plugins/clean-reviewer plugins/clean-reviewer
RUN cd plugins/dsh-superagent && pnpm install --frozen-lockfile && pnpm build \
 && cd ../clean-reviewer && pnpm install --frozen-lockfile && pnpm build

# The superagent profile, created from the Web template, with both plugins linked from this copy.
RUN dsh superagent --from-default-profile web --dump-config > /dev/null \
 && dsh plugin --profile superagent add "link:$PWD/plugins/dsh-superagent" \
 && dsh plugin --profile superagent add "link:$PWD/plugins/clean-reviewer"
COPY --chown=agent:agent dsh/container/profile.cordis.patch.yml /home/agent/.dsh/profiles/superagent/cordis.patch.yml
COPY --chown=agent:agent --chmod=755 dsh/container/entrypoint.sh dsh/container/gh-agent /home/agent/.local/bin/

EXPOSE 3082
ENTRYPOINT ["entrypoint.sh"]
