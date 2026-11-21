/** The review_changes tool: only on worker Sessions, no arguments, a fresh reviewer briefed by the plugin, and fail-closed refusals. */
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { decorate } from '../src/index.ts'
import { REVIEWER_PRESET, reviewChanges, SPAWN_PROVIDER, TOOL_NAME, type ReviewHost, type Subagents, type SubagentResult } from '../src/review.ts'
import { assistantMessage, fakeAgent, fixture, git, runner, toolResult, userMessage, type Fixture } from './helpers.ts'

let repo: Fixture
beforeEach(() => { repo = fixture() })
afterEach(() => repo.cleanup())

const config = Config.parse({ model: 'deepseek/reviewer-model', reasoningEffort: 'high' })

function subagents(result: Partial<SubagentResult> | Error) {
  const started: Parameters<Subagents['startActivation']>[0][] = []
  let disposed = 0
  const service: Subagents = {
    async startActivation(spec) {
      started.push(spec)
      return { childId: 'child-1', dispose: async () => { disposed++ },
        result: result instanceof Error ? Promise.reject(result) : Promise.resolve({ output: [], stopReason: 'completed', ...result }) }
    },
  }
  return { service, started, disposed: () => disposed }
}

const host = (service: Subagents | undefined, pr = true): ReviewHost => ({ config, subagents: () => service,
  run: runner(pr ? { number: 7, url: 'https://github.com/o/r/pull/7', baseRefName: 'main', headRefOid: git(repo.work, 'rev-parse', 'HEAD'), state: 'OPEN' } : undefined) })

const signal = () => new AbortController().signal

it('registers review_changes with no arguments on worker Sessions only, once each', () => {
  const registrations = new Map()
  const worker = fakeAgent('worker-t1', repo.work)
  expect(decorate(worker.agent, host(undefined), registrations)).toBe(true)
  expect(decorate(worker.agent, host(undefined), registrations)).toBe(false)
  expect(worker.registered.map(tool => tool.name)).toEqual([TOOL_NAME])
  expect(worker.registered[0]!.parameters).toMatchObject({ type: 'object', properties: {}, additionalProperties: false })
  for (const id of ['orchestrator', 'spawned-child-1']) {
    const other = fakeAgent(id, repo.work)
    expect(decorate(other.agent, host(undefined), registrations)).toBe(false)
    expect(other.registered).toEqual([])
  }
})

it('starts a fresh reviewer under the reviewer preset with a plugin-built brief that holds nothing of the worker\'s conversation', async () => {
  const events = [userMessage('dsh-superagent', 'Assignment: make add() correct'), assistantMessage('WORKER-REASONING: subtract is intended'),
    toolResult('WORKER-TOOL-OUTPUT')]
  const { agent } = fakeAgent('worker-t1', repo.work, events)
  const finding = { severity: 'high', file: 'app.ts', line: 1, summary: 'add subtracts', evidence: 'a - b' }
  const fake = subagents({ structured: { verdict: 'findings', summary: 'add is wrong', findings: [finding] } })
  const result = await reviewChanges(agent, host(fake.service), signal())

  expect(fake.started).toHaveLength(1)
  const spec = fake.started[0]!
  expect(spec).toMatchObject({ provider: SPAWN_PROVIDER, delivery: 'caller',
    request: { agentPreset: REVIEWER_PRESET, parent: agent, agentOptions: { provider: 'deepseek', model: 'reviewer-model', reasoningEffort: 'high' } } })
  // The reviewer runs in a throwaway checkout of the head commit, removed once the review is done.
  expect(spec.request.cwd).not.toBe(repo.work)
  expect(existsSync(spec.request.cwd)).toBe(false)
  expect(fake.disposed()).toBe(1)
  const brief = spec.request.prompt.map(block => block.text).join('\n')
  expect(brief).toContain('Assignment: make add() correct')
  expect(brief).toContain('+export const add = (a: number, b: number) => a - b')
  expect(brief).not.toContain('WORKER-REASONING')
  expect(brief).not.toContain('WORKER-TOOL-OUTPUT')
  expect(result).toMatchObject({ reviewed: true, reviewed_head: git(repo.work, 'rev-parse', 'HEAD'), base_branch: 'main',
    pr: { number: 7 }, reviewer_session: 'child-1', verdict: 'findings', findings: [finding] })
})

it('returns unstructured text when the reviewer completes without the structured answer', async () => {
  const { agent } = fakeAgent('worker-t1', repo.work)
  const fake = subagents({ output: [{ type: 'text', text: 'Looks fine to me.' }] })
  expect(await reviewChanges(agent, host(fake.service), signal())).toMatchObject({ reviewed: true, structured: false, output: 'Looks fine to me.' })
})

it('reports a review that ended early as not reviewed', async () => {
  const { agent } = fakeAgent('worker-t1', repo.work)
  const fake = subagents({ stopReason: 'error', diagnostic: 'model unavailable', output: [{ type: 'text', text: 'partial' }] })
  expect(await reviewChanges(agent, host(fake.service), signal()))
    .toMatchObject({ reviewed: false, reason: 'The review ended early (error): model unavailable', partial_output: 'partial' })
  const failing = subagents(new Error('capture failed'))
  expect(await reviewChanges(agent, host(failing.service), signal())).toMatchObject({ reviewed: false, reason: 'The review failed: capture failed' })
})

it('fails closed without starting a reviewer when the review cannot run', async () => {
  const fake = subagents({})
  expect(await reviewChanges(fakeAgent('orchestrator', repo.work).agent, host(fake.service), signal()))
    .toMatchObject({ reviewed: false, reason: expect.stringMatching(/worker Session/) })
  expect(await reviewChanges(fakeAgent('worker-t1', repo.work).agent, host(undefined), signal()))
    .toMatchObject({ reviewed: false, reason: expect.stringMatching(/subagent service/) })
  const pushed = host(fake.service)
  git(repo.work, 'commit', '--quiet', '--allow-empty', '-m', 'unpushed')
  expect(await reviewChanges(fakeAgent('worker-t1', repo.work).agent, pushed, signal()))
    .toMatchObject({ reviewed: false, reason: expect.stringMatching(/Push the branch/) })
  expect(fake.started).toEqual([])
})

it('stops the reviewer when the worker\'s call is cancelled', async () => {
  const { agent } = fakeAgent('worker-t1', repo.work)
  let disposed = 0
  let reject!: (error: Error) => void
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const service: Subagents = { async startActivation() {
    started()
    return { childId: 'child-1', result: new Promise((_, no) => { reject = no }), dispose: async () => { disposed++; reject(new Error('stopped')) } }
  } }
  const controller = new AbortController()
  const pending = reviewChanges(agent, host(service), controller.signal)
  await running
  await new Promise(resolve => setTimeout(resolve, 0))
  controller.abort()
  expect(await pending).toMatchObject({ reviewed: false, reason: 'The review failed: stopped' })
  expect(disposed).toBe(1)
})

it('stops the reviewer when the worker\'s call is cancelled while it is still starting', async () => {
  const { agent } = fakeAgent('worker-t1', repo.work)
  let disposed = 0
  const controller = new AbortController()
  let reject!: (error: Error) => void
  const service: Subagents = { async startActivation() {
    controller.abort()
    return { childId: 'child-1', result: new Promise((_, no) => { reject = no }), dispose: async () => { disposed++; reject(new Error('stopped')) } }
  } }
  expect(await reviewChanges(agent, host(service), controller.signal)).toMatchObject({ reviewed: false, reason: 'The review failed: stopped' })
  expect(disposed).toBe(1)
})
