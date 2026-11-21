/** The `chatProviders` service: registration, idempotent sends, inbound dispatch, and per-provider health. */
import type { ChatHost, Address, ApprovalPrompt, ChatProvider, IncomingMessage, ProviderHealth, SendReceipt, SendResult, Sender } from './types.ts'
import type { Health } from './model.ts'
import type { StateStore } from './store.ts'

/** How the core consumes normalized messages. */
export type MessageHandler = (message: IncomingMessage) => Promise<void>
/** How the core accepts an approval button press. */
export type ApprovalHandler = (address: Address, specId: string, sender: Sender) => Promise<void>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Registered chat platforms; core and provider plugins meet here. */
    chatProviders: ChatProviders
  }
}

const now = (): string => new Date().toISOString()

/**
 * Owns every registered chat platform. A provider plugin registers here on start and unregisters on disposal; the
 * core uses this service for replies and approval prompts, and never names a platform itself.
 */
export class ChatProviders {
  private readonly providers = new Map<string, ChatProvider<unknown>>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, string>()
  private handler: MessageHandler = async () => {}
  private approval: ApprovalHandler = async () => {}
  private inbound: Health = { state: 'ready', detail: 'No inbound message has failed' }
  readonly host: ChatHost
  constructor(private readonly store: StateStore) {
    this.host = {
      receive: message => this.receive(message),
      approved: (address, specId, sender) => this.approval(address, specId, sender),
    }
  }
  /** Wires the core's inbound and approval handlers before any provider starts. */
  consume(handler: MessageHandler, approval: ApprovalHandler): void {
    this.handler = handler
    this.approval = approval
  }
  /**
   * Registers a provider and starts it. Returns the async disposer that stops it and removes it; a started provider
   * that fails later stays registered so its error remains visible in health.
   */
  register<C>(provider: ChatProvider<C>): () => Promise<void> {
    if (this.providers.has(provider.kind)) throw new Error(`Chat provider already registered: ${provider.kind}`)
    this.providers.set(provider.kind, provider as ChatProvider<unknown>)
    this.failures.delete(provider.kind)
    this.starting.set(provider.kind, this.start(provider))
    return async () => {
      await this.starting.get(provider.kind)
      this.starting.delete(provider.kind)
      this.providers.delete(provider.kind)
      this.failures.delete(provider.kind)
      await provider.stop?.()
    }
  }
  private async start(provider: ChatProvider<unknown>): Promise<void> {
    try {
      await provider.start?.(this.host)
      const health = provider.health?.()
      if (health?.state === 'error') this.failures.set(provider.kind, health.detail)
      else this.failures.delete(provider.kind)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.failures.set(provider.kind, `The ${provider.kind} provider failed to start: ${detail}`)
      try { await provider.stop?.() } catch { /* Startup already failed; the first failure is the reported one. */ }
    }
  }
  /** Resolves once the provider's start attempt settled; used by tests and startup checks. */
  async ready(kind: string): Promise<void> { await this.starting.get(kind) }
  get(kind: string): ChatProvider<unknown> | undefined { return this.providers.get(kind) }
  kinds(): string[] { return [...this.providers.keys()].sort() }
  /** Every provider's current health for the health route, the registry's inbound loop included. */
  health(): Record<string, Health> {
    const entries: Record<string, Health> = {}
    for (const kind of this.kinds()) {
      const failure = this.failures.get(kind)
      const reported = this.providers.get(kind)?.health?.()
      entries[kind] = failure ? { state: 'error', detail: failure, at: now() } : healthEntry(reported)
    }
    entries.inbound = this.inbound
    return entries
  }
  /** Whether any provider is registered. */
  get size(): number { return this.providers.size }
  /** Sends idempotently per `replyId`; a throw from the provider is retryable and leaves no receipt. */
  async send(address: Address, text: string, replyId: string): Promise<SendResult> {
    const id = `${address.provider}:${replyId}`
    const receipt = this.store.receipt(id)
    if (receipt) return receipt.status === 'sent' ? { status: 'sent', ...(receipt.messageId ? { messageId: receipt.messageId } : {}) } : { status: 'gone' }
    const provider = this.providers.get(address.provider)
    if (!provider) return { status: 'gone' }
    const result = await provider.send(address, text, replyId)
    const saved: SendReceipt = { status: result.status, ...(result.messageId ? { messageId: result.messageId } : {}), at: now() }
    this.store.saveReceipt(id, saved)
    return result
  }
  /** Posts an approval request once per spec, with the platform's buttons where it has them. */
  async askApproval(address: Address, prompt: ApprovalPrompt): Promise<void> {
    const id = `${address.provider}:approval:${prompt.specId}`
    if (this.store.receipt(id)) return
    const provider = this.providers.get(address.provider)
    if (!provider) throw new Error(`No chat provider named ${address.provider} is registered`)
    await provider.askApproval(address, prompt)
    this.store.saveReceipt(id, { status: 'sent', at: now() })
  }
  link(address: Address): string { return this.providers.get(address.provider)?.link(address) ?? '' }
  /** Delivers one normalized message to the core; a failure is recorded in `inbound` health and rethrown to the caller. */
  async receive(message: IncomingMessage): Promise<void> {
    try {
      await this.handler(message)
      this.inbound = { state: 'ready', detail: 'No inbound message has failed' }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.inbound = { state: 'error', detail, at: now() }
      throw error
    }
  }
  /** The provider's own entry, including a loop failure it reported. */
  providerHealth(kind: string): ProviderHealth | undefined { return this.providers.get(kind)?.health?.() }
}

function healthEntry(reported: ProviderHealth | undefined): Health {
  if (!reported) return { state: 'ready', detail: '' }
  return { state: reported.state, detail: reported.detail, at: now() }
}
