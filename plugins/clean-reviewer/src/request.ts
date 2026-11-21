/**
 * Reads what a ticket asked for from its worker Session: the messages dsh-superagent delivered (the assignment, the
 * request, and later messages from people) and anything a person typed into the Session. The worker's own replies, tool
 * calls and reasoning are never read, so the reviewer does not inherit the worker's view of the change.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** dsh-superagent names each worker Session `worker-<ticketId>` (pinned: plugins/dsh-superagent/src/executor/dsh.ts:24-26). */
export const ticketOfSession = (sessionId: string): string | undefined =>
  sessionId.startsWith('worker-') && sessionId.length > 'worker-'.length ? sessionId.slice('worker-'.length) : undefined

/** Message sources that carry the request: dsh-superagent's deliveries, and a person typing into the Session. */
const REQUEST_SOURCES = new Set(['dsh-superagent', 'user'])

export interface RequestText {
  messages: string[]
  /** How many messages were left out to stay within the limit. */
  omitted: number
}

/** The request messages in `events`, oldest first, within `maxChars`: the first message always, then the newest that fit. */
export function requestText(events: readonly SessionEvent[], maxChars: number): RequestText {
  const all: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data as { source?: { kind?: string }; content?: readonly { type: string; text?: string }[] }
    if (!REQUEST_SOURCES.has(data.source?.kind ?? '')) continue
    const text = (data.content ?? []).filter(block => block.type === 'text' && block.text).map(block => block.text).join('\n').trim()
    if (text) all.push(text)
  }
  if (!all.length) return { messages: [], omitted: 0 }
  const first = all[0]!.slice(0, maxChars)
  const rest: string[] = []
  let used = first.length
  for (let index = all.length - 1; index > 0; index--) {
    const text = all[index]!
    if (used + text.length > maxChars) break
    rest.unshift(text)
    used += text.length
  }
  return { messages: [first, ...rest], omitted: all.length - 1 - rest.length }
}
