/** Spec Buddy's core plugin: the state lock, the `chatProviders` service, conversations, the spec tools, and health. */
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import { registerHealth } from './http.ts'
import { Runtime } from './runtime.ts'

export const name = 'spec-buddy'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'tools', 'systemPrompt', 'skills', 'webServer']
export { Config }
export async function apply(ctx: Context, config: Config): Promise<void> {
  const runtime = new Runtime(ctx, config)
  // Release the lock and timer first: a later registration that throws must not leave them behind.
  ctx.effect(() => () => runtime.stop())
  // The platform-neutral service providers register with; consumers inject `chatProviders`, never a platform name.
  ctx.effect(() => ctx.provide('chatProviders', runtime.providers))
  ctx.effect(() => registerHealth(ctx, runtime))
  ctx.logger.info('spec-buddy ready; health at http://127.0.0.1:%d/spec-buddy/api/health', ctx.webServer.port)
}
export { conversationKey, sessionIdOf, specIdOf } from './ids.ts'
export { draftProblem, handoffProblem, renderIssue, SPEC_SECTIONS } from './spec.ts'
export { ChatProviders } from './service.ts'
export type { Address, ApprovalPrompt, ChatHost, ChatProvider, IncomingMessage, ProviderHealth, SendResult, Sender } from './types.ts'
export type { Config as SpecBuddyConfig } from './config.ts'
