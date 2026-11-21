/** Idempotent message delivery to Spec Buddy's DSH Sessions across restarts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'spec-buddy': { kind: 'spec-buddy' } & ContextFormed
  }
}

type Seen = { ids: Set<string>; loaded?: Promise<void> }
/** The durable message id for one request id; the same on every retry. */
export const messageId = (requestId: string): MessageId => MessageId(`spec-buddy:${requestId}`)

function deliveryId(message: UserMessage): string | undefined {
  const source: { kind: string; plugin?: unknown } = message.source
  if (source.kind === 'spec-buddy' || (source.kind === 'plugin' && source.plugin === 'spec-buddy')) return message.id
}

/**
 * Delivers messages at most once per request id across active and restored Sessions, and marks them with Spec Buddy's
 * own source so they are never mistaken for a person's message typed into the Session.
 */
export class AgentDelivery {
  private readonly seen = new WeakMap<Session, Seen>()
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const id = deliveryId(event.data)
      if (id) this.seen.get(session)?.ids.add(id)
    })
  }
  private async history(agent: Agent): Promise<Seen> {
    let seen = this.seen.get(agent.session)
    if (!seen) { seen = { ids: new Set() }; this.seen.set(agent.session, seen) }
    const state = seen
    state.loaded ??= (async () => {
      await this.ctx.sessionPersistence.flush()
      await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      for (let offset = 0; ; ) {
        const { events } = await handle.read(offset, 512)
        if (!events.length) break
        for (const event of events) {
          if (event.type !== 'user/message') continue
          const id = deliveryId(event.data)
          if (id) state.ids.add(id)
        }
        offset += events.length
      }
    })().catch(error => { state.loaded = undefined; throw error })
    await state.loaded
    return state
  }
  /** Delivers once; `queue` appends to the next turn and `steer` joins the current step's steering. */
  async send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer', signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const seen = await this.history(agent)
    signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    const id = messageId(requestId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
    if (!seen.ids.has(id) && !pending) {
      const message = freezeMessage({ id, role: 'user' as const, content: [{ type: 'text' as const, text }],
        source: { kind: 'spec-buddy' as const, form: 'relay' as const } })
      if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
    }
    await this.ctx.sessionPersistence.flush()
  }
}
