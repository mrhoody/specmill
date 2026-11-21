/** The Slack provider plugin: Socket Mode in, the platform-neutral `chatProviders` service out. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from './service.ts'
import { SlackConfig, SlackProvider } from './providers/slack.ts'

export const name = 'spec-buddy-slack-watch'
export const inject = ['chatProviders']
export { SlackConfig as Config }
export type { SlackConfig as SlackWatchConfig } from './providers/slack.ts'

export async function apply(ctx: Context, config: SlackConfig): Promise<void> {
  const logger = {
    warn: (message: string) => { ctx.logger.warn(message) },
    error: (message: string) => { ctx.logger.error(message) },
  }
  const unregister = ctx.chatProviders.register(new SlackProvider(config, {}, logger))
  ctx.effect(() => unregister)
  ctx.logger.info('spec-buddy Slack provider registered for %d users in %d channels', config.allowedUsers.length, config.channels.length)
}
