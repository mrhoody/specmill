/** Deterministic identities for conversations, sessions, drafts, and one-shot replies. */
import { createHash } from 'node:crypto'
import type { Address } from './types.ts'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The key of the conversation an address names: `<provider>:<conversation>:<thread>`. */
export const conversationKey = (address: Address): string => `${address.provider}:${address.conversation}:${address.thread}`

/** The DSH Session id for a conversation key; stable across restarts. */
export const sessionIdOf = (key: string): string => `spec-buddy:${digest(key).slice(0, 16)}`

/** A draft's idempotency key: the hash of its normalized markdown. */
export const specIdOf = (markdown: string): string => digest(normalizeMarkdown(markdown)).slice(0, 16)

/** Normalizes line endings and trailing whitespace before hashing or rendering a draft. */
export function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n').trim()
}
