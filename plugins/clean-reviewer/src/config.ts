/** The plugin's configuration: the reviewer's model and the size and time limits of one review. */
import { z } from 'zod'

export const Config = z.object({
  /** Optional `provider/model` for the reviewer; the worker's model is used when omitted. */
  model: z.string().regex(/^[^/]+\/.+$/, { message: 'model must be provider/model' }).optional(),
  /** Optional reasoning effort for the reviewer, such as `high`. */
  reasoningEffort: z.string().min(1).optional(),
  /** Largest diff, in characters, given to the reviewer inline; a larger diff is read by the reviewer itself. */
  maxDiffChars: z.number().int().positive().default(60_000),
  /** Largest amount of ticket request text, in characters, given to the reviewer. */
  maxRequestChars: z.number().int().positive().default(16_000),
  /** How long one review may run before it is stopped. */
  timeoutMinutes: z.number().int().positive().max(120).default(20),
// The bundle row has no `config`, so Cordis passes undefined; `prefault` parses `{}` in its place and fills the defaults.
}).strict().prefault({})

export type Config = z.infer<typeof Config>

/** The reviewer's model overrides, or undefined to use the worker's model. */
export function agentOptions(config: Pick<Config, 'model' | 'reasoningEffort'>): Record<string, string> | undefined {
  const options: Record<string, string> = {}
  if (config.model) {
    const slash = config.model.indexOf('/')
    options.provider = config.model.slice(0, slash)
    options.model = config.model.slice(slash + 1)
  }
  if (config.reasoningEffort) options.reasoningEffort = config.reasoningEffort
  return Object.keys(options).length ? options : undefined
}
