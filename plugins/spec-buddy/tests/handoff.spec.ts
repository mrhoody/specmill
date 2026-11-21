import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Handoff, HandoffError, identityProblem, issueUrlOf, readIdentity, type CommandRunner } from '../src/handoff.ts'
import { ChatProviders } from '../src/service.ts'
import type { StateStore } from '../src/store.ts'
import { FakeProvider, conversation, tempState } from './helpers.ts'

let store: StateStore
let cleanup: () => void
beforeEach(() => { const temp = tempState(); store = temp.store; cleanup = temp.cleanup })
afterEach(() => cleanup())

const config = { stateDir: '/tmp/state', repoCheckout: '/tmp/repo',
  github: { repo: 'acme/widgets', agentLogin: 'superagent', configDir: '/tmp/gh' } }

describe('GitHub identity', () => {
  it('reads login and type through the dedicated config dir', async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    const run: CommandRunner = async (_command, args, options) => {
      calls.push({ args, env: options.env })
      return { stdout: 'spec-buddy\tUser\n', stderr: '', code: 0 }
    }
    expect(await readIdentity(run, '/tmp/gh')).toEqual({ login: 'spec-buddy', type: 'User' })
    expect(calls[0]?.args).toEqual(['api', 'user', '--jq', '.login + "\t" + .type'])
    expect(calls[0]?.env.GH_CONFIG_DIR).toBe('/tmp/gh')
  })
  it('refuses the agent account and bot accounts', () => {
    expect(identityProblem({ login: 'superagent', type: 'User' }, 'superagent')).toContain('own account')
    expect(identityProblem({ login: 'spec-buddy[bot]', type: 'User' }, 'superagent')).toContain('bot')
    expect(identityProblem({ login: 'spec-buddy', type: 'Bot' }, 'superagent')).toContain('bot')
    expect(identityProblem({ login: 'spec-buddy', type: 'User' }, 'superagent')).toBeUndefined()
  })
})

describe('handoff', () => {
  function fixture(identity = 'spec-buddy\tUser\n') {
    const provider = new FakeProvider()
    const providers = new ChatProviders(store)
    providers.register(provider)
    const calls: { args: string[]; env: NodeJS.ProcessEnv; input?: string }[] = []
    const run: CommandRunner = async (_command, args, options) => {
      calls.push({ args, env: options.env, input: options.input })
      if (args[0] === 'api') return { stdout: identity, stderr: '', code: 0 }
      return { stdout: 'https://github.com/acme/widgets/issues/7\n', stderr: '', code: 0 }
    }
    return { provider, providers, calls, handoff: new Handoff(config, store, providers, run) }
  }
  it('files the approved draft once and posts the issue link once', async () => {
    store.saveConversation(conversation())
    const { provider, calls, handoff } = fixture()
    expect(await handoff.file(store.conversation('fake:C1:T1')!)).toEqual({ filed: true, url: 'https://github.com/acme/widgets/issues/7' })
    expect(await handoff.file(store.conversation('fake:C1:T1')!)).toMatchObject({ duplicate: true })
    const creates = calls.filter(call => call.args[0] === 'issue')
    expect(creates).toHaveLength(1)
    expect(creates[0]?.args).toEqual(['issue', 'create', '--repo', 'acme/widgets', '--title', 'Add rate limiting to the public API',
      '--body-file', '-'])
    expect(creates[0]?.env.GH_CONFIG_DIR).toBe('/tmp/gh')
    expect(creates[0]?.env.GH_TOKEN).toBeUndefined()
    expect(creates[0]?.input?.trimEnd().split('\n').at(-1)).toBe('@superagent please implement this issue.')
    await handoff.announce(store.conversation('fake:C1:T1')!, 'https://github.com/acme/widgets/issues/7')
    await handoff.announce(store.conversation('fake:C1:T1')!, 'https://github.com/acme/widgets/issues/7')
    expect(provider.sent.filter(sent => sent.text.includes('issues/7'))).toHaveLength(1)
    expect(store.conversation('fake:C1:T1')?.issue?.url).toBe('https://github.com/acme/widgets/issues/7')
  })
  it('refuses when the draft is not approved, without calling gh', async () => {
    store.saveConversation(conversation({ approval: undefined }))
    const { calls, handoff } = fixture()
    await expect(handoff.file(store.conversation('fake:C1:T1')!)).rejects.toBeInstanceOf(HandoffError)
    expect(calls).toHaveLength(0)
  })
  it('refuses when gh is signed in as the agent account, without creating an issue', async () => {
    store.saveConversation(conversation())
    const { calls, handoff } = fixture('superagent\tUser\n')
    await expect(handoff.file(store.conversation('fake:C1:T1')!)).rejects.toThrow('own account')
    expect(calls.filter(call => call.args[0] === 'issue')).toHaveLength(0)
  })
  it('parses only an issue URL', () => {
    expect(issueUrlOf('Created issue https://github.com/acme/widgets/issues/7')).toBe('https://github.com/acme/widgets/issues/7')
    expect(issueUrlOf('nothing here')).toBeUndefined()
  })
})
