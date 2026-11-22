# specmill

An always-on engineering agent built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

```
specmill/
├── dsh/                  # the runtime: DSH pinned to a version every plugin accepts
│   ├── container/        # deployment: the Specmill container and the VM bootstrap script
│   └── profiles/         # profile configuration templates
└── plugins/              # one folder per DSH plugin, each with its own package.json and lockfile
    ├── dsh-superagent/   # deepseek-ai/dsh-superagent-prototype@8c32a9d, unmodified (MIT)
    ├── spec-buddy/       # chat planning agent that hands specs to dsh-superagent
    └── clean-reviewer/   # clean-context PR reviewer for dsh-superagent workers
```

Each workspace package keeps its own lockfile and `node_modules` (`sharedWorkspaceLockfile: false`), so a plugin
builds and tests against the DSH libraries it pins, independent of `dsh/` and of other plugins.

## Develop

```sh
pnpm install   # installs dsh/ and every plugin
pnpm check     # typecheck, test and build every plugin
pnpm dsh --version
```

## Run

This section sets Specmill up in your own DSH home, on your own machine. To run it as a service, see
[Deploy](#deploy).

DSH loads plugins into a profile. Each service gets its own profile, because they restart independently and
dsh-superagent changes process-wide `PATH` and git settings.

To set up the `superagent` profile with the pinned runtime, follow
[plugins/dsh-superagent/SETUP.md](plugins/dsh-superagent/SETUP.md) and
[docs/006-deployment.md](plugins/dsh-superagent/docs/006-deployment.md), with the pinned `dsh` on `PATH` in place of
a global install (the plugins' start scripts also find it there):

```sh
export PATH="$PWD/dsh/node_modules/.bin:$PATH"
dsh superagent --from-default-profile web --dump-config > /dev/null   # new installs only
dsh plugin --profile superagent add "link:$PWD/plugins/dsh-superagent"
```

Then copy `dsh/profiles/superagent/cordis.patch.yml` to `~/.dsh/profiles/superagent/cordis.patch.yml` and fill in its
placeholders.

To give workers an independent reviewer that never sees their conversation, follow
[plugins/clean-reviewer/README.md](plugins/clean-reviewer/README.md):

```sh
dsh plugin --profile superagent add "link:$PWD/plugins/clean-reviewer"
```

Then append [plugins/clean-reviewer/prompts/delivery-addition.md](plugins/clean-reviewer/prompts/delivery-addition.md)
to the **Delivery requirements** team section in the dsh-superagent panel.

For the chat planning agent, follow [plugins/spec-buddy/README.md](plugins/spec-buddy/README.md):

```sh
dsh spec-buddy --from-default-profile web --dump-config > /dev/null   # new installs only
dsh plugin --profile spec-buddy add "link:$PWD/plugins/spec-buddy"
```

Then copy `dsh/profiles/spec-buddy/cordis.patch.yml` to `~/.dsh/profiles/spec-buddy/cordis.patch.yml` and fill in its
placeholders, including the Slack tokens and Spec Buddy's dedicated `GH_CONFIG_DIR`.

```sh
plugins/dsh-superagent/scripts/dsh-superagent start   # implementation agent, port 3082
plugins/spec-buddy/scripts/spec-buddy start           # planning agent, port 3083
```

`pnpm start`, `pnpm stop`, and `pnpm status` call both service scripts in turn. The hourly check for each service is
described in their READMEs.

## Deploy

The suggested way to deploy Specmill is a container on a VM. [dsh/container/](dsh/container/README.md) packages
the pinned runtime and Specmill's plugins as one Docker container. Its `bootstrap-vm.sh` prepares a fresh Ubuntu
24.04 or Debian 12 VM to run it:
- hardened SSH;
- a firewall that allows only SSH;
- rootless Docker for an unprivileged user.

The service is reached only through an SSH tunnel. Everything the agent does stays inside the container, away
from your own environment and credentials.

1. Create the VM, then bootstrap it as its admin user:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/mrhoody/specmill/main/dsh/container/bootstrap-vm.sh
   sudo bash bootstrap-vm.sh
   ```

2. Start Specmill as the `dsh` user, with the panel tunnelled to your machine:

   ```sh
   ssh -L 3082:127.0.0.1:3082 dsh@<vm>
   export DEEPSEEK_API_KEY=...  AGENT_GH_TOKEN=...  SUPERAGENT_REPO=owner/name
   DETACH=1 ~/specmill/dsh/container/run.sh
   ```

The container currently deploys the `superagent` profile, which runs dsh-superagent with clean-reviewer; spec-buddy is
not included yet. The same container also runs locally (`dsh/container/run.sh`) for a trial.
[dsh/container/README.md](dsh/container/README.md) explains what each step changes, what the secrets must be, and the
settings to save in the panel after the first start.

## Adding a plugin

Create `plugins/<name>/` with its own `package.json`, run `pnpm install`, and add it to a profile with
`dsh plugin --profile <profile> add "link:$PWD/plugins/<name>"`.
