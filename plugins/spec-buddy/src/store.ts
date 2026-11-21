/** A small JSON state store under `stateDir`, guarded by an exclusive directory lock like dsh-superagent's. */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync, type LockOptions } from 'proper-lockfile'
import type { ConversationRecord, StateData } from './model.ts'
import type { SendReceipt } from './types.ts'

/** Newest event ids and receipts kept to bound the state file. */
const KEEP_EVENTS = 5000, KEEP_RECEIPTS = 2000

/** An exclusive hold on `stateDir`; another Spec Buddy process cannot share it. */
export class StateLock {
  private release?: () => void
  /** Acquires the lock, creating `stateDir` first when needed. */
  static acquire(stateDir: string, onCompromised: (error: Error) => void): StateLock {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const release = lockSync(stateDir, { stale: 30_000, onCompromised } satisfies LockOptions)
    return new StateLock(release)
  }
  private constructor(release: () => void) { this.release = release }
  /** Releases the lock once; a lock lost as compromised needs no release. */
  free(): void {
    const release = this.release
    this.release = undefined
    try { release?.() } catch { /* A compromised or already-released lock needs no second release. */ }
  }
}

const empty = (): StateData => ({ version: 1, conversations: {}, events: [], receipts: {} })

/** Reads and writes the whole state atomically after every mutation. */
export class StateStore {
  private readonly path: string
  private data: StateData
  constructor(stateDir: string) {
    this.path = join(stateDir, 'state.json')
    this.data = this.load()
  }
  private load(): StateData {
    let text: string
    try { text = readFileSync(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw error
    }
    const parsed = JSON.parse(text) as Partial<StateData>
    return { version: 1, conversations: parsed.conversations ?? {}, events: parsed.events ?? [], receipts: parsed.receipts ?? {} }
  }
  private flush(): void {
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
    try { chmodSync(this.path, 0o600) } catch { /* A filesystem without chmod support is not a state failure. */ }
  }
  /** Whether an event id was already accepted. */
  hasEvent(id: string): boolean { return this.data.events.includes(id) }
  /** Records an event id, keeping the newest {@link KEEP_EVENTS}. */
  recordEvent(id: string): void {
    if (this.hasEvent(id)) return
    this.data.events.push(id)
    if (this.data.events.length > KEEP_EVENTS) this.data.events.splice(0, this.data.events.length - KEEP_EVENTS)
    this.flush()
  }
  conversation(key: string): ConversationRecord | undefined { return this.data.conversations[key] }
  conversations(): ConversationRecord[] { return Object.values(this.data.conversations) }
  conversationForSession(sessionId: string): ConversationRecord | undefined {
    return Object.values(this.data.conversations).find(item => item.sessionId === sessionId)
  }
  saveConversation(record: ConversationRecord): void {
    this.data.conversations[record.key] = record
    this.flush()
  }
  receipt(replyId: string): SendReceipt | undefined { return this.data.receipts[replyId] }
  saveReceipt(replyId: string, receipt: SendReceipt): void {
    this.data.receipts[replyId] = receipt
    const keys = Object.keys(this.data.receipts)
    if (keys.length > KEEP_RECEIPTS) for (const key of keys.slice(0, keys.length - KEEP_RECEIPTS)) delete this.data.receipts[key]
    this.flush()
  }
  /** For the health route: a few counters without leaking message text. */
  summary(): { conversations: number; filed: number; approved: number } {
    const records = this.conversations()
    return { conversations: records.length, filed: records.filter(record => record.issue).length,
      approved: records.filter(record => record.approval).length }
  }
}
