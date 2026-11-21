import { describe, expect, it } from 'vitest'
import { normalizeSlackEvent, SlackProvider, slackify, splitText, type SlackConfig, type SlackSocket, type SlackWeb }
  from '../src/providers/slack.ts'
import type { ChatHost } from '../src/types.ts'

const config: SlackConfig = { appToken: 'xapp-1', botToken: 'xoxb-1', channels: ['C1'], allowedUsers: ['U1'] }
const envelope = { event_id: 'Ev1' }
const mention = { type: 'app_mention', channel: 'C1', channel_type: 'channel', user: 'U1', text: '<@UBOT> we need rate limiting',
  ts: '1700000000.000100', thread_ts: '1700000000.000001', event_id: 'Ev1' }

describe('Slack event normalization', () => {
  it('keeps stable ids, the thread key, and the sender', () => {
    const message = normalizeSlackEvent(mention, envelope, config, 'UBOT', 'mention')
    expect(message).toMatchObject({ provider: 'slack', conversation: 'C1', thread: '1700000000.000001', id: 'Ev1',
      messageId: '1700000000.000100', sender: { id: 'U1' }, addressed: true })
    expect(message?.at).toBe('2023-11-14T22:13:20.000Z')
  })
  it('falls back to a stable id when the envelope has none', () => {
    expect(normalizeSlackEvent({ ...mention, event_id: undefined }, {}, config, 'UBOT', 'mention')?.id).toBe('slack:C1:1700000000.000100')
    expect(normalizeSlackEvent({ ...mention, event_id: undefined, client_msg_id: 'cm1' }, {}, config, 'UBOT', 'mention')?.id).toBe('cm1')
  })
  it('drops its own messages, other bots, edits, and undeclared channels or users', () => {
    expect(normalizeSlackEvent(mention, envelope, config, 'U1', 'mention')).toBeUndefined()
    expect(normalizeSlackEvent({ ...mention, bot_id: 'B1' }, envelope, config, 'UBOT', 'mention')).toBeUndefined()
    expect(normalizeSlackEvent({ ...mention, subtype: 'message_changed' }, envelope, config, 'UBOT', 'mention')).toBeUndefined()
    expect(normalizeSlackEvent({ ...mention, channel: 'C2' }, envelope, config, 'UBOT', 'mention')).toBeUndefined()
    expect(normalizeSlackEvent({ ...mention, user: 'U2' }, envelope, config, 'UBOT', 'mention')).toBeUndefined()
  })
  it('accepts an allowed DM and keeps the whole DM as one conversation', () => {
    const first = { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'hello', ts: '1700000000.000200' }
    const second = { ...first, ts: '1700000000.000300' }
    expect(normalizeSlackEvent(first, envelope, config, 'UBOT', 'message')).toMatchObject({ conversation: 'D1', thread: 'D1' })
    expect(normalizeSlackEvent(second, envelope, config, 'UBOT', 'message')).toMatchObject({ conversation: 'D1', thread: 'D1' })
  })
  it('drops channel messages that are not mentions', () => {
    const plain = { ...mention, type: 'message', channel_type: 'channel' }
    expect(normalizeSlackEvent(plain, envelope, config, 'UBOT', 'message')).toBeUndefined()
  })
})

