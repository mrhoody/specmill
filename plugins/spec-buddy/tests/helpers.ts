/** Shared fixtures for the Spec Buddy tests: a valid draft, temp stores, and a fake chat provider. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { specIdOf } from '../src/ids.ts'
import type { ConversationRecord } from '../src/model.ts'
import type { Address, ApprovalPrompt, ChatHost, ChatProvider, IncomingMessage, SendResult } from '../src/types.ts'
import { StateStore } from '../src/store.ts'

export const NOW = '2026-11-21T10:00:00.000Z'

export const VALID_SPEC = `# Add rate limiting to the public API

## Problem

The public API accepts unlimited requests, so one client can starve the others.

## Context

Read \`src/api.ts\` and \`src/middleware.ts\`. Both route every public call through one handler.

## Proposal

Add a token bucket in front of the public handler, keyed by API token.

## Acceptance criteria

- [ ] Requests over 100 per minute receive HTTP 429.
- [ ] Existing clients under the limit are unaffected.

## Out of scope

Billing and per-plan quotas.

## Affected areas

\`src/api.ts\`, \`src/middleware.ts\`, and the API docs.

## Risks / open questions

- A shared bucket could let one noisy client affect another; keying by token avoids that.

## Test plan

Unit tests for the bucket and an integration test against the public handler.
`

export function tempState(): { dir: string; store: StateStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'spec-buddy-test-'))
  return { dir, store: new StateStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  const markdown = overrides.draft?.markdown ?? VALID_SPEC
  const specId = overrides.draft?.specId ?? specIdOf(markdown)
  return {
    key: 'fake:C1:T1', provider: 'fake', conversation: 'C1', thread: 'T1', sessionId: 'spec-buddy:abc',
    requester: { id: 'U1', name: 'Ada' }, channelUrl: 'https://chat.example/thread/1',
    createdAt: NOW, updatedAt: NOW,
    draft: { specId, markdown, at: NOW },
    approval: { specId, by: 'U1', at: NOW, via: 'button' },
    ...overrides,
  }
}

/** A provider that records sends and approvals and can be told to fail or report a gone thread. */
export class FakeProvider implements ChatProvider {
  readonly kind = 'fake'
  readonly schema = z.object({}).strict()
  readonly maxLength = 40
  readonly sent: { address: Address; text: string; replyId: string }[] = []
  readonly approvals: { address: Address; prompt: ApprovalPrompt }[] = []
  result: SendResult = { status: 'sent', messageId: 'm1' }
  failure?: Error
  started = 0
  stopped = 0
  state: { state: 'starting' | 'ready' | 'error'; detail: string } = { state: 'ready', detail: 'fake ready' }
  format(markdown: string): string[] { return markdown.length > this.maxLength ? [markdown.slice(0, this.maxLength), markdown.slice(this.maxLength)] : [markdown] }
  async send(address: Address, text: string, replyId: string): Promise<SendResult> {
    if (this.failure) throw this.failure
    this.sent.push({ address, text, replyId })
    return this.result
  }
  async askApproval(address: Address, prompt: ApprovalPrompt): Promise<void> { this.approvals.push({ address, prompt }) }
  link(): string { return 'https://chat.example/thread/1' }
  async start(_host: ChatHost): Promise<void> { this.started++ }
  async stop(): Promise<void> { this.stopped++ }
  health() { return this.state }
}

export const address: Address = { provider: 'fake', conversation: 'C1', thread: 'T1' }
export const message = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: 'Ev1', provider: 'fake', conversation: 'C1', thread: 'T1', messageId: '1',
  sender: { id: 'U1', name: 'Ada' }, addressed: true, text: 'we need rate limiting', at: NOW, ...overrides,
})
