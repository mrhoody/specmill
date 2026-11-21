# @specmill/clean-reviewer

A clean-context reviewer for [dsh-superagent](../dsh-superagent) workers.

A worker that reviews its own PR does so with its whole implementation conversation in mind, so it tends to agree with
itself. This plugin gives each worker a `review_changes` tool. The tool starts a reviewer that has never seen the
worker's conversation. The worker cannot brief it, because the tool takes no arguments. The plugin builds the
reviewer's only message itself, from three things:

- **What was asked:** the messages dsh-superagent delivered to the worker (the assignment, the request and later
  messages from people), plus anything a person typed into the worker Session. The worker's replies, tool calls and
  reasoning are never included.
- **The change:** the diff of the pushed head commit against its merge base with the PR's base branch.
- **The repository:** the reviewer reads it, including its agent instructions, and can run `git` and the tests.

The reviewer answers with structured findings (severity, file, line, summary, evidence). The worker assesses them as
fallible input, the same way upstream treats automated reviewers: it fixes the valid ones and records what it did with
each. The review is not a merge gate, and it is never posted on GitHub.

dsh-superagent and DSH are used unchanged.

## How it works

- `src/index.ts`: on `agent/created`, registers `review_changes` in the agent's own scope for every Session named
  `worker-<ticketId>`. Tools in an agent's own scope are not masked by dsh-superagent's worker tool allowlist. Other
  Sessions, including a worker's subagents, don't get the tool.
- `src/target.ts`: in the worker's directory (`session.header.cwd`), it refuses a dirty tree, a detached HEAD, a head that
  isn't pushed, and a head the open PR doesn't show yet. It takes the base from the PR (`gh pr view`), falling back to
  `origin/HEAD`, fetches it, and diffs `merge-base..HEAD`. A diff over `maxDiffChars` is left for the reviewer to read
  with `git diff`.
- `src/request.ts`: reads `user/message` events whose source is `dsh-superagent` or `user`, keeping the first message
  and the newest follow-ups within `maxRequestChars`.
- `src/review.ts`: starts the reviewer through DSH's subagent service (`ctx.subagents.startActivation`). It uses the
  `spawn` backend, which starts the child with an empty conversation, under the `specmill-reviewer` preset, with
  `delivery: 'caller'` and an output schema. It waits for the result and stops the reviewer when the worker's call is
  cancelled or `timeoutMinutes` passes.
- `cordis.patch.yml`: the `specmill-reviewer` preset. It has read-only file tools, file search, a shell with a
  2-minute default timeout, and the repository's agent instructions. It has no write or edit tools, no delegation, no
  web access and no questions to a person. Because the reviewer is a worker's child, dsh-superagent also limits it to
  the worker's tools and stops it when the ticket ends.

Every failure is closed: the tool returns `{ reviewed: false, reason }` and does not start a review on partial input.

## Set up

1. Add the plugin to the `superagent` profile, next to dsh-superagent:

   ```sh
   dsh plugin --profile superagent add "link:$PWD/plugins/clean-reviewer"
   ```

2. Optionally choose the reviewer's model in `~/.dsh/profiles/superagent/cordis.patch.yml` (see
   `dsh/profiles/superagent/cordis.patch.yml`). Without a model, the reviewer uses the worker's model.

   ```yaml
   - id: clean-reviewer
     config:
       model: <provider>/<model>
       reasoningEffort: high
   ```

   Other settings: `maxDiffChars` (default 60000), `maxRequestChars` (default 16000), `timeoutMinutes` (default 20).

3. Tell workers to use it. In the dsh-superagent panel, under Prompts, append
   [`prompts/delivery-addition.md`](prompts/delivery-addition.md) to the **Delivery requirements** team section and
   save. The text is stored in dsh-superagent's database, not in this repository. The tool's own description repeats
   the same rules.

## Upstream pins

This plugin relies on these upstream details. Check them when bumping DSH or dsh-superagent:

| What | Where |
| --- | --- |
| Worker Sessions are named `worker-<ticketId>` | `plugins/dsh-superagent/src/executor/dsh.ts:24-26` |
| Messages dsh-superagent delivers have `source.kind: 'dsh-superagent'` | `plugins/dsh-superagent/src/executor/dsh.ts:497` |
| Tools in an agent's own scope are not masked by the worker allowlist | `plugins/dsh-superagent/src/app/sessions.ts:261-267,280-290` |
| `ctx.subagents.startActivation` with `agentPreset`, `outputSchema`, `delivery: 'caller'` (DSH 0.2.1-rc.5) | `@deepseek-ai/dsh-subagent` `lib/types/types.d.ts` |
| The `spawn` backend starts children with an empty conversation | `@deepseek-ai/dsh-subagent-spawn-in-process` README |
| Output schemas use only `type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` plus annotations (no `minimum`) | dsh-subagent rejects others at start; pinned by `tests/prompt.spec.ts` |

The plugins build against DSH 0.2.1-alpha.2 types, but `agentPreset` exists only in the 0.2.1-rc.5 runtime, so
`src/review.ts` declares the small part of the subagent service it uses itself.

## Develop

```sh
pnpm install
pnpm check   # typecheck, test, build
```

The tests cover only what this plugin adds: the review target, the request text, the prompt, the tool's registration
and its refusals, and the bundle patch. They don't re-test dsh-superagent or DSH.
