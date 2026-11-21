/** The GitHub side: the machine-user identity check, issue creation, and the link posted back to the thread. */
import { spawn } from 'node:child_process'
import type { Config } from './config.ts'
import type { ConversationRecord, GithubIdentity, Health } from './model.ts'
import type { ChatProviders } from './service.ts'
import { handoffProblem, renderIssue } from './spec.ts'
import type { StateStore } from './store.ts'

/** Runs one external command; injected so tests never touch `gh` or the network. */
export interface CommandRunner {
  (command: string, args: string[], options: { env: NodeJS.ProcessEnv; input?: string; timeoutMs: number }):
    Promise<{ stdout: string; stderr: string; code: number }>
}

/** Why a handoff was refused or failed; `message` is safe to show the person in the thread. */
export class HandoffError extends Error {}

/** The real runner over `child_process.spawn`, with a bounded lifetime and optional stdin. */
export const spawnRunner: CommandRunner = (command, args, { env, input, timeoutMs }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    child.kill('SIGKILL')
    reject(new Error(`${command} timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const finish = (run: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); run() }
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.stdout.on('error', () => {})
  child.stderr.on('error', () => {})
  child.stdin.on('error', () => { /* gh may exit before reading stdin; its exit code is the reported failure. */ })
  child.on('error', error => finish(() => reject(new Error(`Could not run ${command}: ${error.message}`))))
  child.on('close', code => finish(() => resolve({ stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'), code: code ?? 1 })))
  child.stdin.end(input ?? '')
})

const now = (): string => new Date().toISOString()

/** Reads the login and account type `gh` is authenticated as in `configDir`. */
export async function readIdentity(run: CommandRunner, configDir: string): Promise<GithubIdentity> {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: configDir }
  // Inherited tokens would silently override the dedicated machine-user login.
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  const result = await run('gh', ['api', 'user', '--jq', '.login + "\t" + .type'], { env, timeoutMs: 20_000 })
  if (result.code !== 0) throw new HandoffError(`gh api user failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`)
  const [login, type] = result.stdout.trim().split('\t')
  if (!login) throw new HandoffError('gh api user returned no login')
  return { login, type: type || 'unknown' }
}

/** Why `identity` may not file as Spec Buddy, or `undefined` when it may. */
export function identityProblem(identity: GithubIdentity, agentLogin: string): string | undefined {
  if (identity.login === agentLogin) return `The gh account is ${agentLogin}, dsh-superagent's own account. Spec Buddy needs its own machine-user account.`
  if (/\[bot\]$/i.test(identity.login) || identity.type.toLowerCase().includes('bot')) {
    return `The gh account ${identity.login} is a bot. dsh-superagent ignores bot-authored issues, so Spec Buddy needs a regular user account.`
  }
  return undefined
}

/** Parses `gh issue create` output for the issue URL. */
export function issueUrlOf(stdout: string): string | undefined {
  return stdout.match(/https?:\/\/[^\s]+\/issues\/\d+/)?.[0]
}

/**
 * Files at most one issue per approved draft. The draft hash is the idempotency key: a retry returns the issue already
 * filed, and concurrent calls for one draft share a single `gh issue create`.
 */
export class Handoff {
  private readonly inFlight = new Map<string, Promise<{ filed: boolean; url: string; duplicate?: boolean }>>()
  private identityCache?: { at: number; health: Health }
  constructor(private readonly config: Config, private readonly store: StateStore, private readonly providers: ChatProviders,
    private readonly run: CommandRunner = spawnRunner, private readonly clock: () => number = Date.now) {}
  /** Runs the same `gh api user` check the startup health check uses; results are reused for 60 seconds. */
  async identity(): Promise<{ health: Health; identity?: GithubIdentity }> {
    const cached = this.identityCache
    if (cached && this.clock() - cached.at < 60_000) return { health: cached.health }
    try {
      const identity = await readIdentity(this.run, this.config.github.configDir)
      const problem = identityProblem(identity, this.config.github.agentLogin)
      const health: Health = problem
        ? { state: 'error', detail: problem, at: now() }
        : { state: 'ready', detail: `Signed in as ${identity.login}`, at: now() }
      this.identityCache = { at: this.clock(), health }
      return { health, identity: problem ? undefined : identity }
    } catch (error) {
      const health: Health = { state: 'error', detail: error instanceof Error ? error.message : String(error), at: now() }
      this.identityCache = { at: this.clock(), health }
      return { health }
    }
  }
  /** Files the conversation's approved draft, or returns the issue already filed for it. */
  async file(conversation: ConversationRecord): Promise<{ filed: boolean; url: string; duplicate?: boolean }> {
    const problem = handoffProblem(conversation)
    if (problem) throw new HandoffError(problem)
    const specId = conversation.draft!.specId
    if (conversation.issue?.specId === specId) return { filed: true, url: conversation.issue.url, duplicate: true }
    const running = this.inFlight.get(specId)
    if (running) return running
    const work = this.create(conversation, specId)
    this.inFlight.set(specId, work)
    try { return await work } finally { this.inFlight.delete(specId) }
  }
  private async create(conversation: ConversationRecord, specId: string): Promise<{ filed: boolean; url: string }> {
    const { health } = await this.identity()
    if (health.state !== 'ready') throw new HandoffError(health.detail)
    const issue = renderIssue(conversation, this.config.github.agentLogin)
    const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: this.config.github.configDir }
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
    const result = await this.run('gh', ['issue', 'create', '--repo', this.config.github.repo, '--title', issue.title,
      '--body-file', '-'], { env, input: issue.body, timeoutMs: 60_000 })
    if (result.code !== 0) throw new HandoffError(`gh issue create failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`)
    const url = issueUrlOf(result.stdout)
    if (!url) throw new HandoffError(`gh issue create printed no issue URL: ${(result.stdout || result.stderr).trim().slice(0, 300)}`)
    const latest = this.store.conversation(conversation.key) ?? conversation
    this.store.saveConversation({ ...latest, issue: { specId, url, at: now() }, updatedAt: now() })
    return { filed: true, url }
  }
  /** Posts the issue link in the thread once; safe to retry because it uses a receipted reply id. */
  async announce(conversation: ConversationRecord, url: string): Promise<void> {
    const address = { provider: conversation.provider, conversation: conversation.conversation, thread: conversation.thread }
    const result = await this.providers.send(address, `Spec filed: ${url}`, `issue:${conversation.sessionId}:${conversation.draft?.specId ?? ''}`)
    if (result.status === 'gone') throw new Error('The thread is gone; the issue was filed but its link could not be posted')
  }
}
