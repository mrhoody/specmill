/**
 * Finds what a review covers in a worker's ticket directory: the pushed head commit, the base it branched from, and the
 * diff between them. Refuses work the PR does not show yet, so the reviewed commit is the one people see.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Runs a command in `cwd`; resolves with stdout, or rejects with an error whose message carries stderr. */
export type Run = (command: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<string>

export const run: Run = (command, args, cwd, signal) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd, signal, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } },
    (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(' ')} failed: ${String(stderr).trim() || error.message}`))
      else resolve(String(stdout))
    })
})

export interface ReviewTarget {
  cwd: string
  branch: string
  /** The base branch name, such as `main`. */
  baseBranch: string
  /** The merge base of the head commit and `origin/<baseBranch>`. */
  base: string
  head: string
  pr?: { number: number; url: string }
  stat: string
  /** The full diff, or undefined when it is larger than the limit and the reviewer reads it itself. */
  diff?: string
  diffChars: number
  /** Problems that did not stop the review, such as a failed fetch. */
  notes: string[]
}

/** A reason the review cannot run yet, worded for the worker. */
export class NotReviewable extends Error {}

/** Collects the review target in `cwd`; rejects with {@link NotReviewable} when the change is not ready to review. */
export async function reviewTarget(cwd: string, maxDiffChars: number, exec: Run = run, signal?: AbortSignal): Promise<ReviewTarget> {
  const git = (...args: string[]) => exec('git', args, cwd, signal).then(out => out.trim())
  const notes: string[] = []
  try { await git('rev-parse', '--git-dir') } catch { throw new NotReviewable(`${cwd} is not a git checkout.`) }
  if (await git('status', '--porcelain')) {
    throw new NotReviewable('The working tree has uncommitted changes. Commit and push them, then call review_changes again.')
  }
  const head = await git('rev-parse', 'HEAD')
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === 'HEAD') throw new NotReviewable('HEAD is detached. Check out the ticket branch, then call review_changes again.')

  const pr = await pullRequest(exec, cwd, signal)
  if (pr && pr.headRefOid !== head) {
    throw new NotReviewable(`PR #${pr.number} is at ${pr.headRefOid.slice(0, 12)} but HEAD is ${head.slice(0, 12)}. Push the branch, then call review_changes again.`)
  }
  if (!pr) {
    const upstream = await git('rev-parse', '@{upstream}').catch(() => '')
    if (upstream !== head) throw new NotReviewable('HEAD is not pushed. Push the branch (and open the PR), then call review_changes again.')
  }
  const baseBranch = pr?.baseRefName ?? await defaultBranch(git)
  let fetchError: string | undefined
  try { await git('fetch', '--quiet', 'origin', baseBranch) }
  catch (error) {
    fetchError = (error as Error).message
    notes.push(`Could not fetch origin/${baseBranch}; reviewed against the local copy. ${fetchError}`)
  }
  let base: string
  try { base = await git('merge-base', 'HEAD', `origin/${baseBranch}`) }
  catch {
    throw new NotReviewable(fetchError
      ? `Could not fetch origin/${baseBranch} and there is no local copy of it: ${fetchError}`
      : `No common history with origin/${baseBranch}.`)
  }
  if (base === head) throw new NotReviewable(`HEAD has no changes against origin/${baseBranch}; there is nothing to review.`)

  // The worker's git config must not shape what the reviewer sees: no colour, external diff tools or textconv filters.
  const plain = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv']
  const stat = await git(...plain, '--stat', base, head)
  const full = await exec('git', [...plain, base, head], cwd, signal)
  return { cwd, branch, baseBranch, base, head, ...pr ? { pr: { number: pr.number, url: pr.url } } : {}, stat,
    ...full.length <= maxDiffChars ? { diff: full } : {}, diffChars: full.length, notes }
}

interface PullRequest { number: number; url: string; baseRefName: string; headRefOid: string }

/**
 * The open PR of the current branch, or undefined when the branch has none. Refuses when `gh` fails for another reason
 * (auth, network, rate limit) or the branch's PR is closed or merged, rather than guessing the base branch.
 */
async function pullRequest(exec: Run, cwd: string, signal?: AbortSignal): Promise<PullRequest | undefined> {
  let output: string
  try { output = await exec('gh', ['pr', 'view', '--json', 'number,url,baseRefName,headRefOid,state'], cwd, signal) }
  catch (error) {
    const message = (error as Error).message
    if (/no (open )?pull requests? found/i.test(message)) return undefined
    throw new NotReviewable(`Could not look up this branch's PR with gh, so the base branch is unknown. Fix gh, then call review_changes again. ${message}`)
  }
  let value: PullRequest & { state?: string }
  try { value = JSON.parse(output) } catch { throw new NotReviewable(`gh pr view returned output that is not JSON: ${output.slice(0, 200)}`) }
  if (typeof value.number !== 'number' || !value.headRefOid || !value.baseRefName) {
    throw new NotReviewable('gh pr view did not return the PR number, base branch and head commit.')
  }
  if (value.state && value.state !== 'OPEN') {
    throw new NotReviewable(`PR #${value.number} for this branch is ${value.state.toLowerCase()}. Open a PR for the change, then call review_changes again.`)
  }
  return value
}

/** A detached checkout of one commit, apart from the worker's tree, that is removed after the review. */
export interface Checkout { path: string; remove(): Promise<void> }

/**
 * Checks `head` out into a new detached worktree under the system temp directory, so the reviewer's shell works in a tree
 * the worker never uses: nothing the reviewer runs there (a checkout, a test that writes files) changes the worker's tree.
 */
export async function reviewCheckout(cwd: string, head: string, exec: Run = run, signal?: AbortSignal): Promise<Checkout> {
  const path = await mkdtemp(join(tmpdir(), 'clean-review-'))
  const remove = async () => {
    // Not tied to the review's signal: the checkout is removed after a cancelled review too.
    await exec('git', ['worktree', 'remove', '--force', path], cwd).catch(() => undefined)
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
    await exec('git', ['worktree', 'prune'], cwd).catch(() => undefined)
  }
  try { await exec('git', ['worktree', 'add', '--quiet', '--detach', path, head], cwd, signal) }
  catch (error) { await remove(); throw error }
  return { path, remove }
}

/** The remote's default branch, from `origin/HEAD`. */
async function defaultBranch(git: (...args: string[]) => Promise<string>): Promise<string> {
  const ref = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')
  if (ref.startsWith('origin/')) return ref.slice('origin/'.length)
  throw new NotReviewable('There is no open PR for this branch and origin/HEAD is not set, so the base branch is unknown. Open the PR first.')
}
