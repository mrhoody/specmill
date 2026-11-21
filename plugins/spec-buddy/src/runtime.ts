/** The core runtime: state, the provider registry, Sessions, the spec tools, approval, and health. */
import type { Context } from '@deepseek-ai/cordis'
import { loadAssets } from './assets.ts'
import type { Config } from './config.ts'
import { Conversations } from './conversations.ts'
import { Handoff } from './handoff.ts'
import { conversationKey, sessionIdOf } from './ids.ts'
import type { ConversationRecord, Health } from './model.ts'
import { ChatProviders } from './service.ts'
import { approvalProblem, isApprovalCommand } from './spec.ts'
import { StateLock, StateStore } from './store.ts'
import { approvalNotice, specTools } from './tools.ts'
import type { Address, IncomingMessage, Sender } from './types.ts'

const now = (): string => new Date().toISOString()
const PROVIDER_HEALTH_MS = 5 * 60_000

/** What the health route returns; `scripts/spec-buddy status` reads it. */
export interface HealthView {
  runtime: Health
  github: Health
  state: Health
  sessions: Health
  providers: Record<string, Health>
  summary: { conversations: number; filed: number; approved: number }
  at: string
}

/**
 * Owns everything that lives for the plugin's lifetime. It acquires the state lock before reading state, wires the
 * provider service to conversation handling, and exposes health without leaking tokens or message text.
 */
