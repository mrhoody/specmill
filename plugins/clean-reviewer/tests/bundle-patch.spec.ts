/** The bundle patch, read with the entry-list dialect DSH reads bundle patches with, and the reviewer preset it defines. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { REVIEWER_PRESET } from '../src/review.ts'

interface Row { id?: string; name: string; disabled?: unknown; config?: Record<string, unknown> & { plugins?: Row[] } | Row[] }

async function patched(): Promise<Row[]> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema, applyEntryPatches } = await import(include) as {
    entryListSchema: unknown; applyEntryPatches(data: Row[], patches: unknown[], warn: (message: string) => void): Row[] }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  const patches = yaml.load(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as unknown[]
  const warnings: string[] = []
  const rows = applyEntryPatches([], patches, message => { warnings.push(message) })
  expect(warnings).toEqual([])
  return rows
}

const flat = (rows: readonly Row[]): Row[] => rows.flatMap(row => [row, ...Array.isArray(row.config) ? flat(row.config) : []])

it('inserts the core plugin and a read-only reviewer preset', async () => {
  const rows = await patched()
  expect(rows.map(row => row.id)).toEqual(['clean-reviewer', 'preset-specmill-reviewer'])
  expect(rows[0]?.name).toBe('@specmill/clean-reviewer')
  const preset = rows[1]?.config as { id?: string; plugins: Row[] }
  expect(preset.id).toBe(REVIEWER_PRESET)
  const plugins = flat(preset.plugins)
  const names = plugins.map(row => row.name)
  expect(plugins.filter(row => row.name === '@deepseek-ai/dsh-tool-fs').map(row => row.config)).toEqual([{ write: false, edit: false }])
  for (const name of ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-fs-search']) expect(names, name).toContain(name)
  // It reviews only: no delegation, questions to a person, web, scheduling, plan mode, presenting, or plugin tools.
  for (const name of ['@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-tool-present',
    '@deepseek-ai/dsh-plugin-manager/tools', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-tool-workflow']) expect(names, name).not.toContain(name)
})
