/** Slack over Socket Mode: normalization, filters, idempotent replies, Block Kit approval, and health. */
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import { z } from 'zod'
import type { Address, ApprovalPrompt, ChatHost, ChatProvider, IncomingMessage, ProviderHealth, SendResult } from '../types.ts'

/** A message plus what the event envelope adds. Only the fields Spec Buddy reads are named. */
export interface SlackEvent {
  type?: string
  subtype?: string
  bot_id?: string
  app_id?: string
  user?: string
  text?: string
  ts?: string
  thread_ts?: string
  channel?: string
  channel_type?: string
  event_id?: string
  client_msg_id?: string
  user_profile?: { display_name?: string; real_name?: string }
  hidden?: boolean
}
/** The Socket Mode envelope around one event. */
export interface SlackEnvelope {
  event_id?: string
  team_id?: string
}
/** The callback shape Socket Mode passes to a named event listener. */
export interface SlackSocketPayload {
  ack?: () => Promise<void> | void
  event?: SlackEvent
  body?: SlackEnvelope
  retry_num?: number
}
/** The Block Kit action payload Slack sends inside an `interactive` envelope. */
export interface SlackInteractiveBody {
  type?: string
  user?: { id?: string; name?: string; username?: string }
  channel?: { id?: string }
  message?: { ts?: string; thread_ts?: string }
  actions?: { action_id?: string; value?: string }[]
}
/** Socket Mode passes the interactive payload as `body`; tests and older carriers may put it at the top level. */
export interface SlackInteractivePayload extends SlackInteractiveBody {
  ack?: () => Promise<void> | void
  body?: SlackInteractiveBody
}
/** The slice of the v8 `WebClient` Spec Buddy uses: methods are grouped, as in `web.chat.postMessage`. */
export interface SlackWeb {
  auth: { test(): Promise<{ user_id?: string; team?: string; url?: string; team_domain?: string }> }
  chat: { postMessage(input: { channel: string; text: string; thread_ts?: string; blocks?: unknown[]; mrkdwn?: boolean;
    unfurl_links?: boolean }): Promise<{ ok?: boolean; ts?: string; error?: string }> }
}
/** The slice of `SocketModeClient` Spec Buddy uses. */
export interface SlackSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  start(): Promise<unknown>
  disconnect(): Promise<void>
}
/** Injected platform clients, so tests can drive Slack without a network. */
export interface SlackDeps {
  web?: SlackWeb
  socket?: SlackSocket
}

export const SlackConfig = z.object({
  /** The app-level token (`xapp-`) for Socket Mode. */
  appToken: z.string().regex(/^xapp-/, { message: 'appToken must start with xapp-' }),
  /** The bot token (`xoxb-`) for Web API calls. */
  botToken: z.string().regex(/^xoxb-/, { message: 'botToken must start with xoxb-' }),
  /** Channels Spec Buddy listens in, by Slack channel id; empty means none. DMs are governed by `allowedUsers`. */
  channels: z.array(z.string().min(1)).default([]),
  /** Slack user ids allowed to talk to Spec Buddy; empty means nobody. */
  allowedUsers: z.array(z.string().min(1)).default([]),
}).strict()
export type SlackConfig = z.infer<typeof SlackConfig>

const GONE = /(?:channel_not_found|is_archived|thread_not_found|not_in_channel)/

