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
/**
 * dsh-superagent's status notices, such as a background job's end, which are not part of the request
 * (pinned: plugins/dsh-superagent/src/app/delivery.ts:76, `form: 'notice'`).
 */
const NOTICE_FORM = 'notice'

export interface RequestText {
  messages: string[]
  /** How many messages were left out to stay within the limit. */
  omitted: number
}

/**
 * The request messages in `events`, oldest first, within `maxChars`: the first message always, then the newest that fit.
 * When there are follow-ups, the first message keeps at most three quarters of the limit so a later change to the request
 * is not crowded out. A cut first message says so, and how long it was.
 */
export function requestText(events: readonly SessionEvent[], maxChars: number): RequestText {
  const all: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data as { source?: { kind?: string; form?: string }; content?: readonly { type: string; text?: string }[] }
    if (!REQUEST_SOURCES.has(data.source?.kind ?? '') || data.source?.form === NOTICE_FORM) continue
    const text = (data.content ?? []).filter(block => block.type === 'text' && block.text).map(block => block.text).join('\n').trim()
    if (text) all.push(text)
  }
  if (!all.length) return { messages: [], omitted: 0 }
  const firstLimit = all.length > 1 ? Math.floor(maxChars * 0.75) : maxChars
  const whole = all[0]!
  const first = whole.length <= firstLimit ? whole
    : `${whole.slice(0, firstLimit)}\n[cut: this message showed ${firstLimit} of ${whole.length} characters; read the rest from its source]`
  const rest: string[] = []
  let used = Math.min(whole.length, firstLimit)
  for (let index = all.length - 1; index > 0; index--) {
    const text = all[index]!
    if (used + text.length > maxChars) break
    rest.unshift(text)
    used += text.length
  }
  return { messages: [first, ...rest], omitted: all.length - 1 - rest.length }
}
