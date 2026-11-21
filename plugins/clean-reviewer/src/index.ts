/**
 * Specmill's clean-context reviewer for dsh-superagent. Registers `review_changes` on each worker Session; the tool starts
 * a reviewer with an empty conversation whose only input this plugin builds. dsh-superagent is used unchanged.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { Config } from './config.ts'
import { ticketOfSession } from './request.ts'
import { reviewChanges, TOOL_DESCRIPTION, TOOL_NAME, type ReviewHost, type Subagents } from './review.ts'

export const name = 'clean-reviewer'
// Cordis only lets a plugin read services it injects; dsh-base always mounts `subagents` (@deepseek-ai/dsh-subagent).
export const inject = ['tools', 'subagents']
export { Config }

export function apply(ctx: Context, config: Config): void {
  const host: ReviewHost = {
    config,
    subagents: () => (ctx as unknown as { subagents?: Subagents }).subagents,
  }
  const registrations = new Map<Agent, () => void>()
  ctx.on('agent/created', ({ agent }) => { decorate(agent, host, registrations); return undefined })
  ctx.on('agent/disposed', ({ agent }) => { registrations.get(agent)?.(); registrations.delete(agent) })
  ctx.effect(() => () => { for (const dispose of registrations.values()) dispose(); registrations.clear() })
  ctx.logger.info('clean-reviewer ready: dsh-superagent workers get %s', TOOL_NAME)
}

/** Gives a dsh-superagent worker Session the review tool; other Sessions, including the worker's subagents, get nothing. */
export function decorate(agent: Agent, host: ReviewHost, registrations: Map<Agent, () => void>): boolean {
  if (registrations.has(agent) || ticketOfSession(agent.id) === undefined) return false
  // Registered in the agent's own scope, which dsh-superagent's tool allowlist for workers does not mask.
  const dispose = agent.ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: z.toJSONSchema(z.object({}).strict()),
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    execute: (_args: unknown, execution: { signal: AbortSignal }) => reviewChanges(agent, host, execution.signal),
  })
  registrations.set(agent, dispose)
  return true
}

export { reviewPrompt, parseReview, OUTPUT_SCHEMA } from './prompt.ts'
export { requestText, ticketOfSession } from './request.ts'
export { reviewTarget, NotReviewable } from './target.ts'
export { reviewChanges, REVIEWER_PRESET, TOOL_NAME } from './review.ts'
export type { Config as CleanReviewerConfig } from './config.ts'
