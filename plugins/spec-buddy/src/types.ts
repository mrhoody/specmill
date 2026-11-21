/** The platform-neutral contract every chat provider implements. Nothing outside a provider knows which chat platform is in use. */
import type { ZodType } from 'zod'

/** Where a provider posts: a conversation (channel or DM) and its thread. */
export interface Address {
  provider: string
  conversation: string
  thread: string
}

/** A person on a chat platform. */
export interface Sender {
  id: string
  name?: string
  /** Whether the platform identifies this sender as a bot rather than a person. */
  bot?: boolean
}

/** A message a provider pushed into the core, already normalized and filtered. */
export interface IncomingMessage extends Address {
  /** Stable event identity, used for dedupe and as the delivery request id. */
  id: string
  /** The platform message id. */
  messageId: string
  sender: Sender
  /** Whether the message names or directly addresses Spec Buddy, rather than merely being visible. */
  addressed: boolean
  text: string
  url?: string
  at: string
}

/** The outcome of one provider send. `messageId` is the provider's id for the first posted chunk. */
export interface SendResult {
  status: 'sent' | 'gone'
  messageId?: string
}

/** What a provider needs to render an approval request. */
export interface ApprovalPrompt {
  specId: string
  requester: Sender
  summary: string
  /** A link to the conversation, for the footer of the approved spec. */
  link: string
}

/** A provider's own health entry, surfaced by the core health route. */
export interface ProviderHealth {
  state: 'starting' | 'ready' | 'error'
  detail: string
}

/** The callbacks a running provider may use; supplied by the core registry on `start`. */
export interface ChatHost {
  /** Push one normalized, filtered message into the core. A rejection is recorded in the registry's health. */
  receive(message: IncomingMessage): Promise<void>
  /** An approval button was pressed. The core verifies that `sender` is the person who asked. */
  approved(address: Address, specId: string, sender: Sender): Promise<void>
}

/**
 * A chat platform plugin. `send` must be idempotent per `replyId`: the core records a receipt and may retry after a
 * throw, and the provider must not post twice for one reply id.
 */
export interface ChatProvider<C = Record<string, unknown>> {
  /** Stable provider id, such as `slack`. */
  kind: string
  /** Configuration schema for this provider's Cordis row. */
  schema: ZodType<C>
  /** The longest text one platform message may carry. */
  maxLength: number
  /** Split markdown into platform messages and apply the platform's dialect. */
  format(markdown: string): string[]
  /** Post `text` into `address`. Returns `gone` when the thread can no longer receive replies. */
  send(address: Address, text: string, replyId: string): Promise<SendResult>
  /** Ask the requester for approval, with buttons where the platform has them. */
  askApproval(address: Address, prompt: ApprovalPrompt): Promise<void>
  /** A browser link to the conversation. */
  link(address: Address): string
  /** Start listening; called once when the provider plugin mounts. */
  start?(host: ChatHost): Promise<void>
  /** Stop listening and release connections. */
  stop?(): Promise<void>
  /** This provider's current health, reported instead of an unhandled rejection. */
  health?(): ProviderHealth
}

/** The idempotent-send receipt stored under `replyId`. */
export interface SendReceipt {
  status: 'sent' | 'gone'
  messageId?: string
  at: string
}
