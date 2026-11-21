/** The spec template, its validation, the approval gate, and the GitHub issue body. */
import { normalizeMarkdown } from './ids.ts'
import type { ConversationRecord } from './model.ts'
import type { Sender } from './types.ts'

/** The required sections, in the order the skill template presents them. */
export const SPEC_SECTIONS = ['Problem', 'Context', 'Proposal', 'Acceptance criteria', 'Out of scope', 'Affected areas',
  'Risks / open questions', 'Test plan'] as const

const canonical = (heading: string): string => heading.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
const REQUIRED = new Map(SPEC_SECTIONS.map(name => [canonical(name), name]))
// Accept the common "Risks & open questions" spelling as the same required section.
REQUIRED.set('risks and open questions', 'Risks / open questions')

/** One heading and the text beneath it. */
export interface SpecSection { heading: string; text: string }

/** Splits markdown on ATX headings, preserving each heading's body. */
export function sectionsOf(markdown: string): SpecSection[] {
  const normalized = normalizeMarkdown(markdown)
  const sections: SpecSection[] = []
  const pattern = /^#{1,6}[ \t]+(.+?)[ \t]*$/gm
  const matches = [...normalized.matchAll(pattern)]
  for (const [index, match] of matches.entries()) {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? normalized.length
    sections.push({ heading: match[1]!.trim(), text: normalized.slice(start, end).trim() })
  }
  return sections
}

/** The sections a draft is missing, by canonical template name. */
export function missingSections(markdown: string): string[] {
  const present = new Set(sectionsOf(markdown).map(section => REQUIRED.get(canonical(section.heading))).filter(Boolean))
  return SPEC_SECTIONS.filter(name => !present.has(name))
}

/** Why a draft does not yet fit the template, or `undefined` when it does. */
export function draftProblem(markdown: string): string | undefined {
  const missing = missingSections(markdown)
  if (missing.length) return `The draft is missing these sections: ${missing.join(', ')}. Use the spec-writing skill's template.`
  const acceptance = sectionsOf(markdown).find(section => canonical(section.heading) === canonical('Acceptance criteria'))
  if (!acceptance || !/(?:^|\n)\s*[-*]\s*\[[ xX]\]/.test(acceptance.text)) {
    return 'The Acceptance criteria section needs at least one testable checklist item (`- [ ] ...`).'
  }
  return undefined
}

/** A short issue title: an H1 that is not a template section, else the first line of Problem. */
export function titleOf(markdown: string): string {
  const normalized = normalizeMarkdown(markdown)
  for (const match of normalized.matchAll(/^#[ \t]+(.+?)[ \t]*$/gm)) {
    const heading = match[1]!.trim()
    if (!REQUIRED.has(canonical(heading))) return heading.slice(0, 100)
  }
  for (const section of sectionsOf(normalized)) {
    if (canonical(section.heading) !== canonical('Problem')) continue
    const line = section.text.split('\n').map(item => item.replace(/^[-*>\s]+/, '').trim()).find(Boolean)
    if (line) return line.replace(/[`*_~]/g, '').slice(0, 100)
  }
  return 'Spec'
}

/** A person's display name for the issue footer. */
export function requesterLabel(sender: Sender): string {
  return sender.name?.trim() || sender.id
}

/** Whether a chat message is an approval command rather than a planning message. */
export function isApprovalCommand(text: string): boolean {
  const command = text.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  return /^(?:hand ?off|approve(?: the spec| this spec)?|approved)$/.test(command)
}

/** Why the current draft may not be approved by `sender`, or `undefined` when it may. */
export function approvalProblem(conversation: ConversationRecord, sender: Sender): string | undefined {
  if (sender.id !== conversation.requester.id) return 'Only the person who asked for this spec can approve it.'
  if (!conversation.draft) return 'There is no draft spec to approve yet.'
  const problem = draftProblem(conversation.draft.markdown)
  if (problem) return problem
  return undefined
}

/** Why the current draft may not be handed off, or `undefined` when it may. */
export function handoffProblem(conversation: ConversationRecord): string | undefined {
  const { draft, approval } = conversation
  if (!draft) return 'There is no draft spec to hand off. Use spec_draft first.'
  const problem = draftProblem(draft.markdown)
  if (problem) return problem
  if (!approval) return 'The person who asked has not approved this draft. Ask with spec_request_approval.'
  if (approval.specId !== draft.specId) return 'The draft changed after it was approved. Ask the person who asked to approve the new draft.'
  if (approval.by !== conversation.requester.id) return 'Only the person who asked can approve this spec.'
  return undefined
}

/** The GitHub issue body: the approved draft, the requester footer, and the agent mention on the last line. */
export function renderIssue(conversation: ConversationRecord, agentLogin: string): { title: string; body: string } {
  const draft = conversation.draft
  const approval = conversation.approval
  if (!draft || !approval) throw new Error('renderIssue needs an approved draft')
  const link = conversation.channelUrl || conversation.key
  const footer = `Requested by ${requesterLabel(conversation.requester)} in ${link}. Approved ${approval.at}.`
  // The mention must be the last line in the issue body: a new issue mentioning the agent is what dsh-superagent polls for.
  const body = `${normalizeMarkdown(draft.markdown)}\n\n---\n\n${footer}\n\n@${agentLogin} please implement this issue.`
  return { title: titleOf(draft.markdown), body: body.trimEnd() }
}
