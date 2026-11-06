import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, diagnose, exitCode, renderReport } from '../src/index.ts'
import type { FreeCheckReport } from '../src/index.ts'

const SECRET = 'sk-test-value'
const A = { provider: 'openrouter', model: 'a:free' }
const B = { provider: 'openrouter', model: 'b:free' }
const C = { provider: 'openrouter', model: 'c:free' }
const G = { provider: 'groq', model: 'g', freeTierConfirmed: true }
const free = { prompt: '0', completion: '0' }

function context(issues: unknown[] = [], enabled = true): Pick<Context, 'freeMode' | 'llm'> {
  return {
    freeMode: {
      currentSettings: () => ({ enabled, routes: [A, B, C, G], networkTimeoutMs: 1000 }),
      checkRoutes: () => Promise.resolve(issues),
      hasCatalog: (provider: string) => provider === 'openrouter',
      readQuota: (provider: string) => Promise.resolve(provider === 'openrouter'
        ? { provider, state: 'known', used: 12, limit: 50, remaining: 38 }
        : { provider, state: 'unknown' }),
    },
    llm: { providerAccess: () => ({ baseURL: 'https://openrouter.ai/api/v1' }) },
  } as unknown as Pick<Context, 'freeMode' | 'llm'>
}

function catalog(models: unknown[], status = 200): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: models }), { status }))))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('diagnose()', () => {
  it('separates usable, withdrawn, paid, unknown, and credential states', async () => {
    catalog([{ id: 'a:free', pricing: free }, { id: 'c:free', pricing: { prompt: '0.1', completion: '0' } }])
    const report = await diagnose(context([{
      route: G, problem: 'credential-missing', code: 'FREE_MODE_ROUTE_UNUSABLE', message: 'set GROQ_API_KEY',
    }]))
    expect(report.routes.map(route => route.state)).toEqual(['ok', 'model-withdrawn', 'model-now-paid', 'credential-missing'])
    expect(report.routes[3]?.action).toBe('set GROQ_API_KEY')
    expect(report.ready).toBe(false)
    expect(exitCode(report)).toBe(1)
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  it('reports an unreadable catalog as unknown, never as ok', async () => {
    catalog([], 500)
    const first = await diagnose(context())
    expect(first.routes.map(route => route.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    expect((await diagnose(context())).routes[0]?.state).toBe('unknown')
    catalog([{ id: 'a:free' }])
    expect((await diagnose(context())).routes[0]?.state).toBe('unknown')
  })

  it('skips network reads for an unknown provider', async () => {
    catalog([{ id: 'a:free', pricing: free }, { id: 'b:free', pricing: free }, { id: 'c:free', pricing: free }])
    const report = await diagnose(context([{ route: G, problem: 'provider-unknown', code: 'X', message: 'configure it' }]))
    expect(report.quota.map(quota => quota.provider)).toEqual(['openrouter'])
    expect(report.ready).toBe(true)
    expect(exitCode(report)).toBe(0)
  })

  it('is not ready while disabled, and exits successfully', async () => {
    catalog([])
    const report = await diagnose(context([], false))
    expect(report).toMatchObject({ enabled: false, ready: false })
    expect(exitCode(report)).toBe(0)
  })
})

describe('renderReport()', () => {
  it('prints states, actions, and quota', () => {
    const report: FreeCheckReport = {
      enabled: true,
      ready: true,
      routes: [{ ...A, state: 'ok' }, { ...B, state: 'model-withdrawn', action: 'remove it' }],
      quota: [
        { provider: 'openrouter', state: 'known', used: 12, limit: 50, remaining: 38 },
        { provider: 'groq', state: 'unknown' },
      ],
    }
    expect(renderReport(report)).toBe([
      'free mode: enabled, ready',
      '  ok                   openrouter/a:free',
      '  model-withdrawn      openrouter/b:free - remove it',
      '  quota openrouter: 12/50 used, 38 left today',
      '  quota groq: unknown',
      '',
    ].join('\n'))
  })

  it('shows the disabled state', () => {
    expect(renderReport({ enabled: false, ready: false, routes: [], quota: [] }))
      .toBe('free mode: disabled, not ready\n')
  })
})

describe('apply()', () => {
  function mount(args: string[], ctx: Record<string, unknown>) {
    const exit = vi.fn()
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const services: Record<string, unknown> = { appExit: exit, cmdlineArgs: { get: () => args } }
    apply({ ...ctx, get: (name: string) => services[name] } as unknown as Context)
    return { exit, write, errors }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the report and exits with its code', async () => {
    catalog([{ id: 'a:free', pricing: free }])
    const { exit, write } = mount([], context())
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
    expect(write.mock.calls[0]?.[0]).toContain('free mode: enabled, ready')
  })

  it('prints JSON on request', async () => {
    catalog([{ id: 'a:free', pricing: free }])
    const { exit, write } = mount(['--json'], context())
    await vi.waitFor(() => { expect(exit).toHaveBeenCalled() })
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ enabled: true })
  })

  it('exits 2 when the diagnostic itself fails', async () => {
    const broken = context()
    broken.freeMode.checkRoutes = () => Promise.reject(new Error('registry failure'))
    const { exit, errors } = mount([], broken)
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(2) })
    expect(errors.mock.calls[0]?.[0]).toBe('dsh: free-check failed: registry failure\n')
    const rejected = context()
    rejected.freeMode.checkRoutes = () => Promise.reject('plain') // oxlint-disable-line prefer-promise-reject-errors -- non-Error rejection path
    expect(mount([], rejected).exit).toBeDefined()
  })

  it('requires the launcher exit request', () => {
    expect(() => { apply({ get: () => undefined } as unknown as Context) }).toThrow('ctx.appExit')
  })
})
