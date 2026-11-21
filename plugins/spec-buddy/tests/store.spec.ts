import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { conversation } from './helpers.ts'
import { StateLock, StateStore } from '../src/store.ts'
import { tempState } from './helpers.ts'

let dir: string
let cleanup: () => void
beforeEach(() => { const temp = tempState(); dir = temp.dir; cleanup = temp.cleanup })
afterEach(() => cleanup())

describe('state store', () => {
  it('remembers event ids, conversations, and receipts across a restart', () => {
    const store = new StateStore(dir)
    expect(store.hasEvent('Ev1')).toBe(false)
    store.recordEvent('Ev1')
    store.recordEvent('Ev1')
    store.recordEvent('Ev2')
    store.saveConversation(conversation())
    store.saveReceipt('fake:r1', { status: 'sent', messageId: 'm1', at: 'now' })
    const reopened = new StateStore(dir)
    expect(reopened.hasEvent('Ev1')).toBe(true)
    expect(reopened.hasEvent('Ev2')).toBe(true)
    expect(reopened.conversation('fake:C1:T1')?.requester.name).toBe('Ada')
    expect(reopened.receipt('fake:r1')).toMatchObject({ status: 'sent', messageId: 'm1' })
    expect(reopened.summary()).toEqual({ conversations: 1, filed: 0, approved: 1 })
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600)
  })
  it('scopes an event id once and keeps the state file under the state directory', () => {
    const store = new StateStore(dir)
    store.recordEvent('Ev1')
    expect(store.hasEvent('Ev1')).toBe(true)
    expect(existsSync(join(dir, 'state.json'))).toBe(true)
  })
  it('holds one state directory lock at a time and releases it', () => {
    const lock = StateLock.acquire(dir, () => {})
    expect(() => StateLock.acquire(dir, () => {})).toThrow()
    lock.free()
    const again = StateLock.acquire(dir, () => {})
    again.free()
  })
})
