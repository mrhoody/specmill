/** Durable records and health shapes shared by the core, its providers, and the health route. */
import type { Sender, SendReceipt } from './types.ts'

/** A conversation's durable record: who asked, its Session, the current draft, its approval, and its filed issue. */
export interface ConversationRecord {
  key: string
  provider: string
  conversation: string
  thread: string
  sessionId: string
  /** The person who started the conversation and is the only one who may approve its spec. */
  requester: Sender
  /** The provider's browser link to the thread, used in the issue footer. */
  channelUrl: string
  createdAt: string
  updatedAt: string
  draft?: { specId: string; markdown: string; at: string }
  approval?: { specId: string; by: string; at: string; via: 'button' | 'text' }
  issue?: { specId: string; url: string; at: string }
  /** When `spec_request_approval` last asked, so a repeat does not ask twice. */
  approvalRequestedAt?: string
  /** The highest Session sequence whose answer was posted, so a restart never reposts an old turn. */
  lastPostedSeq?: number
}

/** Everything the core persists. */
export interface StateData {
  version: 1
  conversations: Record<string, ConversationRecord>
  events: string[]
  receipts: Record<string, SendReceipt>
}

/** A component health entry as the route and the start script read it. */
export interface Health {
  state: 'starting' | 'ready' | 'error'
  detail: string
  at?: string
}

/** The GitHub machine-user identity read before filing. */
export interface GithubIdentity {
  login: string
  type: string
}
