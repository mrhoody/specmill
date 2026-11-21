/** The loopback-only health route `scripts/spec-buddy status` reads. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Runtime } from './runtime.ts'

const HEALTH_PATH = '/spec-buddy/api/health'

function loopback(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

/** Registers `GET /spec-buddy/api/health` on the loopback Web server and returns its disposer. */
export function registerHealth(ctx: Context, runtime: Runtime): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('spec-buddy health requires a loopback Web server')
  return ctx.webServer.register({ kind: 'prefix', path: '/spec-buddy', handler: (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== HEALTH_PATH) { res.writeHead(404); res.end(); return }
    if (req.method !== 'GET') { json(res, 405, { error: 'Only GET is supported' }); return }
    if (!loopback(req, ctx.webServer.port)) { json(res, 403, { error: 'Loopback request required' }); return }
    json(res, 200, runtime.view())
  } })
}
