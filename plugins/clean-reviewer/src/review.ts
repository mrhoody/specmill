/**
 * The `review_changes` tool: builds the review input itself, starts a fresh reviewer under the `specmill-reviewer` preset
 * through DSH's subagent service, waits for its answer, and returns the findings to the worker.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentOptions, type Config } from './config.ts'
import { OUTPUT_SCHEMA, parseReview, reviewPrompt } from './prompt.ts'
import { requestText, ticketOfSession } from './request.ts'
import { NotReviewable, reviewTarget, run, type Run } from './target.ts'

/** The agent preset each review runs under, declared in the bundle's `cordis.patch.yml`. */
export const REVIEWER_PRESET = 'specmill-reviewer'
/** The DSH subagent backend that starts a child with an empty conversation and supports an independent preset. */
export const SPAWN_PROVIDER = 'spawn'
export const TOOL_NAME = 'review_changes'

export const TOOL_DESCRIPTION = 'Start an independent reviewer that has never seen this conversation. It gets only what this ticket asked for '
  + '(the messages delivered to you) and the diff of the pushed head commit against the base branch, and it reads the repository itself. '
  + 'Takes no arguments: you cannot brief it. Call it once the PR is pushed and before you report ready, and again after you push fixes '
  + 'for its findings. Its findings are fallible input, not a gate: assess each one, fix the valid ones, and decline the rest with a '
  + 'brief reason. Record the reviewed head commit, the round number and what you did with each finding in orchestrator_report. '
  + 'Run at most 3 rounds per PR. Do not post the review on GitHub.'

/**
 * The part of DSH's subagent service (`ctx.subagents`, `@deepseek-ai/dsh-subagent`) this plugin uses. Typed here rather
 * than imported because the plugins build against 0.2.1-alpha.2 while the runtime is 0.2.1-rc.5, and only rc.5 has
 * `agentPreset` (pinned: dsh-subagent `lib/types/types.d.ts`, `SubagentActivationSpec` and `SubagentStartRequest`).
 */
export interface Subagents {
  startActivation(spec: {
    provider: string; label: string; signal: AbortSignal; delivery: 'caller'
    request: { prompt: { type: 'text'; text: string }[]; parent: Agent; cwd: string; agentPreset: string
      outputSchema: object; agentOptions?: Record<string, string> }
  }): Promise<{ childId: string; result: Promise<SubagentResult>; dispose(): Promise<void> }>
}
export interface SubagentResult {
  output: readonly { type: string; text?: string }[]
  structured?: unknown
  diagnostic?: string
  stopReason: string
}

export interface ReviewHost {
  readonly config: Config
  /** The subagent service, or undefined when the profile does not mount it. */
  subagents(): Subagents | undefined
  readonly run?: Run
}

/** Runs one review for the worker `agent`. Never throws: a review that cannot run returns `{ reviewed: false, reason }`. */
export async function reviewChanges(agent: Agent, host: ReviewHost, signal: AbortSignal): Promise<Record<string, unknown>> {
  const ticketId = ticketOfSession(agent.id)
  if (!ticketId) return { reviewed: false, reason: 'review_changes runs only in a dsh-superagent worker Session.' }
  const subagents = host.subagents()
  if (!subagents) return { reviewed: false, reason: 'The DSH subagent service is not mounted in this profile, so no reviewer can start.' }
  const cwd = agent.session.header.cwd
  if (!cwd) return { reviewed: false, reason: 'This Session has no working directory, so the change cannot be found.' }

  let target
  try { target = await reviewTarget(cwd, host.config.maxDiffChars, host.run ?? run, signal) }
  catch (error) {
    if (error instanceof NotReviewable) return { reviewed: false, reason: error.message }
    return { reviewed: false, reason: `Could not read the change: ${(error as Error).message}` }
  }
  const request = requestText(agent.session.snapshotEvents(), host.config.maxRequestChars)
  const prompt = reviewPrompt(request, target)

  const limit = AbortSignal.any([signal, AbortSignal.timeout(host.config.timeoutMinutes * 60_000)])
  const options = agentOptions(host.config)
  let activation
  try {
    activation = await subagents.startActivation({ provider: SPAWN_PROVIDER, label: `Clean review of ${target.head.slice(0, 12)}`,
      signal: limit, delivery: 'caller',
      request: { prompt: [{ type: 'text', text: prompt }], parent: agent, cwd, agentPreset: REVIEWER_PRESET, outputSchema: OUTPUT_SCHEMA,
        ...options ? { agentOptions: options } : {} } })
  } catch (error) {
    return { reviewed: false, reason: `The reviewer could not start: ${(error as Error).message}` }
  }
  const stop = () => { void activation.dispose().catch(() => undefined) }
  limit.addEventListener('abort', stop, { once: true })
  let result: SubagentResult
  try { result = await activation.result }
  catch (error) {
    return { reviewed: false, reason: limit.aborted && !signal.aborted
      ? `The review did not finish within ${host.config.timeoutMinutes} minutes.` : `The review failed: ${(error as Error).message}` }
  } finally { limit.removeEventListener('abort', stop) }

  const base = { reviewed_head: target.head, base: target.base, base_branch: target.baseBranch, ...target.pr ? { pr: target.pr } : {},
    reviewer_session: activation.childId, ...target.notes.length ? { notes: target.notes } : {} }
  const review = parseReview(result.structured)
  if (review) return { reviewed: true, ...base, ...review }
  const text = result.output.filter(block => block.type === 'text' && block.text).map(block => block.text).join('\n').trim()
  if (result.stopReason !== 'completed') {
    return { reviewed: false, ...base, reason: `The review ended early (${result.stopReason})${result.diagnostic ? `: ${result.diagnostic}` : '.'}`,
      ...text ? { partial_output: text } : {} }
  }
  return { reviewed: true, ...base, structured: false, output: text || '(the reviewer returned no text)' }
}
