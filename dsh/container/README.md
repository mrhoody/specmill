# dsh/container

A way to deploy Specmill: the pinned DSH runtime from [`dsh/`](..) and Specmill's plugins, packaged as one Docker
container, plus a script that prepares a fresh VM to run it securely. The same container runs on your machine for a
trial, or on a VM as the deployment.

It deploys the `superagent` profile: [dsh-superagent](../../plugins/dsh-superagent) with
[clean-reviewer](../../plugins/clean-reviewer). [spec-buddy](../../plugins/spec-buddy) runs in its own profile and
isn't included yet.

## Why this exists

The manual setup in the root README installs Specmill into your own DSH home, on your own machine. That's fine for
development, but not for running Specmill as a service:

- dsh-superagent works on a GitHub repository by itself. It reads requests, runs workers that execute commands, pushes
  branches and opens pull requests.
- It changes process-wide settings. It puts its own `gh` and git configuration first on `PATH`, and replaces the
  global git configuration for its workers.
- Its presets run with full access as their OS user.

Running it in your normal environment mixes all of that with your own credentials and settings. This directory gives
Specmill a deployment of its own instead.

The container keeps it apart:

- **Disposable.** The profile, state, the agent's GitHub login and every clone live in the container. Stopping it
  deletes them; the next start begins from scratch. That suits trying out the plugins end to end.
- **Contained.** A worker can reach only the container, not your home directory or your own `gh` login.
- **No secrets in the image.** The DeepSeek key and the agent's GitHub token come from your shell's environment at
  run time.

To deploy Specmill on a server, run the container on a VM. The VM bootstrap script exists because a VM on the
internet needs more than Docker. A fresh cloud VM usually allows
password logins, has no firewall, and would run Docker as root. The script closes those gaps before anything runs, so
the agent and the panel are reachable only by you over SSH.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | Debian 12 (`node:24-bookworm`) with the pinned DSH runtime and both plugins linked into a `superagent` profile |
| `Dockerfile.dockerignore` | Keeps the host's `node_modules` (built for macOS) and build output out of the image |
| `profile.cordis.patch.yml` | The profile's machine configuration: panel port, state directory, optional reviewer model |
| `entrypoint.sh` | Signs in the agent's `gh`, clones the test repository, starts DSH |
| `gh-agent` | The agent's GitHub CLI, with its own config directory |
| `run.sh` | Builds the image and runs the container |
| `bootstrap-vm.sh` | Prepares a fresh Ubuntu 24.04 or Debian 12 VM (run once, with sudo) |

## What you need

- **A DeepSeek API key** (`DEEPSEEK_API_KEY`). The profile uses the `deepseek-official` provider with
  `deepseek-flash`. The `deepseek-account` sign-in doesn't carry into a container.
- **A test repository** on github.com (`SUPERAGENT_REPO=owner/name`) that the agent can't damage. Don't use a real
  project.
- **A GitHub token for the agent** (`AGENT_GH_TOKEN`). Use a fine-grained token limited to the test repository, or a
  dedicated agent account. Never use a classic token with access to all repositories: the agent can run any command
  in its container.

## Run locally

Needs Docker; on macOS, Colima works (`colima start`).

```sh
export DEEPSEEK_API_KEY=...  AGENT_GH_TOKEN=...  SUPERAGENT_REPO=owner/name
dsh/container/run.sh             # attached; Ctrl-C stops and deletes it
DETACH=1 dsh/container/run.sh    # in the background; stop with: docker stop specmill-superagent
```

Open the `http://127.0.0.1:3082/?token=...` URL DSH prints (`docker logs specmill-superagent | grep token=` when
detached), then **Superagent** in the sidebar.

## Run on a VM

1. **Create the VM** with Ubuntu 24.04 or Debian 12, at least 4 GB of memory and 8 GB of free disk. Log in as its
   admin user (one with sudo) with an SSH key. If your provider has a firewall (a security group), allow only SSH,
   ideally only from your IP address.
