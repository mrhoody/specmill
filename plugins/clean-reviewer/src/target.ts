/**
 * Finds what a review covers in a worker's ticket directory: the pushed head commit, the base it branched from, and the
 * diff between them. Refuses work the PR does not show yet, so the reviewed commit is the one people see.
 */
import { execFile } from 'node:child_process'

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
  try { await git('fetch', '--quiet', 'origin', baseBranch) }
  catch (error) { notes.push(`Could not fetch origin/${baseBranch}; reviewed against the local copy. ${(error as Error).message}`) }
  let base: string
  try { base = await git('merge-base', 'HEAD', `origin/${baseBranch}`) }
  catch { throw new NotReviewable(`No common history with origin/${baseBranch}.`) }
  if (base === head) throw new NotReviewable(`HEAD has no changes against origin/${baseBranch}; there is nothing to review.`)

  const stat = await git('diff', '--stat', base, head)
  const full = await exec('git', ['diff', base, head], cwd, signal)
  return { cwd, branch, baseBranch, base, head, ...pr ? { pr: { number: pr.number, url: pr.url } } : {}, stat,
    ...full.length <= maxDiffChars ? { diff: full } : {}, diffChars: full.length, notes }
}

interface PullRequest { number: number; url: string; baseRefName: string; headRefOid: string }

/** The open PR of the current branch, or undefined when there is none or `gh` cannot tell. */
async function pullRequest(exec: Run, cwd: string, signal?: AbortSignal): Promise<PullRequest | undefined> {
  try {
    const value = JSON.parse(await exec('gh', ['pr', 'view', '--json', 'number,url,baseRefName,headRefOid,state'], cwd, signal)) as
      PullRequest & { state?: string }
    if (value.state && value.state !== 'OPEN') return undefined
    return typeof value.number === 'number' && value.headRefOid ? value : undefined
  } catch { return undefined }
}

/** The remote's default branch, from `origin/HEAD`. */
async function defaultBranch(git: (...args: string[]) => Promise<string>): Promise<string> {
  const ref = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')
  if (ref.startsWith('origin/')) return ref.slice('origin/'.length)
  throw new NotReviewable('There is no open PR for this branch and origin/HEAD is not set, so the base branch is unknown. Open the PR first.')
}
