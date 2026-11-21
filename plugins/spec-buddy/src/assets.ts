/** Loads the packaged prompt and skill from either the source tree or the compiled `lib/` output. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined

/** The package root, found by walking up to the manifest named `@specmill/spec-buddy`. */
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === '@specmill/spec-buddy') return cached = directory
      } catch { /* A foreign package.json on the way up is not this package. */ }
    }
    directory = dirname(directory)
  }
  throw new Error('@specmill/spec-buddy package root not found')
}

/** Absolute path to a packaged file. */
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)

/** The system prompt and `spec-writing` skill bundled with the plugin. */
export function loadAssets(): { prompt: string; skill: { content: string; description: string; path: string } } {
  const prompt = readFileSync(packagePath('prompts', 'system.md'), 'utf8')
  const skillPath = packagePath('skills', 'spec-writing', 'SKILL.md')
  return {
    prompt,
    skill: {
      content: readFileSync(skillPath, 'utf8'),
      description: 'Use when writing or revising a spec: the required eight-section template, what belongs in each section, '
        + 'and the rule that one spec is one dsh-superagent Ticket.',
      path: dirname(skillPath),
    },
  }
}
