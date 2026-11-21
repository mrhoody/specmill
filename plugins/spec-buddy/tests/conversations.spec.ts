/** Session resumption, one-shot delivery, and posting a turn's final text. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BUDDY_PRESET, Conversations } from '../src/conversations.ts'
import type { ConversationRecord } from '../src/model.ts'
import { ChatProviders } from '../src/service.ts'
import type { StateStore } from '../src/store.ts'
import { FakeProvider, conversation, tempState } from './helpers.ts'

let store: StateStore
let cleanup: () => void
beforeEach(() => { const temp = tempState(); store = temp.store; cleanup = temp.cleanup })
afterEach(() => cleanup())

const config = { stateDir: '/tmp/state', repoCheckout: '/tmp/repo',
  github: { repo: 'acme/widgets', agentLogin: 'superagent', configDir: '/tmp/gh' } }

function fixture(record: ConversationRecord = conversation()) {
  const messages: { id: string; source: { kind: string } }[] = []
  const events: unknown[] = [{ type: 'assistant/message', seq: 5,
    data: { message: { content: [{ type: 'text', text: 'The spec is ready for your review.' }] } } }]
  const handlers = new Map<string, (payload: unknown) => void>()
  const creates: unknown[] = [], renames: unknown[] = []
  let live = true
  const agent = {
    id: record.sessionId,
    status: 'idle',
    inbox: { nextTurn: messages, nextStep: [] },
    session: { seq: 5, snapshotEvents: () => events },
    followup(message: { id: string; source: { kind: string } }) { messages.push(message) },
    steer() {},
    ctx: {
      systemPrompt: { section: () => () => {} },
      inject(_names: string[], callback: (scope: unknown) => unknown) {
        const scope = { skills: { register: () => () => {} }, dispose: async () => {} }
        return Object.assign(Promise.resolve(callback(scope)), { dispose: async () => {} })
      },
      tools: { register: () => () => {} },
    },
  }
  const ctx = {
    on(event: string, handler: (payload: unknown) => void) { handlers.set(event, handler); return () => {} },
    logger: { warn() {}, info() {}, error() {} },
    agents: { get: (id: string) => id === agent.id ? agent : undefined },
    sessionPersistence: { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }),
      [Symbol.asyncDispose]: async () => {} }) },
    workspaceRegistry: { create: async (path: string) => ({ id: 'ws', path }) },
    sessionController: {
      resolveAgent: async (id: string) => id === agent.id && live ? { agent } : { error: { code: 'session/not-found' } },
      create: async (request: unknown) => { creates.push(request); live = true },
      rename: async (request: unknown) => { renames.push(request) },
      selectModel: async () => {},
    },
  }
  const provider = new FakeProvider()
  const providers = new ChatProviders(store)
  providers.register(provider)
  const conversations = new Conversations({ context: ctx as unknown as Context, store, providers, config,
    lifetime: new AbortController().signal, prompt: 'prompt', skill: { content: 'skill', description: 'spec', path: '/tmp' },
    tools: () => [], failed: error => { throw error } })
  conversations.install()
  return { agent, providers, provider, conversations, handlers, creates, renames, setLive: (value: boolean) => { live = value } }
}

describe('conversation sessions', () => {
  it('creates the Session under the Spec Buddy preset, and resumes it without renaming again', async () => {
    const { conversations, creates, renames, setLive } = fixture()
    setLive(false)
    await conversations.ensure(conversation())
    expect(creates).toEqual([{ sessionId: 'spec-buddy:abc', workspaceId: 'ws', agentPreset: BUDDY_PRESET }])
    expect(renames).toHaveLength(1)
    setLive(true)
    await conversations.ensure(conversation())
    expect(creates).toHaveLength(1)
    expect(renames).toHaveLength(1)
  })
  it('delivers an event once even when the provider repeats it', async () => {
    const { conversations, agent } = fixture()
    await conversations.deliver(conversation(), 'Ev1', 'we need rate limiting')
    await conversations.deliver(conversation(), 'Ev1', 'we need rate limiting')
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })
  it('posts the last assistant message once and remembers how far the thread is answered', async () => {
    const { conversations, provider, handlers, agent } = fixture()
    store.saveConversation(conversation())
    await conversations.ensure(conversation())
    handlers.get('agent/status')!({ agent, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(provider.sent[0]?.text).toBe('The spec is ready for your review.')
    expect(store.conversation('fake:C1:T1')?.lastPostedSeq).toBe(5)
    handlers.get('agent/status')!({ agent, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(provider.sent).toHaveLength(1)
  })
})
