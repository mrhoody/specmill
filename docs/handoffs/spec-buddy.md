# Handoff: Spec Buddy — a chat planning agent that hands specs to dsh-superagent

> For a DeepSeek Harness session in Creator mode, working in the `specmill` checkout.

## 1. Goal
Build **Spec Buddy**: a team member @mentions it in Slack, or DMs it, to turn an idea into a spec that is ready to
build. Once the person who asked approves the spec, Spec Buddy files it as a GitHub issue that mentions the
superagent's account. **dsh-superagent** (`plugins/dsh-superagent`) then picks it up through its existing GitHub
Source and does the work.

**Non-goals.** Spec Buddy never writes code, pushes, opens PRs or merges. It doesn't decide whether superagent
accepts the work: superagent's Policy does. Merging stays with people.

## 2. Ground rules (must hold)
- **No changes to upstream.** `plugins/dsh-superagent` and the DSH packages stay as pinned. Spec Buddy imports nothing
  from superagent source code. Copy its patterns; don't import them.
- **Follow superagent and DSH defaults** wherever there's a choice. Deployment follows superagent's
  `docs/006-deployment.md`.
- **Test only what Spec Buddy adds.** Don't re-test superagent intake, admission or tickets.
- Each workspace package keeps its own lockfile (`pnpm-workspace.yaml`, `sharedWorkspaceLockfile: false`). Pin the
  same DSH and Cordis versions as `plugins/dsh-superagent/package.json`.

## 3. User flow
1. In an allowed channel or a DM: `@spec-buddy we need rate limiting on the public API`.
2. Spec Buddy replies **in the thread**. It asks clarifying questions and reads the repository (a read-only local
   clone) and web pages.
3. Spec Buddy posts the draft spec in the thread, then revises it as the conversation goes on.
4. The person who asked approves the spec: a button on Slack, or the reply `hand off` where a provider has no
   buttons. Nobody else's approval counts.
5. Spec Buddy files a GitHub issue under **its own GitHub account** and posts the issue link in the thread.
6. Superagent sees a new issue from an allowed account mentioning it, so it treats the issue as an explicit request
   and opens a Ticket. From here everything happens on GitHub (and the PR).
7. *(Optional, WP8)* When superagent links a PR to the issue, Spec Buddy posts the PR link in the thread.

## 4. Facts about superagent that shape the design
- `src/sources/github-trigger.ts:43-63`:
  - Superagent ignores issues and comments written by its own account.
  - It treats `[bot]` accounts and GitHub Apps as bots, which only become *inferred* candidates.
  - A regular user account that mentions the agent's login counts as addressing it, which makes the request
    *explicit* if that user is on the allowed list.
  - **So Spec Buddy needs its own regular-user GitHub account (a machine user), and that account goes on
    superagent's GitHub `allowed` list.**
- `docs/006-deployment.md` (Settings):
  - A new issue or comment that mentions the agent arrives on the next poll.
  - Editing a mention into an existing issue does nothing, so the mention must be in the issue body when it's
    created.
- `docs/006-deployment.md:7`: superagent changes the process-wide `PATH` and git settings, and it needs its own
  restarts. So Spec Buddy runs in its **own DSH profile** (section 8).
- Patterns to copy:
  - plugin entry and injects: `src/index.ts`
  - creating and resuming Sessions and delivering messages once: `src/app/sessions.ts`, `src/app/delivery.ts`
  - agent presets as `@deepseek-ai/dsh-agent-preset` rows: `plugins/dsh-superagent/cordis.patch.yml`
  - a pluggable Source protocol: `src/sources/kind.ts` and `docs/008-cookbook.md`
  - start/stop script: `scripts/dsh-superagent`

## 5. Architecture
Package: `plugins/spec-buddy` (`@specmill/spec-buddy`), a DSH bundle with its own `cordis.patch.yml`. Like
superagent, it is several Cordis plugins built as separate entries.

### 5.1 `spec-buddy` (core plugin, `lib/index.js`)
- **Config** (zod, strict):
  - `stateDir` (absolute path, required)
  - `github.repo` (`owner/name`)
  - `github.agentLogin`: superagent's account
  - `github.configDir`: the `GH_CONFIG_DIR` for Spec Buddy's `gh` login
  - `repoCheckout`: a read-only clone
  - `model` (optional)
- **State:** a small SQLite or JSON store under `stateDir` with a lock, like superagent's. It holds:
  - conversation key → Session id
  - the current spec draft for each conversation
  - approvals
  - filed issues
  - dedupe of incoming events
  - sent-reply receipts
- **Conversations:**
  - Key: `<provider>:<conversation>:<thread>`. Session id: `spec-buddy:<key hash>`.
  - Sessions are created through `sessionController.create`, run under the `specmill-spec-buddy` preset, and get
    messages through `resolveAgent(...)`.
  - Each incoming message is delivered exactly once, using its event id as the request id.
  - When a turn ends, its final text goes back to the thread.