export class Runtime {
  readonly store: StateStore
  readonly providers: ChatProviders
  readonly handoff: Handoff
  readonly conversations: Conversations
  private readonly lock: StateLock
  private readonly lifetime = new AbortController()
  private readonly health: { runtime: Health; github: Health; state: Health; sessions: Health }
  private timer?: NodeJS.Timeout
  private stopped = false
  /** Inbound events are handled one at a time: a first message establishes the requester before the next is judged. */
  private inbound: Promise<void> = Promise.resolve()
  constructor(private readonly ctx: Context, private readonly config: Config) {
    this.health = {
      runtime: { state: 'starting', detail: 'Starting Spec Buddy' },
      github: { state: 'starting', detail: 'Checking the gh identity' },
      state: { state: 'starting', detail: config.stateDir },
      sessions: { state: 'ready', detail: 'No Session delivery has failed' },
    }
    this.lock = StateLock.acquire(config.stateDir, error => {
      this.health.runtime = { state: 'error', detail: `Lost the state directory lock: ${error.message}`, at: now() }
      this.lifetime.abort()
    })
    try {
      this.store = new StateStore(config.stateDir)
      this.providers = new ChatProviders(this.store)
      this.handoff = new Handoff(config, this.store, this.providers)
      const assets = loadAssets()
      this.conversations = new Conversations({
        context: ctx, store: this.store, providers: this.providers, config, lifetime: this.lifetime.signal,
        prompt: assets.prompt, skill: assets.skill,
        tools: (_agent, conversation) => specTools(conversation, { config, store: this.store, providers: this.providers, handoff: this.handoff }),
        failed: error => { this.health.sessions = { state: 'error', detail: error instanceof Error ? error.message : String(error), at: now() } },
      })
      this.providers.consume(message => this.onMessage(message), (address, specId, sender) => this.approve(address, specId, sender, 'button'))
      this.conversations.install()
      this.health.state = { state: 'ready', detail: config.stateDir, at: now() }
      this.health.runtime = { state: 'ready', detail: 'Spec Buddy is listening', at: now() }
      void this.checkGithub()
      this.timer = setInterval(() => { void this.checkGithub() }, PROVIDER_HEALTH_MS)
      this.timer.unref()
    } catch (error) {
      this.lock.free()
      throw error
    }
  }
  /** The current health view, including every provider and the GitHub identity check. */
  view(): HealthView {
    return { runtime: this.health.runtime, github: this.health.github, state: this.health.state, sessions: this.health.sessions,
      providers: this.providers.health(), summary: this.store.summary(), at: now() }
  }
  /** Stops timers and Sessions bindings, and releases the state lock. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.lifetime.abort()
    this.conversations.dispose()
    this.lock.free()
    this.health.runtime = { state: 'error', detail: 'Spec Buddy stopped', at: now() }
  }
  /** Rechecks `gh api user` and records the result for the route. */
  async checkGithub(): Promise<void> {
    const { health } = await this.handoff.identity()
    if (!this.stopped) this.health.github = health
  }
  /** Handles one normalized inbound message exactly once, in arrival order. */
  onMessage(message: IncomingMessage): Promise<void> {
    const run = this.inbound.then(() => this.accept(message))
    this.inbound = run.catch(() => {})
    return run
  }
  private async accept(message: IncomingMessage): Promise<void> {
    if (this.store.hasEvent(message.id)) return
    this.store.recordEvent(message.id)
    if (isApprovalCommand(message.text)) { await this.approveFromText(message); return }
    const record = this.conversationFor(message)
    this.store.saveConversation(record)
    await this.conversations.deliver(record, message.id, this.conversations.inboundText(record, message))
  }
  /** The conversation a message belongs to, created with its requester on first sight. */
  private conversationFor(message: IncomingMessage): ConversationRecord {
    const key = conversationKey(message)
    const existing = this.store.conversation(key)
    if (existing) return { ...existing, updatedAt: now() }
    const address: Address = { provider: message.provider, conversation: message.conversation, thread: message.thread }
    return {
      key,
      provider: message.provider,
      conversation: message.conversation,
      thread: message.thread,
      sessionId: sessionIdOf(key),
      requester: message.sender,
      channelUrl: message.url ?? this.providers.link(address),
      createdAt: now(),
      updatedAt: now(),
    }
  }
  /** A text approval command (`hand off`); the sender must be the person who started the conversation. */
  private async approveFromText(message: IncomingMessage): Promise<void> {
    const key = conversationKey(message)
    const record = this.store.conversation(key)
    if (!record) {
      await this.note(message, 'There is no spec in this thread yet. Mention me with the idea to start one.', `approval-missing:${message.id}`)
      return
    }
    await this.approve({ provider: record.provider, conversation: record.conversation, thread: record.thread },
      record.draft?.specId ?? '', message.sender, 'text')
  }
  /** Records an approval from a button or a text command, then tells the Session to hand off. */
  private async approve(address: Address, specId: string, sender: Sender, via: 'button' | 'text'): Promise<void> {
    const key = conversationKey(address)
    const record = this.store.conversation(key)
    if (!record) return
    const problem = !record.draft
      ? 'There is no draft spec to approve yet.'
      : specId && record.draft.specId !== specId
        ? 'The draft changed after the approval was requested. Ask for approval again.'
        : approvalProblem(record, sender)
    if (problem) {
      await this.note(address, problem, `approval-refused:${specId || record.draft?.specId || 'none'}:${sender.id}`)
      return
    }
    const draft = record.draft!
    const updated: ConversationRecord = { ...record, approval: { specId: draft.specId, by: sender.id, at: now(), via }, updatedAt: now() }
    this.store.saveConversation(updated)
    await this.note(address, `Approved by ${sender.name ?? sender.id}.`,
      `approval-ack:${draft.specId}:${sender.id}`)
    // The Session files the issue through spec_handoff, so it needs a turn that says approval arrived.
    await this.conversations.deliver(updated, `approval:${draft.specId}:${sender.id}`, approvalNotice(updated, sender))
  }
  /** Posts a short thread note once per reply id; a failed note is logged, never thrown into a provider loop. */
  private async note(address: Address, text: string, replyId: string): Promise<void> {
    try { await this.providers.send(address, text, replyId) }
    catch (error) { this.ctx.logger.warn('spec-buddy could not post an approval note: %s', String(error)) }
  }
}
