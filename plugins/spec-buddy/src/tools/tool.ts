/** The small tool contract Spec Buddy registers on its own Sessions. */
import type { ZodType } from 'zod'

export interface Tool {
  name: string
  description: string
  schema: ZodType
  execute(input: unknown, signal: AbortSignal): Promise<unknown>
}

export type RegisterTool = (name: string, description: string, schema: ZodType,
  execute: (input: unknown, signal: AbortSignal) => Promise<unknown>) => void