- **Service `chatProviders`:** providers register here (5.2).
- **Tools for the buddy's Sessions:**
  - `spec_draft(markdown)`: saves the conversation's current spec and posts or updates it in the thread.
  - `spec_request_approval()`: asks the person who asked for approval through the provider.
  - `spec_handoff()`:
    - Refuses unless the current draft is approved and has not changed since.
    - Then runs `gh issue create --repo <repo>` in plugin code with `GH_CONFIG_DIR=<github.configDir>`.
    - **Before filing, it checks `gh api user`.** It refuses if the login equals `agentLogin`, or if the account is a
      bot.
    - The model never sees the credential.
    - It files at most one issue per approved draft (the draft hash is the idempotency key), then posts the issue URL
      in the thread.
- **Health route:** for example `GET /spec-buddy/api/health`. It reports the runtime, each provider, and the GitHub
  identity check. `scripts/spec-buddy status` reads it.

### 5.2 Chat providers (pluggable, like superagent's `SourceKind`)
Define a `ChatProvider` interface in the core. Each chat platform is its own Cordis plugin that injects
`chatProviders` and registers on start, then unregisters when disposed:

```ts
interface ChatProvider<Config> {
  kind: string                                   // 'slack', later 'discord', …
  schema: ZodType<Config>                        // tokens, channels, allowed users
  maxLength: number; format(markdown: string): string[]   // split + dialect
  send(address: Address, text: string, replyId: string): Promise<'sent' | 'gone'>  // idempotent per replyId; throw = retry
  askApproval(address: Address, specId: string): Promise<void>  // buttons if supported, else text command
  link(address: Address): string
}
// Providers push normalized messages: { provider, conversation, thread, messageId, sender, addressed, text, url, at }
```

Nothing outside a provider plugin knows which chat platform is in use.
- **Build now:** `spec-buddy/slack-watch`.
  - Slack **Socket Mode** (`@slack/socket-mode` + `@slack/web-api`). It needs no public URL, which matters because
    DSH binds to 127.0.0.1.
  - Handles `app_mention` and `message.im`.
  - Ignores its own messages and messages from other bots.
  - Dedupes by `event_id`.
  - Thread = `thread_ts ?? ts`.
  - Approval is a Block Kit button. Only the person who asked can press it.
  - Config: `appToken` (`xapp-`), `botToken` (`xoxb-`), `channels[]`, `allowedUsers[]`.
  - Scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `channels:history`.
- **Later, with no core changes:**
  - `spec-buddy/discord-watch`: gateway websocket, Discord threads, 2000-character limit, buttons.
  - Providers that only push to a public HTTPS endpoint (for example Microsoft Teams) need a tunnel. Note this, but
    don't build it.

### 5.3 Agent preset `specmill-spec-buddy`
Add an `@deepseek-ai/dsh-agent-preset` row to the bundle's `cordis.patch.yml`, modelled on superagent's
`dsh-superagent-router` row.
- **Include:**
  - `dsh-persona`
  - `dsh-agent-instructions`
  - `dsh-time-context`
  - `dsh-tool-fs` with `write: false, edit: false`
  - `dsh-tool-fs-search`
  - `dsh-tool-web` (fetch on)
  - `dsh-skill-filesystem` + `dsh-tool-skill`
  - `dsh-tool-todo`
  - compaction group
- **Exclude:** shell, jobs, subagents, write tools, plan mode, and scheduling. Spec Buddy reads and talks. Its only
  side effects are the three tools above.

### 5.4 Prompt and skill
- **System prompt:**
  - Its role is planning partner, not implementer.
  - Ask one question at a time.
  - Read the code before proposing anything.
  - Keep specs small enough for one superagent Ticket. Split bigger work into several specs.
  - Never claim work has started until superagent has picked it up.
- **Skill `spec-writing`:** the spec template. The issue body has these sections:
  - **Problem**
  - **Context** (links, code paths read)
  - **Proposal**
  - **Acceptance criteria** (a checklist that can be tested)
  - **Out of scope**
  - **Affected areas**
  - **Risks / open questions**
  - **Test plan**
  - A footer: `Requested by <name> in <provider link>. Approved <time>.`
  - A final line: `@<agentLogin> please implement this issue.`

## 6. Superagent-side configuration (panel settings only, no code)
- **Policy → On each Source → GitHub:** add Spec Buddy's GitHub account to `allowed`.
- **Sources:** make sure the GitHub Source receives new issues for `github.repo`.

## 7. Packaging
- **`plugins/spec-buddy/package.json`:**
  - Copy the `dsh` manifest block and the peer and dev dependency pins from `plugins/dsh-superagent/package.json`.
  - Exports: `.`, `./slack-watch`.
  - Scripts: `build` (tsdown), `typecheck`, `test` (vitest), `check`.
