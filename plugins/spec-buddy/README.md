# Spec Buddy

Spec Buddy is a chat planning agent. A teammate @mentions it in Slack or DMs it; together they turn an idea into a spec
that is ready to build. When the person who asked approves the spec, Spec Buddy files it as a GitHub issue that
mentions dsh-superagent's account. dsh-superagent's GitHub Source then picks it up and does the work.

**Non-goals.** Spec Buddy never writes code, pushes, opens pull requests, or merges. It does not decide whether
dsh-superagent accepts the work; dsh-superagent's Policy does. Merging stays with people.

## How it works

- `spec-buddy` is the core plugin: it locks a state directory, stores conversations/drafts/approvals/issues in
  `state.json`, creates one DSH Session per chat thread under the `specmill-spec-buddy` preset, and serves
  `GET /spec-buddy/api/health`.
- `spec-buddy/slack-watch` is a chat provider. It uses Slack **Socket Mode**, so DSH can keep binding to `127.0.0.1`.
  Providers register with the core's `chatProviders` service; nothing in the core names Slack.
- The buddy's Session reads the repository checkout and the web, drafts the spec, asks the requester for approval, and
  files the issue. Its only tools are `spec_draft`, `spec_request_approval`, and `spec_handoff`.

Spec Buddy files with its **own regular-user GitHub account**. dsh-superagent ignores issues written by its own account,
and treats `[bot]` accounts and GitHub Apps as bots, so a machine user is required and must be added to
dsh-superagent's GitHub `allowed` list.

## Prerequisites

Node.js 22.19+ or 24+, pnpm, Python 3.8+, tmux, and GitHub CLI (`gh`) 2.48+. A model provider configured for the profile.

## Install

```sh
cd plugins/spec-buddy
pnpm install
pnpm build

# Create the dedicated profile from the Web template (new installs only).
dsh spec-buddy --from-default-profile web --dump-config > /dev/null
dsh plugin --profile spec-buddy add "link:$PWD"
```

Copy [`dsh/profiles/spec-buddy/cordis.patch.yml`](../../dsh/profiles/spec-buddy/cordis.patch.yml) to
`~/.dsh/profiles/spec-buddy/cordis.patch.yml` and replace every placeholder. The profile keeps Spec Buddy separate from
dsh-superagent: dsh-superagent changes process-wide `PATH` and git settings, the two restart independently, and
dsh-superagent's profile stays focused on Tickets.

## Operator inputs

1. **Slack app with Socket Mode enabled.** App-level token `xapp-…`, bot token `xoxb-…`, and bot scopes
   `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `channels:history`. Invite the bot to the channels you
   list. An empty `channels` or `allowedUsers` list means Spec Buddy listens to nobody.
2. **Spec Buddy's GitHub machine user.** Sign it in with a dedicated config directory, not the operator's:

   ```sh
   mkdir -p ~/.config/gh-spec-buddy
   GH_CONFIG_DIR=~/.config/gh-spec-buddy gh auth login
   GH_CONFIG_DIR=~/.config/gh-spec-buddy gh api user --jq '.login + "\t" + .type'
   ```

   Point `github.configDir` at that directory. The last command must print a `User` account, not the agent's account
   and not a bot. `spec_handoff` runs the same check before every filing and refuses otherwise. The model never sees
   the credential.
3. **dsh-superagent-side settings (no code).**
   - **Policy → On each Source → GitHub:** add Spec Buddy's GitHub login to `allowed`.
   - **Sources:** make sure the GitHub Source receives new issues for `github.repo`.
4. **Model** (optional). Set `model: <provider>/<model>` in the core config to override the profile default.

## Run

```sh
plugins/spec-buddy/scripts/spec-buddy start
plugins/spec-buddy/scripts/spec-buddy status
plugins/spec-buddy/scripts/spec-buddy stop
```

`start` runs `dsh --profile spec-buddy` in tmux session `dsh-spec-buddy`, waits up to one minute for health, and
refuses a second copy. Per-profile logs and control files live under `plugins/spec-buddy/.artifacts/`. `--profile`,
`--url`, and `--respect-stop` work as they do for `scripts/dsh-superagent`; `DSH_SPEC_BUDDY_PROFILE` and
`DSH_SPEC_BUDDY_URL` override the defaults. The health check URL defaults to `http://127.0.0.1:3083`.

Exit codes are the same as dsh-superagent's:

| Code | Meaning |
| --- | --- |
| 0 | Running normally |
| 1 | Not running, duplicated, unreachable, or the runtime reports an error; a restart may fix it |
| 2 | Running, but a part (a chat provider, the GitHub identity check, Session delivery) reports an error; a restart does not fix it |
| 3 | Running and waiting for setup; a restart does not fix it |

Only an intentional `stop` writes the stop marker; `--respect-stop` honours it.

### Hourly check

Add this line next to dsh-superagent's line in the hourly-check prompt of the profile you normally use, with the
checkout path filled in. It must keep running when Spec Buddy is down:

```text
Check Spec Buddy too: run `plugins/spec-buddy/scripts/spec-buddy --profile spec-buddy status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what setup needs. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `plugins/spec-buddy/scripts/spec-buddy --profile spec-buddy --respect-stop restart`; if that exits 1 or fails, read the newest .artifacts/spec-buddy-*.log and tell me what was wrong and what you did.
```

## Health

`GET /spec-buddy/api/health` is loopback-only and reports:

```json
{
  "runtime": { "state": "ready", "detail": "Spec Buddy is listening" },
  "github": { "state": "ready", "detail": "Signed in as spec-buddy-bot" },
  "state": { "state": "ready", "detail": "/…/state/spec-buddy" },
  "sessions": { "state": "ready", "detail": "No Session delivery has failed" },
  "providers": { "slack": { "state": "ready", "detail": "Connected over Socket Mode" }, "inbound": { "state": "ready", "detail": "…" } },
  "summary": { "conversations": 1, "approved": 1, "filed": 1 }
}
```

It never contains tokens or message text.

## Tests

`pnpm check` in this package typechecks, runs the Spec Buddy tests, and builds `lib/`. Tests cover only what Spec Buddy
adds: Slack normalization and filtering, dedupe, idempotent sends, long-text splitting, the approval gate, the gh
identity check, issue rendering and repeat-handoff idempotency, the provider lifecycle, the state lock, and the bundle
patch.

## Adding another chat platform

Implement `ChatProvider` (exported from `@specmill/spec-buddy`) in a new package export, register it with the injected
`chatProviders` service on start, and unregister it on dispose. A Discord gateway provider (2000-character limit, Discord threads,
buttons) needs no core changes. Providers that only push to a public HTTPS endpoint, such as Microsoft Teams, need a
tunnel; that is not built.
