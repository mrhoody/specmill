import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatProviders } from '../src/service.ts'
import type { StateStore } from '../src/store.ts'
import { FakeProvider, address, tempState } from './helpers.ts'

let store: StateStore
let cleanup: () => void
beforeEach(() => { const temp = tempState(); store = temp.store; cleanup = temp.cleanup })
afterEach(() => cleanup())

const registry = (provider = new FakeProvider()) => ({ provider, providers: new ChatProviders(store) })

describe('chat provider registry', () => {
  it('registers on start, unregisters when disposed, and refuses a duplicate kind', async () => {
    const { provider, providers } = registry()
    const dispose = providers.register(provider)
    await providers.ready('fake')
    expect(provider.started).toBe(1)
    expect(providers.kinds()).toEqual(['fake'])
    expect(() => providers.register(new FakeProvider())).toThrow('already registered')
    await dispose()
    expect(provider.stopped).toBe(1)
    expect(providers.kinds()).toEqual([])
  })
  it('sends idempotently per reply id and keeps a gone receipt', async () => {
    const { provider, providers } = registry()
    providers.register(provider)
    await providers.ready('fake')
    expect(await providers.send(address, 'hello', 'r1')).toMatchObject({ status: 'sent', messageId: 'm1' })
    expect(await providers.send(address, 'hello again', 'r1')).toMatchObject({ status: 'sent' })
    expect(provider.sent).toHaveLength(1)
    provider.result = { status: 'gone' }
    expect(await providers.send(address, 'hello', 'r2')).toEqual({ status: 'gone' })
    expect(await providers.send(address, 'hello', 'r2')).toEqual({ status: 'gone' })
    expect(provider.sent).toHaveLength(2)
  })
  it('treats a provider throw as retryable and records no receipt', async () => {
    const { provider, providers } = registry()
    providers.register(provider)
    await providers.ready('fake')
    provider.failure = new Error('rate limited')
    expect(provider.failure).toBeInstanceOf(Error)
    await expect(providers.send(address, 'hello', 'r1')).rejects.toThrow('rate limited')
    provider.failure = undefined
    expect(await providers.send(address, 'hello', 'r1')).toMatchObject({ status: 'sent' })
    expect(provider.sent).toHaveLength(1)
  })
  it('asks for approval once per draft', async () => {
    const { provider, providers } = registry()
    providers.register(provider)
    await providers.ready('fake')
    const prompt = { specId: 's1', requester: { id: 'U1' }, summary: 'Spec', link: 'https://chat.example/1' }
    await providers.askApproval(address, prompt)
    await providers.askApproval(address, prompt)
    expect(provider.approvals).toHaveLength(1)
  })
  it('reports a failed inbound delivery in health instead of swallowing it', async () => {
    const { providers } = registry()
    providers.consume(async () => { throw new Error('Session unavailable') }, async () => {})
    await expect(providers.receive({ id: 'e1', provider: 'fake', conversation: 'C1', thread: 'T1', messageId: '1',
      sender: { id: 'U1' }, addressed: true, text: 'hi', at: new Date().toISOString() })).rejects.toThrow('Session unavailable')
    expect(providers.health().inbound).toMatchObject({ state: 'error', detail: 'Session unavailable' })
  })
  it('reports a provider that fails to start rather than leaving it falsely ready', async () => {
    const provider = new FakeProvider()
    provider.start = async () => { throw new Error('bad token') }
    const providers = new ChatProviders(store)
    providers.register(provider)
    await providers.ready('fake')
    expect(providers.health().fake).toMatchObject({ state: 'error', detail: expect.stringContaining('bad token') })
  })
  it('returns gone for a send to a provider that is not installed', async () => {
    const { providers } = registry()
    expect(await providers.send({ provider: 'discord', conversation: '1', thread: '1' }, 'hi', 'r1')).toEqual({ status: 'gone' })
  })
})
