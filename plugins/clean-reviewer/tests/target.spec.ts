/** What a review covers: the pushed head against its base, and the refusals that keep the reviewed commit the PR's. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { NotReviewable, reviewCheckout, reviewTarget, run } from '../src/target.ts'
import { fixture, git, runner, type Fixture } from './helpers.ts'

let repo: Fixture
beforeEach(() => { repo = fixture() })
afterEach(() => repo.cleanup())

it('reviews the pushed branch against the merge base with the PR base branch', async () => {
  const head = git(repo.work, 'rev-parse', 'HEAD'), base = git(repo.work, 'rev-parse', 'origin/main')
  const target = await reviewTarget(repo.work, 10_000, runner({ number: 7, url: 'https://github.com/o/r/pull/7', baseRefName: 'main',
    headRefOid: head, state: 'OPEN' }))
  expect(target).toMatchObject({ branch: 'ticket', baseBranch: 'main', base, head, pr: { number: 7, url: 'https://github.com/o/r/pull/7' }, notes: [] })
  expect(target.stat).toContain('app.ts')
  expect(target.diff).toContain('-export const add = (a: number, b: number) => a + b')
  expect(target.diff).toContain('+export const add = (a: number, b: number) => a - b')
})

it('without a PR, uses the remote default branch and requires the branch pushed', async () => {
  git(repo.work, 'remote', 'set-head', 'origin', 'main')
  const target = await reviewTarget(repo.work, 10_000, runner())
  expect(target.pr).toBeUndefined()
  expect(target.baseBranch).toBe('main')
})

it('leaves a diff over the limit for the reviewer to read', async () => {
  const target = await reviewTarget(repo.work, 10, runner({ number: 7, url: 'u', baseRefName: 'main',
    headRefOid: git(repo.work, 'rev-parse', 'HEAD'), state: 'OPEN' }))
  expect(target.diff).toBeUndefined()
  expect(target.diffChars).toBeGreaterThan(10)
})

it('refuses uncommitted changes', async () => {
  writeFileSync(join(repo.work, 'app.ts'), 'changed\n')
  await expect(reviewTarget(repo.work, 10_000, runner())).rejects.toThrow(/uncommitted changes/)
})

it('refuses a head the PR does not show yet', async () => {
  const pushed = git(repo.work, 'rev-parse', 'HEAD')
  writeFileSync(join(repo.work, 'more.ts'), 'export {}\n')
  git(repo.work, 'add', '.'); git(repo.work, 'commit', '--quiet', '-m', 'more')
  const pr = { number: 7, url: 'u', baseRefName: 'main', headRefOid: pushed, state: 'OPEN' }
  await expect(reviewTarget(repo.work, 10_000, runner(pr))).rejects.toThrow(/Push the branch/)
  git(repo.work, 'remote', 'set-head', 'origin', 'main')
  await expect(reviewTarget(repo.work, 10_000, runner())).rejects.toThrow(/not pushed/)
})

it('refuses a branch with nothing to review, and a base it cannot tell', async () => {
  git(repo.work, 'checkout', '--quiet', 'main')
  git(repo.work, 'remote', 'set-head', 'origin', 'main')
  await expect(reviewTarget(repo.work, 10_000, runner())).rejects.toThrow(/nothing to review/)
  git(repo.work, 'checkout', '--quiet', 'ticket')
  git(repo.work, 'remote', 'set-head', 'origin', '--delete')
  await expect(reviewTarget(repo.work, 10_000, runner())).rejects.toBeInstanceOf(NotReviewable)
})

it('refuses a directory that is not a git checkout', async () => {
  await expect(reviewTarget(repo.root, 10_000, runner())).rejects.toThrow(/not a git checkout/)
})

const openPr = (head: string, extra: Record<string, unknown> = {}) =>
  ({ number: 7, url: 'u', baseRefName: 'main', headRefOid: head, state: 'OPEN', ...extra })

it('refuses when gh fails for a reason other than the branch having no PR, and for a closed PR', async () => {
  git(repo.work, 'remote', 'set-head', 'origin', 'main')
  const failing: typeof run = (command, args, cwd, signal) =>
    command === 'gh' ? Promise.reject(new Error('gh pr view failed: HTTP 401: Bad credentials')) : run(command, args, cwd, signal)
  await expect(reviewTarget(repo.work, 10_000, failing)).rejects.toThrow(/Could not look up this branch's PR with gh.*Bad credentials/)
  await expect(reviewTarget(repo.work, 10_000, runner(openPr(git(repo.work, 'rev-parse', 'HEAD'), { state: 'MERGED' }))))
    .rejects.toThrow(/PR #7 for this branch is merged/)
})

it('diffs without the worker\'s colour or external diff settings', async () => {
  git(repo.work, 'config', 'color.ui', 'always')
  git(repo.work, 'config', 'diff.external', 'false')
  const target = await reviewTarget(repo.work, 10_000, runner(openPr(git(repo.work, 'rev-parse', 'HEAD'))))
  expect(target.diff).toContain('+export const add = (a: number, b: number) => a - b')
  expect(target.diff).not.toContain('\x1b[')
  expect(target.stat).not.toContain('\x1b[')
})

it('reports the fetch error when the base branch cannot be fetched and has no local copy', async () => {
  const target = reviewTarget(repo.work, 10_000, runner(openPr(git(repo.work, 'rev-parse', 'HEAD'), { baseRefName: 'release/2.0' })))
  await expect(target).rejects.toThrow(/Could not fetch origin\/release\/2.0 and there is no local copy of it/)
})

it('checks the head out into a separate detached worktree and removes it', async () => {
  const head = git(repo.work, 'rev-parse', 'HEAD')
  const checkout = await reviewCheckout(repo.work, head)
  expect(checkout.path).not.toBe(repo.work)
  expect(git(checkout.path, 'rev-parse', 'HEAD')).toBe(head)
  expect(readFileSync(join(checkout.path, 'app.ts'), 'utf8')).toContain('a - b')
  git(checkout.path, 'checkout', '--quiet', 'main')
  writeFileSync(join(checkout.path, 'app.ts'), 'changed by the reviewer\n')
  expect(git(repo.work, 'status', '--porcelain')).toBe('')
  expect(git(repo.work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ticket')
  await checkout.remove()
  expect(existsSync(checkout.path)).toBe(false)
  expect(git(repo.work, 'worktree', 'list')).not.toContain(checkout.path)
})
