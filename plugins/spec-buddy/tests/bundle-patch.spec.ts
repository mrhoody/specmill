/** The bundle patch, read with the entry-list dialect DSH reads bundle patches with, and the preset it defines. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'

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

it('inserts the core plugin, the Slack provider, and the Spec Buddy preset', async () => {
  const rows = await patched()
  expect(rows.map(row => row.id)).toEqual(['spec-buddy', 'spec-buddy-slack', 'preset-specmill-spec-buddy'])
  expect(rows[0]?.name).toBe('@specmill/spec-buddy')
  expect(rows[1]?.name).toBe('@specmill/spec-buddy/slack-watch')
  const preset = rows[2]?.config as { id?: string; order?: number; plugins: Row[] }
  expect(preset).toMatchObject({ id: 'specmill-spec-buddy', order: 92 })
  const plugins = flat(preset.plugins)
  const named = (name: string) => plugins.filter(row => row.name === name).map(row => row.config)
  expect(named('@deepseek-ai/dsh-tool-fs')).toEqual([{ write: false, edit: false }])
  expect(named('@deepseek-ai/dsh-tool-web')).toEqual([{ fetch: true }])
  for (const name of ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-time-context',
    '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction-tool-result-pruner'])
    expect(named(name).length, name).toBeGreaterThan(0)
  // Reads and talks only: no shell, jobs, subagents, write tools, plan mode, scheduling, questions, presenting, or plugin tools.
  const names = plugins.map(row => row.name)
  for (const name of ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-bash-sandbox',
    '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control',
    '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present',
    '@deepseek-ai/dsh-plugin-manager/tools', '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names, name).not.toContain(name)
})