- **`plugins/spec-buddy/cordis.patch.yml`:**
  - `insert` the `spec-buddy` and `spec-buddy/slack-watch` plugins (Slack enabled) and the preset row.
  - The profile supplies `stateDir` and secrets.
- The root `pnpm check` already covers `plugins/*`.

## 8. Deployment and operations (superagent's model)
- **Own profile `spec-buddy`** (from the DSH Web template, like superagent). Template:
  `dsh/profiles/spec-buddy/cordis.patch.yml`:
  - `webserver` on `127.0.0.1:3083` (superagent keeps 3082)
  - `spec-buddy.stateDir`
  - placeholders for the Slack tokens and the GitHub config dir
- **Why its own profile:**
  - superagent's shims would otherwise make Spec Buddy's `gh` calls run as the agent, and superagent would silently
    ignore those issues;
  - 006 says to keep superagent's profile apart from other work;
  - the two then restart independently;
  - superagent's panel stays focused on Tickets.
- **Rejected alternative:** loading Spec Buddy into the `superagent` profile. It would mean one process, but every
  `gh` call would have to override the account, and a superagent restart would also restart Spec Buddy.
- **`plugins/spec-buddy/scripts/spec-buddy start|stop|restart|status [--profile] [--url] [--respect-stop]`:**
  - modelled on `scripts/dsh-superagent`: tmux session `dsh-spec-buddy`, waits up to one minute for ready, and
    refuses a second copy;
  - per-profile logs and control files under `.artifacts/`;
  - the same exit codes: 0 ok, 1 not running or broken, 2 a part reports an error, 3 waiting for setup;
  - `stop` writes a stop marker, which `--respect-stop` honours.
- **Hourly check:** add a Spec Buddy line next to superagent's in the hourly-check prompt, scheduled from the
  operator's own profile (006 "Hourly check").
- **Optional:** root `pnpm start` / `stop` / `status`, which call the two scripts in turn. This is a Specmill
  convenience, not upstream practice.
- Update the root `README.md` "Run" section.

## 9. Work packets (in order; each ends with `pnpm check` green)
1. **WP1 Scaffold:** the package, tsdown entries, the bundle `cordis.patch.yml` with the preset, and a core plugin
   that starts, takes the state lock and serves health.
2. **WP2 Providers:**
   - the `ChatProvider` interface and the `chatProviders` service;
   - the Slack provider: Socket Mode, filters, dedupe, idempotent send, health.
3. **WP3 Conversations:** conversation key → Session, deliver once, post the turn's final text, resume after restart.
4. **WP4 Spec:** the prompt, the `spec-writing` skill, and the `spec_draft` tool.
5. **WP5 Handoff:** approval (button and text fallback, only the person who asked), the identity check, `spec_handoff`
   with the idempotency key, and the issue link posted back.
6. **WP6 Ops:** the profile template, `scripts/spec-buddy`, the hourly-check line, and the README.
7. **WP7 (optional):** root `pnpm start/stop/status`.
8. **WP8 (optional):** relay the PR link. Poll the filed issues for linked PRs and post each once in the thread.

## 10. Tests (Spec Buddy's additions only)
- Slack event → normalized message:
  - stable ids
  - thread key
  - addressed vs not
  - own and bot messages dropped
  - channel and user allowlist
- Dedupe of repeated events. Sends are idempotent per `replyId`, `gone` vs retry. Long text split at `maxLength`.
- Approval gate:
  - refused without approval;
  - refused after the draft changes;
  - refused when someone other than the person who asked approves.
- Identity check: refuse when `gh api user` is the agent account or a bot.
- Issue body: every section is present, and the agent mention is on the last line. A repeat handoff files no second
  issue.
- Provider plugin lifecycle: it registers on start, unregisters when disposed, and a loop failure shows up in health
  instead of becoming an unhandled rejection.

## 11. Done when
In a test Slack channel:
1. Someone @mentions Spec Buddy and the two of them work out a spec in the thread.
2. The person who asked approves it.
3. An issue appears, authored by Spec Buddy's GitHub account, with the agent mention.
4. Superagent's panel shows a new Ticket from that issue.
5. `scripts/spec-buddy status` exits 0, and stop/start of either service doesn't affect the other.

## 12. Operator inputs needed before WP2 and WP5
- A Slack app with Socket Mode enabled: the `xapp-` and `xoxb-` tokens, the scopes above, and the channels it should
  join.
- Spec Buddy's GitHub machine-user account, signed in with `gh auth login` into a dedicated `GH_CONFIG_DIR`, and added
  to superagent's allowed list.
- The model for Spec Buddy, if it shouldn't use the profile default.
