import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { specIdOf } from '../src/ids.ts'
import type { ConversationRecord } from '../src/model.ts'
import { ChatProviders } from '../src/service.ts'
import { approvalProblem, draftProblem, handoffProblem, isApprovalCommand, missingSections, renderIssue, titleOf }
  from '../src/spec.ts'
import type { StateStore } from '../src/store.ts'
import { specTools } from '../src/tools.ts'
import type { Handoff } from '../src/handoff.ts'
import { Handoff as RealHandoff } from '../src/handoff.ts'
import { FakeProvider, VALID_SPEC, address, conversation, tempState } from './helpers.ts'

let store: StateStore
let cleanup: () => void
beforeEach(() => { const temp = tempState(); store = temp.store; cleanup = temp.cleanup })
afterEach(() => cleanup())

describe('spec template', () => {
  it('accepts the full draft and names the missing sections and checklist', () => {
    expect(draftProblem(VALID_SPEC)).toBeUndefined()
    expect(draftProblem(VALID_SPEC.replace('Risks / open questions', 'Risks & open questions'))).toBeUndefined()
    const withoutRisks = VALID_SPEC.replace(/## Risks \/ open questions[\s\S]*?(?=\n## )/, '')
    expect(missingSections(withoutRisks)).toEqual(['Risks / open questions'])
    expect(draftProblem(withoutRisks)).toContain('Risks / open questions')
    expect(draftProblem(VALID_SPEC.replace(/- \[ \] /g, '- '))).toContain('checklist')
  })
  it('titles the issue from the H1, and falls back to Problem', () => {
    expect(titleOf(VALID_SPEC)).toBe('Add rate limiting to the public API')
    expect(titleOf(VALID_SPEC.replace('# Add rate limiting to the public API', '## Problem'))).toBe('The public API accepts unlimited requests, so one client can starve the others.')
  })
  it('recognizes only the exact approval command', () => {
    for (const command of ['hand off', 'HAND OFF', 'handoff', '<@UBOT> hand off', 'approve', 'approve the spec']) expect(isApprovalCommand(command)).toBe(true)
    for (const command of ['I approve this approach', 'hand off later', 'please think about it']) expect(isApprovalCommand(command)).toBe(false)
  })
})

describe('approval and handoff gates', () => {
  it('refuses an approver who is not the person who asked', () => {
    expect(approvalProblem(conversation(), { id: 'U2' })).toContain('Only the person')
    expect(approvalProblem(conversation(), { id: 'U1' })).toBeUndefined()
  })
  it('refuses when the draft changed after approval', () => {
    const record = conversation()
    const changed: ConversationRecord = { ...record, draft: { ...record.draft!, specId: 'different', markdown: record.draft!.markdown } }
    expect(handoffProblem(changed)).toContain('changed after it was approved')
  })
  it('refuses without a draft or without approval', () => {
    const approved = conversation()
    expect(handoffProblem({ ...approved, draft: undefined })).toContain('no draft')
    expect(handoffProblem({ ...approved, approval: undefined })).toContain('not approved')
  })
})

describe('issue body', () => {
  it('contains every section and ends with the agent mention on its own last line', () => {
    const { title, body } = renderIssue(conversation(), 'superagent')
    expect(title).toBe('Add rate limiting to the public API')
    for (const heading of ['Problem', 'Context', 'Proposal', 'Acceptance criteria', 'Out of scope', 'Affected areas', 'Risks / open questions', 'Test plan']) {
      expect(body).toContain(`## ${heading}`)
    }
    expect(body).toContain('Requested by Ada in https://chat.example/thread/1.')
    expect(body).toContain('Approved 2026-11-21T10:00:00.000Z.')
    expect(body.trimEnd().split('\n').at(-1)).toBe('@superagent please implement this issue.')
  })
})

describe('spec tools', () => {
  function tools(record: ConversationRecord, options: { handoff?: Handoff } = {}) {
    const provider = new FakeProvider()
    const providers = new ChatProviders(store)
    providers.register(provider)
    const handoff = options.handoff ?? new RealHandoff({ stateDir: '/tmp/state', repoCheckout: '/tmp/repo',
      github: { repo: 'acme/widgets', agentLogin: 'superagent', configDir: '/tmp/gh' } }, store, providers,
    async () => ({ stdout: 'no', stderr: '', code: 1 }))
    return { provider, providers, handoff, tools: specTools(record, { config: { stateDir: '/tmp/state', repoCheckout: '/tmp/repo',
      github: { repo: 'acme/widgets', agentLogin: 'superagent', configDir: '/tmp/gh' } }, store, providers, handoff }) }
  }
  it('saves and posts a valid draft, and a revision clears the old approval', async () => {
    store.saveConversation(conversation())
    const { provider, tools: list } = tools(conversation())
    const result = await list[0]!.execute({ markdown: VALID_SPEC }, new AbortController().signal) as Record<string, unknown>
    expect(result).toMatchObject({ saved: true, posted: true })
    expect(provider.sent[0]?.text).toContain('## Problem')
    const saved = store.conversation('fake:C1:T1')!
    expect(saved.draft?.specId).toBe(specIdOf(VALID_SPEC))
    const revised = VALID_SPEC.replace('token bucket', 'leaky bucket')
    await list[0]!.execute({ markdown: revised }, new AbortController().signal)
    expect(store.conversation('fake:C1:T1')!.approval).toBeUndefined()
  })
  it('refuses an incomplete draft instead of saving it', async () => {
    store.saveConversation(conversation())
    const { tools: list } = tools(conversation())
    const result = await list[0]!.execute({ markdown: '## Problem\nonly' }, new AbortController().signal) as Record<string, unknown>
    expect(result.saved).toBe(false)
    expect(result.reason).toContain('Context')
  })
  it('asks the requester for approval once', async () => {
    store.saveConversation(conversation({ approval: undefined }))
    const { provider, tools: list } = tools(conversation({ approval: undefined }))
    const result = await list[1]!.execute({}, new AbortController().signal) as Record<string, unknown>
    expect(result).toMatchObject({ asked: true, requester: 'Ada' })
    expect(provider.approvals).toHaveLength(1)
    expect(provider.approvals[0]?.prompt.specId).toBe(specIdOf(VALID_SPEC))
  })
  it('does not ask again when the current draft is already approved', async () => {
    store.saveConversation(conversation())
    const { provider, tools: list } = tools(conversation())
    const result = await list[1]!.execute({}, new AbortController().signal) as Record<string, unknown>
    expect(result).toMatchObject({ asked: false, reason: expect.stringContaining('already approved') })
    expect(provider.approvals).toHaveLength(0)
  })
  it('refuses handoff without approval and files once when approved', async () => {
    store.saveConversation(conversation({ approval: undefined }))
    const { tools: unapproved } = tools(conversation({ approval: undefined }))
    const refused = await unapproved[2]!.execute({}, new AbortController().signal) as Record<string, unknown>
    expect(refused).toMatchObject({ filed: false, reason: expect.stringContaining('not approved') })

    const approvals: { args: string[]; input?: string }[] = []
    const provider = new FakeProvider()
    const providers = new ChatProviders(store)
    providers.register(provider)
    const handoff = new RealHandoff({ stateDir: '/tmp/state', repoCheckout: '/tmp/repo',
      github: { repo: 'acme/widgets', agentLogin: 'superagent', configDir: '/tmp/gh' } }, store, providers,
    async (command, args, options) => {
      if (args[0] === 'api') return { stdout: 'spec-buddy\tUser\n', stderr: '', code: 0 }
      approvals.push({ args, input: options.input })
      return { stdout: 'https://github.com/acme/widgets/issues/7\n', stderr: '', code: 0 }
    })
    store.saveConversation(conversation())
    const list = specTools(conversation(), { config: { stateDir: '/tmp/state', repoCheckout: '/tmp/repo',
      github: { repo: 'acme/widgets', agentLogin: 'superagent', configDir: '/tmp/gh' } }, store, providers, handoff })
    const okay = await list[2]!.execute({}, new AbortController().signal) as Record<string, unknown>
    expect(okay).toMatchObject({ filed: true, url: 'https://github.com/acme/widgets/issues/7', posted: true })
    const again = await list[2]!.execute({}, new AbortController().signal) as Record<string, unknown>
    expect(again).toMatchObject({ filed: true, url: 'https://github.com/acme/widgets/issues/7', duplicate: true })
    expect(approvals).toHaveLength(1)
  })
})