describe('Slack text', () => {
  it('splits long text under the limit with no empty chunks', () => {
    const chunks = splitText('a'.repeat(95), 40)
    expect(chunks.join('')).toBe('a'.repeat(95))
    expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= 40)).toBe(true)
    expect(splitText(`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)])
  })
  it('converts Markdown to Slack mrkdwn without touching fenced code', () => {
    expect(slackify('## Title\n**bold** and [docs](https://example.com)\n```\n**kept**\n```'))
      .toBe('*Title*\n*bold* and <https://example.com|docs>\n```\n**kept**\n```')
  })
})

class FakeSocket implements SlackSocket {
  readonly listeners = new Map<string, (...args: unknown[]) => void>()
  disconnected = 0
  on(event: string, listener: (...args: unknown[]) => void): this { this.listeners.set(event, listener); return this }
  async start(): Promise<void> {}
  async disconnect(): Promise<void> { this.disconnected++ }
}

function fakeWeb() {
  const posts: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }[] = []
  const web: SlackWeb = {
    auth: { test: async () => ({ user_id: 'UBOT', url: 'https://team.slack.com' }) },
    chat: { postMessage: async input => { posts.push(input); return { ok: true, ts: `ts${posts.length}` } } },
  }
  return { web, posts }
}

const host = (received: unknown[] = [], approvals: unknown[] = []): ChatHost => ({
  receive: async message => { received.push(message) },
  approved: async (address, specId, sender) => { approvals.push({ address, specId, sender }) },
})

describe('Slack provider', () => {
  it('starts, sends split messages into the thread, and never leaks its token', async () => {
    const { web, posts } = fakeWeb()
    const socket = new FakeSocket()
    const provider = new SlackProvider(config, { web, socket }, { warn() {}, error() {} })
    await provider.start(host())
    expect(provider.health()).toMatchObject({ state: 'ready' })
    const result = await provider.send({ provider: 'slack', conversation: 'C1', thread: '1700000000.000001' }, 'x'.repeat(5000), 'r1')
    expect(result).toMatchObject({ status: 'sent', messageId: 'ts1' })
    expect(posts).toHaveLength(2)
    expect(posts.every(post => post.thread_ts === '1700000000.000001' && post.text.length <= 3900)).toBe(true)
    expect(provider.link({ provider: 'slack', conversation: 'C1', thread: '1700000000.000100' }))
      .toBe('https://team.slack.com/app_redirect?channel=C1&message_ts=1700000000.000100')
  })
  it('posts a root DM without a thread_ts, because a DM channel id is not a message timestamp', async () => {
    const { web, posts } = fakeWeb()
    const provider = new SlackProvider(config, { web, socket: new FakeSocket() }, { warn() {}, error() {} })
    await provider.start(host())
    await provider.send({ provider: 'slack', conversation: 'D1', thread: 'D1' }, 'hello', 'r2')
    expect(posts[0]?.thread_ts).toBeUndefined()
  })
  it('posts an approval card whose button carries the draft id', async () => {
    const { web, posts } = fakeWeb()
    const provider = new SlackProvider(config, { web, socket: new FakeSocket() }, { warn() {}, error() {} })
    await provider.start(host())
    await provider.askApproval({ provider: 'slack', conversation: 'C1', thread: 'T1' },
      { specId: 'abc123', requester: { id: 'U1', name: 'Ada' }, summary: 'Add rate limiting', link: 'https://x' })
    const blocks = posts[0]?.blocks as { type: string; elements?: { value?: string }[] }[]
    expect(blocks[1]?.elements?.[0]?.value).toContain('abc123')
    expect(posts[0]?.text).toContain('U1')
  })
  it('routes mentions and approvals, and reports a loop failure as health instead of an unhandled rejection', async () => {
    const { web } = fakeWeb()
    const socket = new FakeSocket()
    const received: unknown[] = [], approvals: unknown[] = []
    const provider = new SlackProvider(config, { web, socket }, { warn() {}, error() {} })
    await provider.start(host(received, approvals))
    socket.listeners.get('app_mention')?.({ ack: async () => {}, event: mention, body: envelope })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toHaveLength(1)
    socket.listeners.get('interactive')?.({ ack: async () => {}, type: 'block_actions', user: { id: 'U1', name: 'Ada' },
      channel: { id: 'C1' }, message: { ts: '2', thread_ts: '1' },
      actions: [{ action_id: 'spec_buddy_approve', value: JSON.stringify({ specId: 'abc123' }) }] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(approvals[0]).toMatchObject({ specId: 'abc123', sender: { id: 'U1' } })
    // Socket Mode carries the interactive payload in `body`, not at the top level.
    socket.listeners.get('interactive')?.({ ack: async () => {}, body: { type: 'block_actions', user: { id: 'U1' },
      channel: { id: 'C1' }, message: { ts: '2', thread_ts: '1' },
      actions: [{ action_id: 'spec_buddy_approve', value: JSON.stringify({ specId: 'def456' }) }] } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(approvals[1]).toMatchObject({ specId: 'def456' })
    socket.listeners.get('interactive')?.({ ack: async () => {}, body: { type: 'block_actions', user: { id: 'U1' },
      channel: { id: 'D1' }, message: { ts: '1700000000.000400' },
      actions: [{ action_id: 'spec_buddy_approve', value: JSON.stringify({ specId: 'ghi789' }) }] } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(approvals[2]).toMatchObject({ address: { conversation: 'D1', thread: 'D1' }, specId: 'ghi789' })
    const failSocket = new FakeSocket()
    const failing = new SlackProvider(config, { web, socket: failSocket }, { warn() {}, error() {} })
    await failing.start({ receive: async () => { throw new Error('core refused') }, approved: async () => {} })
    failSocket.listeners.get('app_mention')?.({ ack: async () => {}, event: mention, body: envelope })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(failing.health()).toMatchObject({ state: 'error', detail: 'core refused' })
  })
  it('reports an empty allowedUsers list as an error and stops cleanly', async () => {
    const { web } = fakeWeb()
    const socket = new FakeSocket()
    const provider = new SlackProvider({ ...config, allowedUsers: [] }, { web, socket }, { warn() {}, error() {} })
    await provider.start(host())
    expect(provider.health()).toMatchObject({ state: 'error', detail: expect.stringContaining('allowedUsers') })
    await provider.stop()
    expect(socket.disconnected).toBe(1)
  })
})