2. **Bootstrap it**, as that admin user:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/mrhoody/specmill/<branch>/dsh/container/bootstrap-vm.sh
   sudo REPO_BRANCH=<branch> bash bootstrap-vm.sh
   ```

   Read the script first; it changes SSH, the firewall and users. It takes about ten minutes, most of it building the
   image. It is safe to run again.
3. **Start the service** as the `dsh` user, with the panel tunnelled to your machine:

   ```sh
   ssh -L 3082:127.0.0.1:3082 dsh@<vm>
   export DEEPSEEK_API_KEY=...  AGENT_GH_TOKEN=...  SUPERAGENT_REPO=owner/name
   DETACH=1 ~/specmill/dsh/container/run.sh
   docker logs specmill-superagent | grep token=
   ```

   Open the printed URL on your machine while the tunnel is up. The local end of the tunnel must be port `3082`: the
   panel's API refuses requests addressed to any other port.

The secrets live only in that SSH session's environment and the running container. Re-export them after a restart.

### What the bootstrap script does

| Area | Change |
| --- | --- |
| SSH | Key-only login; no root login; only the admin user and `dsh` may log in; no agent or X11 forwarding. Refuses to start if the admin user has no SSH key, so it can't lock you out |
| Firewall | ufw denies all incoming traffic except SSH, which is rate-limited; fail2ban bans repeated SSH failures |
| Updates | Unattended security upgrades. No automatic reboots, which would kill a running ticket, unless `AUTO_REBOOT_TIME=04:00` is set |
| Service user | `dsh` runs Docker and the service. It has no sudo, no password and no extra groups. Administer the VM as the admin user |
| Docker | Rootless, for `dsh` only, with `no-new-privileges` and log rotation; the root daemon is disabled. Rootless Docker doesn't edit iptables, so ufw stays in control of every port. Lingering keeps it running after you log out |
| Checks | Landlock (needed for the reviewer's sandbox, below), free disk, and memory, adding a 2 GB swap file on small VMs |
| Code | Clones the repository read-only over HTTPS as `dsh` and builds the image. It never handles secrets |

Settings: `SERVICE_USER` (default `dsh`), `REPO_URL`, `REPO_BRANCH` (default `main`), `AUTO_REBOOT_TIME`,
`SKIP_BUILD=1`.

## After it starts

The service waits for setup (`repositoryUnset`) until the panel's settings are saved. Follow Settings in
`plugins/dsh-superagent/docs/006-deployment.md`:

- **Sources:** the repository, with `/home/agent/.local/bin/gh-agent` as the CLI.
- **Policy:** who may ask for work.
- **Execution:** a prepare command that adds a worktree from `/home/agent/src/repo` for each ticket.
- **Prompts:** append `plugins/clean-reviewer/prompts/delivery-addition.md` to Delivery requirements.

They can also be saved through the management API (same document) from inside the container.

## Design notes

Each of these was found by running the container, so don't undo them without checking:

- **DSH listens on loopback, and `socat` publishes it.** dsh-superagent's management API requires a loopback web
  server, and DSH refuses to bind every interface (`0.0.0.0`). So DSH listens on `127.0.0.1:3082` inside the
  container, and `socat` forwards the container's bridge address to it. `run.sh` publishes that only on the host's
  `127.0.0.1`.
- **pnpm build approvals come from the root `pnpm-workspace.yaml`.** pnpm 11 doesn't run dependency build scripts
  (such as `node-pty`'s) unless they're approved. The approvals live in the repository's root workspace file, which
  the image copies.
- **The reviewer's shell is sandboxed with Landlock.** The clean-reviewer preset runs its shell through DSH's
  sandbox, which fails closed when no sandbox works. bubblewrap can't create user namespaces in Colima's VM or a
  rootless container, so DSH falls back to Landlock. Landlock works under Docker's default seccomp profile, with
  `partial` enforcement on 6.8 kernels. A VM whose kernel lacks Landlock can't run reviews, and the bootstrap script
  checks for it.
- **Ubuntu 24.04 starts `sshd` on demand.** The bootstrap script creates `/run/sshd` before checking the SSH config,
  and reloads `ssh.service` only when it is running.
