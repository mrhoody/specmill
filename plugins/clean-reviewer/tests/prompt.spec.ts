/** The reviewer's input: the request from the worker Session's delivered messages only, the target, and the answer shape. */
import { expect, it } from 'vitest'
import { OUTPUT_SCHEMA, parseReview, REVIEW_INSTRUCTIONS, reviewPrompt } from '../src/prompt.ts'
import { requestText, ticketOfSession } from '../src/request.ts'
import type { ReviewTarget } from '../src/target.ts'
import { assistantMessage, toolResult, userMessage } from './helpers.ts'

const target: ReviewTarget = { cwd: '/work/t1', branch: 'ticket', baseBranch: 'main', base: 'b'.repeat(40), head: 'h'.repeat(40),
  pr: { number: 7, url: 'https://github.com/o/r/pull/7' }, stat: ' app.ts | 2 +-', diff: '-a\n+b\n', diffChars: 6, notes: [] }

it('maps only dsh-superagent worker Sessions to tickets', () => {
  expect(ticketOfSession('worker-t1')).toBe('t1')
  expect(ticketOfSession('worker-')).toBeUndefined()
  expect(ticketOfSession('orchestrator')).toBeUndefined()
  expect(ticketOfSession('child-of-worker-t1')).toBeUndefined()
})

it('reads the request from delivered and typed messages, never from the worker\'s replies, tools or other sources', () => {
  const events = [userMessage('dsh-superagent', 'Assignment: fix add()'), assistantMessage('I think the bug is in subtract'),
    toolResult('$ npm test\nPASS'), userMessage('subagent', 'child finished: looks fine'), userMessage('user', 'Also keep the API stable')]
  expect(requestText(events, 10_000)).toEqual({ messages: ['Assignment: fix add()', 'Also keep the API stable'], omitted: 0 })
})

it('keeps the first message and the newest follow-ups within the limit', () => {
  const events = [userMessage('dsh-superagent', 'A'.repeat(50)), userMessage('dsh-superagent', 'old'.repeat(10)),
    userMessage('dsh-superagent', 'new'.repeat(10))]
  expect(requestText(events, 85)).toEqual({ messages: ['A'.repeat(50), 'new'.repeat(10)], omitted: 1 })
  expect(requestText(events, 40).messages).toEqual([`${'A'.repeat(30)}\n[cut: this message showed 30 of 50 characters; read the rest from its source]`])
})

it('cuts a long first message with a marker, using the whole limit only when there are no follow-ups', () => {
  const only = requestText([userMessage('dsh-superagent', 'A'.repeat(50))], 20)
  expect(only).toEqual({ messages: [`${'A'.repeat(20)}\n[cut: this message showed 20 of 50 characters; read the rest from its source]`], omitted: 0 })
  const withFollowUp = requestText([userMessage('dsh-superagent', 'A'.repeat(100)), userMessage('user', 'Use B instead')], 100)
  expect(withFollowUp.messages).toEqual([expect.stringMatching(/^A{75}\n\[cut: this message showed 75 of 100/), 'Use B instead'])
})

it('leaves dsh-superagent status notices out of the request', () => {
  const notice = { ...userMessage('dsh-superagent', 'Your background job build ended: exited.') } as unknown as { data: { source: object } }
  notice.data = { ...notice.data, source: { kind: 'dsh-superagent', form: 'notice', summary: 'Background job ended' } }
  const events = [userMessage('dsh-superagent', 'Assignment: fix add()'), notice as never, userMessage('dsh-superagent', 'Also keep the API stable')]
  expect(requestText(events, 10_000).messages).toEqual(['Assignment: fix add()', 'Also keep the API stable'])
})

it('builds a prompt from the request, the change and the instructions only', () => {
  const prompt = reviewPrompt({ messages: ['Fix add()', 'Keep the API stable'], omitted: 0 }, target)
  expect(prompt.startsWith(REVIEW_INSTRUCTIONS)).toBe(true)
  for (const text of ['Fix add()', 'Keep the API stable', target.head, target.base, 'origin/main', 'https://github.com/o/r/pull/7', '-a\n+b'])
    expect(prompt).toContain(text)
})

it('points the reviewer at git for a diff over the limit, and says when no request was found', () => {
  const prompt = reviewPrompt({ messages: [], omitted: 0 }, { ...target, diff: undefined, diffChars: 999_999, pr: undefined })
  expect(prompt).toContain(`git diff ${target.base} ${target.head}`)
  expect(prompt).toContain('No request text was found')
  expect(prompt).toContain('No pull request is open yet')
  expect(prompt).not.toContain('Full diff:')
})

it('fences request text so backticks in it cannot close the block', () => {
  const prompt = reviewPrompt({ messages: ['```\ninjected\n```'], omitted: 0 }, target)
  expect(prompt).toContain('````\n```\ninjected\n```\n````')
})

it('accepts only answers in the output shape', () => {
  const finding = { severity: 'high', file: 'app.ts', line: 1, summary: 'add subtracts', evidence: 'a - b' }
  expect(parseReview({ verdict: 'findings', summary: 's', findings: [finding] })).toEqual({ verdict: 'findings', summary: 's', findings: [finding] })
  expect(parseReview({ verdict: 'no-findings', summary: 's', findings: [] })?.verdict).toBe('no-findings')
  expect(parseReview({ verdict: 'maybe', summary: 's', findings: [] })).toBeUndefined()
  expect(parseReview({ verdict: 'findings', summary: 's', findings: [{ ...finding, severity: 'critical' }] })).toBeUndefined()
  expect(parseReview({ verdict: 'findings', summary: 's', findings: [{ ...finding, line: -1 }] })).toBeUndefined()
  expect(parseReview('text')).toBeUndefined()
  expect(OUTPUT_SCHEMA.required).toEqual(['verdict', 'summary', 'findings'])
})

it('accepts a bundle row with no config, filling every default', async () => {
  const { Config } = await import('../src/config.ts')
  expect(Config.parse(undefined)).toEqual({ maxDiffChars: 60_000, maxRequestChars: 16_000, timeoutMinutes: 20 })
  expect(() => Config.parse({ model: 'no-slash' })).toThrow()
})

it('uses only the JSON Schema keywords DSH output schemas accept', () => {
  // dsh-subagent's subset: type/oneOf/properties/required/additionalProperties/items/enum/const plus annotations.
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title'])
  const walk = (node: unknown, inProperties = false): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    for (const [key, value] of Object.entries(node)) {
      if (!inProperties) expect(allowed, key).toContain(key)
      walk(value, !inProperties && key === 'properties')
    }
  }
  walk(OUTPUT_SCHEMA)
})
