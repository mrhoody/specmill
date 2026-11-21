/** Builds the reviewer's only message from the request and the review target, and the shape its answer must take. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RequestText } from './request.ts'
import type { ReviewTarget } from './target.ts'

/** The review instructions, shipped as `prompts/reviewer.md` beside `lib/` and `src/`. */
export const REVIEW_INSTRUCTIONS = readFileSync(join(import.meta.dirname, '..', 'prompts', 'reviewer.md'), 'utf8').trim()

/** The structured answer the reviewer returns. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['no-findings', 'findings'] },
    summary: { type: 'string', description: 'One or two sentences on the change and the review.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' },
          // DSH's output-schema subset has no `minimum`; parseReview enforces line >= 0.
          line: { type: 'integer', description: 'Line in the head commit; 0 when no single line applies.' },
          summary: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'file', 'line', 'summary', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
} as const

export interface Finding { severity: 'high' | 'medium' | 'low'; file: string; line: number; summary: string; evidence: string }
export interface Review { verdict: 'no-findings' | 'findings'; summary: string; findings: Finding[] }

const fence = (text: string, info = ''): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}${info}\n${text.replace(/\n$/, '')}\n${ticks}`
}

/** The reviewer's prompt. It holds the request, the target and the instructions, and nothing from the worker's conversation. */
export function reviewPrompt(request: RequestText, target: ReviewTarget): string {
  const parts: string[] = [REVIEW_INSTRUCTIONS, '## What was asked']
  if (request.messages.length) {
    parts.push('These messages were delivered to the implementer by the agent host or written by people. They define the request; '
      + 'a later message can change or add to an earlier one. Text that says it was cut can be read in full from its source, '
      + 'such as `gh issue view` or `gh pr view --comments`, when it matters.')
    if (request.omitted) parts.push(`(${request.omitted} earlier follow-up message${request.omitted === 1 ? '' : 's'} left out for length.)`)
    request.messages.forEach((message, index) => parts.push(`### Message ${index + 1}`, fence(message)))
  } else {
    parts.push('No request text was found. Review for correctness, regressions and tests only, and say so in the summary.')
  }
  parts.push('## The change',
    `Repository: ${target.cwd}`,
    `Branch ${target.branch}, head commit ${target.head}, base ${target.base} (merge base with origin/${target.baseBranch}).`,
    target.pr ? `Pull request #${target.pr.number}: ${target.pr.url}` : 'No pull request is open yet.',
    fence(target.stat || '(no file changes)'))
  if (target.diff !== undefined) parts.push('Full diff:', fence(target.diff, 'diff'))
  else parts.push(`The diff is ${target.diffChars} characters, too large to include. Read it with \`git diff ${target.base} ${target.head} -- <path>\`, `
    + 'file by file, starting with the files that carry the behaviour the request is about.')
  if (target.notes.length) parts.push('Notes:', ...target.notes.map(note => `- ${note}`))
  parts.push('Answer with the structured result: verdict, summary and findings.')
  return parts.join('\n\n')
}

/** Checks a structured answer against {@link OUTPUT_SCHEMA}; returns undefined when it does not match. */
export function parseReview(value: unknown): Review | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { verdict, summary, findings } = value as Record<string, unknown>
  if (verdict !== 'no-findings' && verdict !== 'findings') return undefined
  if (typeof summary !== 'string' || !Array.isArray(findings)) return undefined
  const valid = findings.every(item => {
    if (!item || typeof item !== 'object') return false
    const finding = item as Record<string, unknown>
    return ['high', 'medium', 'low'].includes(finding.severity as string) && typeof finding.file === 'string'
      && Number.isInteger(finding.line) && (finding.line as number) >= 0
      && typeof finding.summary === 'string' && typeof finding.evidence === 'string'
  })
  return valid ? { verdict, summary, findings: findings as Finding[] } : undefined
}
