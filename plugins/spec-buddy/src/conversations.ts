/** Creates, resumes, decorates, and replies to the DSH Session of each Spec Buddy conversation. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { z } from 'zod'
import { modelSelection, type Config } from './config.ts'
import { AgentDelivery } from './delivery.ts'
import type { ConversationRecord } from './model.ts'
import type { ChatProviders } from './service.ts'
import type { StateStore } from './store.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** The agent preset every Spec Buddy Session runs under, declared in the bundle's `cordis.patch.yml`. */
export const BUDDY_PRESET = 'specmill-spec-buddy'
/** The skill the buddy loads for the spec template. */
export const SPEC_SKILL = 'spec-writing'

export interface ConversationsHost {
  readonly context: Context
  readonly store: StateStore
  readonly providers: ChatProviders
  readonly config: Config
  readonly lifetime: AbortSignal
  /** The role and working rules added to every buddy Session's system prompt. */
  readonly prompt: string
  /** The `spec-writing` skill body and description. */
  readonly skill: { content: string; description: string; path: string }
  /** The three Spec Buddy tools, bound to one conversation. */
  tools(agent: Agent, conversation: ConversationRecord): Tool[]
  /** Reports a background failure to the health board. */
  failed(error: unknown): void
}

interface Binding { disposers: (() => void)[] }

const now = (): string => new Date().toISOString()

/**
 * Owns the Session lifecycle: deterministic ids from the conversation key, resumption after restart, the buddy's
 * prompt/skill/tools, and posting each turn's final text back to the thread.
 */
export class Conversations {
  private readonly delivery: AgentDelivery
  private readonly bindings = new Map<Agent, Binding>()
  /** One open per Session at a time, so two messages arriving together do not both create it. */
  private readonly opening = new Map<string, Promise<Agent>>()
  constructor(private readonly host: ConversationsHost) {
    this.delivery = new AgentDelivery(host.context)
  }
  /** Subscribes to agent lifecycle so restored Sessions are decorated and idle turns are posted. Call once. */
  install(): void {
    const ctx = this.host.context
    ctx.on('agent/created', async ({ agent }) => {
      const conversation = this.host.store.conversationForSession(agent.id)
      if (conversation) await this.decorate(agent, conversation)
      return undefined
    })
    ctx.on('agent/disposed', ({ agent }) => this.release(agent))
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || this.host.lifetime.aborted) return
      if (!this.host.store.conversationForSession(agent.id)) return
      void this.postFinal(agent).catch(error => this.host.failed(error))
    })
  }
  /** Resolves or creates the conversation's Session, applies the preset and model, and decorates it. */
  async ensure(conversation: ConversationRecord): Promise<Agent> {
    const running = this.opening.get(conversation.sessionId)
    if (running) return running
    const work = this.open(conversation)
    this.opening.set(conversation.sessionId, work)
    try { return await work } finally { this.opening.delete(conversation.sessionId) }
  }
  private async open(conversation: ConversationRecord): Promise<Agent> {
    const ctx = this.host.context
    const sessionId = conversation.sessionId as SessionId
    let result = await ctx.sessionController.resolveAgent(sessionId)
    let created = false
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(this.host.config.repoCheckout)
      await ctx.sessionController.create({ sessionId, workspaceId: workspace.id, agentPreset: BUDDY_PRESET })
      result = await ctx.sessionController.resolveAgent(sessionId)
      created = true
    }
    if ('error' in result) throw result.error
    const agent = result.agent
    // Model selection and the title belong to a new Session; resuming one must not append a rename on every message.
    if (created) {
      const selection = modelSelection(this.host.config.model)
      if (selection) {
        try { await ctx.sessionController.selectModel({ sessionId, ...selection }) }
        catch (error) { ctx.logger.warn('spec-buddy could not select model %s: %s', this.host.config.model, String(error)) }
      }
      await ctx.sessionController.rename({ sessionId, title: `Spec Buddy · ${conversation.thread}` })
    }
    await this.decorate(agent, conversation)
    return agent
  }
  /** Delivers one inbound message once, keyed by its event id. */
  async deliver(conversation: ConversationRecord, requestId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    const agent = await this.ensure(conversation)
    await this.delivery.send(agent, requestId, text, mode, this.host.lifetime)
  }
  /** Releases prompt, skill, and tool registrations for every Session. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
  /** The provider-facing text for one inbound message: who said it and where. */
  inboundText(conversation: ConversationRecord, message: { sender: { id: string; name?: string }; text: string; url?: string; at: string }): string {
    const who = message.sender.name ? `${message.sender.name} (${message.sender.id})` : message.sender.id
    const where = message.url ?? this.host.providers.link(conversation)
    return `[${where}]\n${who} wrote at ${message.at}:\n\n${message.text}`
  }
  /** Posts the last assistant message of the latest turn once, then records how far the thread has been answered. */
  private async postFinal(agent: Agent): Promise<void> {
    const conversation = this.host.store.conversationForSession(agent.id)
    if (!conversation) return
    const events = agent.session.snapshotEvents()
    const last = events.filter(event => event.type === 'assistant/message').at(-1)
    const seq = Number(agent.session.seq)
    const lastPosted = conversation.lastPostedSeq ?? 0
    if (!last || Number(last.seq) <= lastPosted) {
      if (seq > lastPosted) this.host.store.saveConversation({ ...conversation, lastPostedSeq: seq, updatedAt: now() })
      return
    }
    const text = last.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
      : ''
    if (text) {
      const address = { provider: conversation.provider, conversation: conversation.conversation, thread: conversation.thread }
      const result = await this.host.providers.send(address, text, `turn:${conversation.sessionId}:${last.seq}`)
      if (result.status === 'gone') this.host.context.logger.warn('spec-buddy could not post a turn to %s; the thread is gone', conversation.key)
    }
    const current = this.host.store.conversation(conversation.key) ?? conversation
    this.host.store.saveConversation({ ...current, lastPostedSeq: seq, updatedAt: now() })
  }
  private async decorate(agent: Agent, conversation: ConversationRecord): Promise<void> {
    if (this.bindings.has(agent)) return
    const binding: Binding = { disposers: [] }
    this.bindings.set(agent, binding)
    const host = this.host
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'spec-buddy-role', order: 9990, interpolate: false,
      text: `${host.prompt}\n\nThis conversation is ${conversation.key}. The person who asked is ${conversation.requester.name ?? conversation.requester.id} (${conversation.requester.id}); only they can approve the spec.` }))
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.disposers.push(scope.skills.register({ name: SPEC_SKILL, description: host.skill.description, content: host.skill.content,
        source: 'bundled', resourceBase: { kind: 'directory', path: host.skill.path } }))
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { host.context.logger.warn('spec-buddy could not release a skill scope: %s', String(error)) }) })
    await skillScope
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, conversation)) register(tool.name, tool.description, tool.schema, tool.execute)
  }
  /** Registers a tool in the agent's scope and renders its JSON result as text. */
  private registerTool(agent: Agent, binding: Binding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
        execute: (args: unknown, execution: { signal: AbortSignal }) => execute(schema.parse(args), execution.signal) }))
    }
  }
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.host.context.logger.warn('spec-buddy could not release a Session registration: %s', String(error)) }
    }
  }
}