/** Converts the model's Markdown into Slack's mrkdwn, leaving fenced code untouched. */
export function slackify(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```)/)
  return parts.map((part, index) => {
    if (index % 2 === 1) return part
    return part
      .replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, '*$1*')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '_$1_')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
  }).join('')
}

/**
 * Splits text at the longest natural boundary under `limit`: a paragraph, then a line, then a space, then a hard cut.
 * Every chunk is non-empty and at most `limit` characters.
 */
export function splitText(text: string, limit: number): string[] {
  if (limit <= 0) throw new Error('limit must be positive')
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1)
    const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')]
    const cut = candidates.find(index => index > limit / 4) ?? limit
    chunks.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/** Whether a Slack channel is one of the configured channel ids. */
const channelAllowed = (config: SlackConfig, channel: string): boolean => config.channels.length > 0 && config.channels.includes(channel)

/**
 * Normalizes one Slack event, or returns `undefined` when Spec Buddy must ignore it: its own messages, other bots,
 * edited or deleted messages, channels outside the list, users outside the list, and non-DM `message` events.
 */
export function normalizeSlackEvent(event: SlackEvent, envelope: SlackEnvelope, config: SlackConfig, botUserId: string | undefined,
  kind: 'mention' | 'message', now = new Date()): IncomingMessage | undefined {
  if (!event.channel || !event.user || !event.ts) return undefined
  if (event.bot_id || event.app_id || event.subtype) return undefined
  if (botUserId && event.user === botUserId) return undefined
  if (kind === 'message' && event.channel_type !== 'im') return undefined
  if (kind === 'mention' && !channelAllowed(config, event.channel)) return undefined
  if (!config.allowedUsers.includes(event.user)) return undefined
  const text = event.text?.trim()
  if (!text) return undefined
  // A DM has no root message to thread on: use the DM channel so the whole DM is one conversation. A real DM thread
  // (thread_ts) stays its own conversation.
  const thread = event.thread_ts ?? (event.channel_type === 'im' ? event.channel : event.ts)
  const seconds = Number(event.ts)
  return {
    provider: 'slack',
    conversation: event.channel,
    thread,
    id: envelope.event_id ?? event.event_id ?? event.client_msg_id ?? `slack:${event.channel}:${event.ts}`,
    messageId: event.ts,
    sender: { id: event.user, ...(event.user_profile?.display_name ?? event.user_profile?.real_name
      ? { name: (event.user_profile.display_name ?? event.user_profile.real_name)! } : {}) },
    addressed: true,
    text,
    at: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : now.toISOString(),
  }
}

/** Slack's own limits for one `chat.postMessage` text field; kept well below the API's 40k so threads stay readable. */
export const SLACK_MAX_LENGTH = 3900

/**
 * A Slack provider over Socket Mode. Socket Mode needs no public URL, which matters because DSH binds to 127.0.0.1.
 */
export class SlackProvider implements ChatProvider<SlackConfig> {
  readonly kind = 'slack'
  readonly schema = SlackConfig
  readonly maxLength = SLACK_MAX_LENGTH
  private web?: SlackWeb
  private socket?: SlackSocket
  private host?: ChatHost
  private botUserId?: string
  private teamUrl = ''
  private healthState: ProviderHealth = { state: 'starting', detail: 'Slack has not started' }
  private stopping = false
  constructor(private readonly config: SlackConfig, private readonly deps: SlackDeps = {},
    private readonly logger: { warn(message: string): void; error(message: string): void } = console) {}
  format(markdown: string): string[] { return splitText(slackify(markdown), this.maxLength) }
  link(address: Address): string {
    const channel = encodeURIComponent(address.conversation)
    // A channel thread is keyed by its root message ts; a root DM is keyed by the DM channel, which has no message ts.
    const messageTs = address.thread.includes('.') ? `&message_ts=${encodeURIComponent(address.thread)}` : ''
    if (!this.teamUrl) return `https://slack.com/app_redirect?channel=${channel}${messageTs}`
    return `${this.teamUrl.replace(/\/$/, '')}/app_redirect?channel=${channel}${messageTs}`
  }
  health(): ProviderHealth { return this.healthState }
  /** Authenticates, then listens for mentions, DMs, and approval buttons. */
  async start(host: ChatHost): Promise<void> {
    this.host = host
    this.stopping = false
    this.healthState = { state: 'starting', detail: 'Connecting to Slack' }
    this.web = this.deps.web ?? new WebClient(this.config.botToken) as unknown as SlackWeb
    const auth = await this.web.auth.test()
    this.botUserId = auth.user_id
    this.teamUrl = auth.url ?? (auth.team_domain ? `https://${auth.team_domain}.slack.com` : '')
    if (!this.botUserId) throw new Error('Slack auth.test did not return a bot user id')
    if (!this.config.allowedUsers.length) this.healthState = { state: 'error', detail: 'allowedUsers is empty, so Spec Buddy ignores every message' }
    this.socket = this.deps.socket ?? new SocketModeClient({ appToken: this.config.appToken }) as unknown as SlackSocket
    this.socket.on('app_mention', payload => { void this.event(payload as SlackSocketPayload, 'mention') })
    this.socket.on('message', payload => { void this.event(payload as SlackSocketPayload, 'message') })
    this.socket.on('interactive', payload => { void this.interactive(payload as SlackInteractivePayload) })
    this.socket.on('error', error => { this.fail(error) })
    await this.socket.start()
    if (!this.healthState.detail || this.healthState.detail === 'Connecting to Slack') {
      this.healthState = { state: 'ready', detail: 'Connected over Socket Mode' }
    }
  }
  /** Disconnects; safe to call after a failed start. */
  async stop(): Promise<void> {
    this.stopping = true
    const socket = this.socket
    this.socket = undefined
    if (socket) await socket.disconnect().catch(error => { this.logger.warn(`Slack disconnect failed: ${String(error)}`) })
  }
  async send(address: Address, text: string, _replyId: string): Promise<SendResult> {
    const web = this.web
    if (!web) return { status: 'gone' }
    const chunks = this.format(text)
    const threadTs = address.thread.includes('.') ? address.thread : undefined
    let first: string | undefined
    for (const chunk of chunks) {
      try {
        const result = await web.chat.postMessage({ channel: address.conversation, text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}),
          mrkdwn: true, unfurl_links: false })
        if (result.ok === false || result.error) {
          if (GONE.test(result.error ?? '')) return { status: 'gone' }
          throw new Error(`Slack chat.postMessage failed: ${result.error ?? 'unknown error'}`)
        }
        first ??= result.ts
      } catch (error) {
        if (GONE.test(String(error))) return { status: 'gone' }
        throw error
      }
    }
    return { status: 'sent', ...(first ? { messageId: first } : {}) }
  }
  /** Posts a Block Kit approval card; only the requester's press is accepted by the core. */
  async askApproval(address: Address, prompt: ApprovalPrompt): Promise<void> {
    const web = this.web
    if (!web) throw new Error('Slack is not running')
    const who = prompt.requester.name ? `${prompt.requester.name} (<@${prompt.requester.id}>)` : `<@${prompt.requester.id}>`
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `*Spec ready for approval*\n${prompt.summary}\n\nOnly ${who} can approve this spec.` } },
      { type: 'actions', block_id: 'spec_buddy_approval', elements: [{ type: 'button', action_id: 'spec_buddy_approve',
        style: 'primary', text: { type: 'plain_text', text: 'Approve spec' }, value: JSON.stringify({ specId: prompt.specId }) }] },
    ]
    const threadTs = address.thread.includes('.') ? address.thread : undefined
    const result = await web.chat.postMessage({ channel: address.conversation, ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `Spec ready for approval. Only <@${prompt.requester.id}> can approve; or reply "hand off".`, blocks, mrkdwn: true })
    if (result.ok === false || result.error) throw new Error(`Slack approval message failed: ${result.error ?? 'unknown error'}`)
  }
  /** Acknowledges first, then normalizes and hands the message to the core; a failure becomes health, never an unhandled rejection. */
  private async event(payload: SlackSocketPayload, kind: 'mention' | 'message'): Promise<void> {
    try {
      await payload.ack?.()
      const event = payload.event
      if (!event || !this.host) return
      const message = normalizeSlackEvent(event, payload.body ?? {}, this.config, this.botUserId, kind)
      if (!message) return
      await this.host.receive(message)
      this.healthState = { state: 'ready', detail: 'Connected over Socket Mode' }
    } catch (error) { this.fail(error) }
  }
  /** Handles a Block Kit approval press; the core checks that the presser is the requester. */
  private async interactive(payload: SlackInteractivePayload): Promise<void> {
    try {
      await payload.ack?.()
      const data = payload.body ?? payload
      if (data.type !== 'block_actions' || !this.host) return
      const action = data.actions?.find(item => item.action_id === 'spec_buddy_approve')
      if (!action) return
      const channel = data.channel?.id, user = data.user?.id
      if (!channel || !user) return
      // A root DM's conversation is the DM channel; its approval card's message ts is not the conversation thread.
      const thread = data.message?.thread_ts ?? (channel.startsWith('D') ? channel : data.message?.ts)
      if (!thread) return
      const parsed = z.object({ specId: z.string().min(1) }).safeParse(JSON.parse(action.value ?? '{}'))
      if (!parsed.success) return
      await this.host.approved({ provider: this.kind, conversation: channel, thread }, parsed.data.specId,
        { id: user, ...(data.user?.name ?? data.user?.username ? { name: (data.user.name ?? data.user.username)! } : {}) })
    } catch (error) { this.fail(error) }
  }
  private fail(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    if (this.stopping) return
    this.healthState = { state: 'error', detail }
    this.logger.error(`Slack provider error: ${detail}`)
  }
}
