/** Git fixtures and fake Sessions for the clean-reviewer tests. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { run, type Run } from '../src/target.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

export interface Fixture { root: string; work: string; origin: string; cleanup(): void }

/** A bare `origin` with `main`, and a clone on branch `ticket` with one pushed commit that changes `app.ts`. */
export function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'clean-reviewer-'))
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), work = join(root, 'work')
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', seed])
  const identity = (cwd: string) => { git(cwd, 'config', 'user.email', 'test@example.com'); git(cwd, 'config', 'user.name', 'Test') }
  identity(seed)
  writeFileSync(join(seed, 'app.ts'), 'export const add = (a: number, b: number) => a + b\n')
  git(seed, 'add', '.'); git(seed, 'commit', '--quiet', '-m', 'init')
  git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', '--quiet', 'origin', 'main')
  execFileSync('git', ['clone', '--quiet', origin, work])
  identity(work)
  git(work, 'checkout', '--quiet', '-b', 'ticket')
  writeFileSync(join(work, 'app.ts'), 'export const add = (a: number, b: number) => a - b\n')
  git(work, 'commit', '--quiet', '-am', 'change add')
  git(work, 'push', '--quiet', '-u', 'origin', 'ticket')
  return { root, work, origin, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export { git }

/** A runner that uses real git and answers `gh pr view` with `pr`, or fails it as if no PR exists. */
export function runner(pr?: Record<string, unknown>): Run {
  return (command, args, cwd, signal) => {
    if (command === 'gh') return pr ? Promise.resolve(JSON.stringify(pr)) : Promise.reject(new Error('no pull requests found'))
    return run(command, args, cwd, signal)
  }
}

let seq = 0
const event = (type: string, data: unknown) => ({ type, seq: ++seq, data }) as unknown as SessionEvent

export const userMessage = (kind: string, text: string) =>
  event('user/message', { role: 'user', source: { kind }, content: [{ type: 'text', text }] })
export const assistantMessage = (text: string) =>
  event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
export const toolResult = (text: string) =>
  event('tool/result', { message: { role: 'tool', content: [{ type: 'text', text }] } })

/** A fake Agent: its id, its Session's working directory and events, and a tool registry that records registrations. */
export function fakeAgent(id: string, cwd: string, events: SessionEvent[] = []) {
  const registered: { name: string; parameters: unknown; execute(args: unknown, execution: { signal: AbortSignal }): Promise<unknown> }[] = []
  let disposed = 0
  const agent = {
    id,
    session: { header: { cwd }, snapshotEvents: () => events },
    ctx: { tools: { register(tool: typeof registered[number]) { registered.push(tool); return () => { disposed++ } } } },
  } as unknown as Agent
  return { agent, registered, disposed: () => disposed }
}
