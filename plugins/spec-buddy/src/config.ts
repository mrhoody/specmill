/** The core plugin's configuration: where state lives, the repository to spec, and the GitHub account that files issues. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const absolute = (label: string) => z.string().min(1).refine(isAbsolute, { message: `${label} must be an absolute path` })
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export const GithubConfig = z.object({
  /** `owner/name` of the repository whose issues spec-buddy files. */
  repo: z.string().regex(REPOSITORY, { message: 'github.repo must be owner/name' }),
  /** dsh-superagent's own GitHub login, mentioned on the final line of every filed issue. */
  agentLogin: z.string().regex(LOGIN, { message: 'github.agentLogin must be a GitHub login' }),
  /** The `GH_CONFIG_DIR` holding spec-buddy's own machine-user login. */
  configDir: absolute('github.configDir'),
}).strict()

export const Config = z.object({
  /** Absolute directory that holds the state file and the process lock. */
  stateDir: absolute('stateDir'),
  github: GithubConfig,
  /** A read-only local clone of `github.repo` that Spec Buddy sessions read. */
  repoCheckout: absolute('repoCheckout'),
  /** Optional `provider/model` selection; the profile default is used when omitted. */
  model: z.string().min(1).optional(),
}).strict()

export type Config = z.infer<typeof Config>

/** Split an optional `provider/model` selection. */
export function modelSelection(model: string | undefined): { provider: string; model: string } | undefined {
  if (!model) return undefined
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) }
}
