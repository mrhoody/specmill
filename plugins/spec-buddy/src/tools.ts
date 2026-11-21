/** The three tools Spec Buddy's Sessions may use: draft, ask for approval, and hand off. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { Config } from './config.ts'
import type { ConversationRecord } from './model.ts'
import type { Handoff } from './handoff.ts'
import { HandoffError } from './handoff.ts'
import { normalizeMarkdown, specIdOf } from './ids.ts'
import type { ChatProviders } from './service.ts'
import { approvalProblem, draftProblem, requesterLabel, titleOf } from './spec.ts'
import type { StateStore } from './store.ts'
import type { Tool } from './tools/tool.ts'

export interface ToolHost {
  readonly config: Config
  readonly store: StateStore
  readonly providers: ChatProviders
  readonly handoff: Handoff
}

const addressOf = (conversation: ConversationRecord) =>
  ({ provider: conversation.provider, conversation: conversation.conversation, thread: conversation.thread })

const now = (): string => new Date().toISOString()

/**
 * Builds the tools for one conversation. Every tool re-reads that conversation from the store, so a draft or approval
 * saved by another tool call is visible immediately.
 */
export function specTools(conversation: ConversationRecord, host: ToolHost): Tool[] {
  const current = (): ConversationRecord => {
    const found = host.store.conversation(conversation.key)
    if (!found) throw new Error('This Session is not attached to a Spec Buddy conversation')
    return found
  }
  const save = (record: ConversationRecord): void => { host.store.saveConversation({ ...record, updatedAt: now() }) }

  return [
    {
      name: 'spec_draft',
      description: 'Save the current spec draft for this conversation and post it in the thread. Use the spec-writing skill template: '
        + 'Problem, Context, Proposal, Acceptance criteria, Out of scope, Affected areas, Risks / open questions, and Test plan. '
        + 'Acceptance criteria needs at least one `- [ ]` item. Every revision gets a new draft id and needs a fresh approval.',
      schema: z.object({ markdown: z.string().min(1).describe('The complete spec, in Markdown, with all eight template sections.') }).strict(),
      async execute(input) {
        const { markdown } = input as { markdown: string }
        const normalized = normalizeMarkdown(markdown)
        const problem = draftProblem(normalized)
        if (problem) return { saved: false, reason: problem }
        const specId = specIdOf(normalized)
        const record = current()
        const changed = record.draft?.specId !== specId
        save({ ...record, draft: { specId, markdown: normalized, at: now() },
          ...(changed ? { approval: undefined, approvalRequestedAt: undefined } : {}) })
        try {
          const result = await host.providers.send(addressOf(record), `**Spec draft**\n\n${normalized}`, `draft:${record.sessionId}:${specId}`)
          if (result.status === 'gone') return { saved: true, specId, posted: false, reason: 'The thread is gone; the draft was saved but not posted.' }
          return { saved: true, specId, posted: true, title: titleOf(normalized) }
        } catch (error) {
          return { saved: true, specId, posted: false, reason: `The draft was saved but posting it failed: ${String(error)}` }
        }
      },
    },
    {
      name: 'spec_request_approval',
      description: 'Ask the person who started this conversation to approve the current draft. Slack shows a button; on a platform '
        + 'without buttons the person replies "hand off". Nobody else can approve.',
      schema: z.object({}).strict(),
      async execute() {
        const record = current()
        if (!record.draft) return { asked: false, reason: 'There is no draft spec yet. Use spec_draft first.' }
        if (record.approval?.specId === record.draft.specId) {
          return { asked: false, reason: 'This draft is already approved. Call spec_handoff.' }
        }
        const problem = approvalProblem(record, record.requester)
        if (problem) return { asked: false, reason: problem }
        try {
          await host.providers.askApproval(addressOf(record), { specId: record.draft.specId, requester: record.requester,
            summary: titleOf(record.draft.markdown), link: host.providers.link(addressOf(record)) })
          save({ ...record, approvalRequestedAt: now() })
          return { asked: true, specId: record.draft.specId, requester: requesterLabel(record.requester) }
        } catch (error) {
          return { asked: false, reason: `Could not ask for approval: ${String(error)}` }
        }
      },
    },
    {
      name: 'spec_handoff',
      description: 'File the approved current draft as a GitHub issue that mentions dsh-superagent, then post its link in the thread. '
        + 'Refuses unless the current draft is approved and unchanged since approval. Call it only after the person who asked approves.',
      schema: z.object({}).strict(),
      async execute() {
        const record = current()
        try {
          const filed = await host.handoff.file(record)
          const latest = host.store.conversation(record.key) ?? record
          try { await host.handoff.announce(latest, filed.url) }
          catch (error) { return { ...filed, posted: false, reason: `The issue exists, but posting its link failed: ${String(error)}` } }
          return { ...filed, posted: true }
        } catch (error) {
          if (error instanceof HandoffError) return { filed: false, reason: error.message }
          return { filed: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    },
  ]
}

/** The provider-facing approval notice delivered to the Session after a valid approval. */
export function approvalNotice(conversation: ConversationRecord, approver: { id: string; name?: string }): string {
  return `${approver.name ?? approver.id} (${approver.id}) approved the spec ${conversation.draft?.specId ?? ''}. `
    + 'Call spec_handoff now. It files the GitHub issue and posts the link in the thread.'
}
