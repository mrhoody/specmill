/** Tests for scripts/spec-buddy using a temporary checkout path with spaces and stubbed ps, tmux, and dsh binaries. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync }
  from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let root: string
let server: Server | undefined
let sleepers: ChildProcess[] = []
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)
const program = (name: string, body: string) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
const service = (pid: number, profile = 'spec-buddy') => `${pid} node node /opt/my tools/dsh --profile ${profile} --no-open`
function sleeper(ignoreInterrupt = false): number {
  const [command, args] = ignoreInterrupt ? ['sh', ['-c', 'trap "" INT; exec sleep 60']] as const : ['sleep', ['60']] as const
  const child = spawn(command, [...args], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid!
}
const processes = (...lines: string[]) => writeFileSync(join(root, 'ps.txt'), lines.map(line => `${line}\n`).join(''))
const started = (...lines: string[]) => writeFileSync(join(root, 'ps-started.txt'), lines.map(line => `${line}\n`).join(''))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spec buddy script '))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'spec-buddy'), join(root, 'scripts', 'spec-buddy'))
  processes()
  program('ps', `list='${root}/ps.txt'; [ -f '${root}/launched' ] && [ -f '${root}/ps-started.txt' ] && list='${root}/ps-started.txt'
want=; while [ $# -gt 0 ]; do [ "$1" = -p ] && want=$2; shift; done
while IFS= read -r line; do
  pid=\${line%% *}; kill -0 "$pid" 2>/dev/null || continue
  if [ -z "$want" ] || [ "$pid" = "$want" ]; then printf '%s\\n' "$line"; fi
done < "$list"`)
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 1;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  program('dsh', 'exit 0')
})
afterEach(() => {
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  rmSync(root, { recursive: true, force: true })
})
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [join(root, 'scripts', 'spec-buddy'), ...args],
    { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_SPEC_BUDDY_PROFILE: '', DSH_SPEC_BUDDY_URL: '' },
      timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const ready = (overrides: Record<string, unknown> = {}) => ({
  runtime: { state: 'ready', detail: 'Spec Buddy is listening' },
  github: { state: 'ready', detail: 'Signed in as spec-buddy' },
  state: { state: 'ready', detail: '/tmp/state' },
  sessions: { state: 'ready', detail: 'No Session delivery has failed' },
  providers: { slack: { state: 'ready', detail: 'Connected over Socket Mode' }, inbound: { state: 'ready', detail: '' } },
  summary: { conversations: 1, approved: 1, filed: 1 },
  ...overrides,
})
async function answering(payload: unknown = ready(), always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const status = async (profile: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }

it('reports a stopped service as exit 1', async () => {
  expect(await run('status')).toMatchObject({ code: 1 })
  expect(await status('spec-buddy')).toMatchObject({ pids: [], manually_stopped: false })
})
it('exits 0 when ready, 2 when a provider reports an error, and 3 while setup waits', async () => {
  processes(service(sleeper()))
  expect(await run('status', '--url', await answering(ready(), true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering(ready({ providers: { slack: { state: 'error', detail: 'bad token' },
    inbound: { state: 'ready', detail: '' } } }), true))).toMatchObject({ code: 2 })
  server!.close()
  expect(await run('status', '--url', await answering(ready({ setup: { problem: { detail: 'Add Slack tokens' } } }), true)))
    .toMatchObject({ code: 3 })
})
it('keeps a stop per profile and honours --respect-stop', async () => {
  expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(await status('one')).toMatchObject({ manually_stopped: true })
  expect(await status('two')).toMatchObject({ manually_stopped: false })
  expect(await run('--respect-stop', 'start', '--profile', 'one')).toMatchObject({ code: 0,
    stdout: expect.stringContaining('Intentional stop is active') })
})
it('starts in tmux, records the pane pid, and refuses a second copy', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  expect(readFileSync(join(control('spec-buddy'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  const tmux = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').find(call => call.startsWith('new-session'))!.split('\n')
  expect(tmux.find(word => word.startsWith('umask 077; exec '))).toContain('--profile spec-buddy --no-open')
  const second = sleeper()
  started(service(pid), `${second} node node /opt/dsh --profile spec-buddy`)
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Multiple spec-buddy processes') })
}, 20_000)
it('keeps only the newest logs it wrote for the profile', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  for (let index = 0; index < 25; index++) {
    const log = join(root, '.artifacts', `spec-buddy-spec-buddy-20260901-0000${String(index).padStart(2, '0')}-1.log`)
    writeFileSync(log, '')
    utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
  }
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  expect(readdirSync(join(root, '.artifacts')).filter(name => name.startsWith('spec-buddy-spec-buddy-'))).toHaveLength(20)
}, 20_000)
