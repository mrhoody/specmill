# specmill

An always-on engineering agent built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

```
specmill/
├── dsh/                  # the runtime: DSH pinned to a version every plugin accepts
│   └── profiles/         # profile configuration templates
└── plugins/              # one folder per DSH plugin, each with its own package.json and lockfile
    └── dsh-superagent/   # deepseek-ai/dsh-superagent-prototype@8c32a9d, unmodified (MIT)
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

## Adding a plugin

Create `plugins/<name>/` with its own `package.json`, run `pnpm install`, and add it to a profile with
`dsh plugin --profile <profile> add "link:$PWD/plugins/<name>"`.
