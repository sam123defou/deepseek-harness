import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOpenRouterEndpoint, readOpenRouterQuota } from '../src/quota.ts'

const SECRET = 'sk-test-value'

function respond(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))))
}

function read() {
  return readOpenRouterQuota('openrouter', 'https://openrouter.ai/api/v1/', SECRET, 1000)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isOpenRouterEndpoint()', () => {
  it('matches the OpenRouter host only', () => {
    expect(isOpenRouterEndpoint('https://openrouter.ai/api/v1')).toBe(true)
    expect(isOpenRouterEndpoint('https://proxy.example/api/v1')).toBe(false)
    expect(isOpenRouterEndpoint('not a url')).toBe(false)
    expect(isOpenRouterEndpoint(undefined)).toBe(false)
  })
})

describe('readOpenRouterQuota()', () => {
  it('projects the daily free-model quota and authenticates the request', async () => {
    respond({ data: { free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } } })
    await expect(read()).resolves.toEqual({ provider: 'openrouter', state: 'known', used: 50, limit: 50, remaining: 0 })
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/key')
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${SECRET}`)
  })

  it('combines a caller signal with the time limit', async () => {
    respond({ data: { free_model_daily_requests: { used: 1, limit: 50, remaining: 49 } } })
    const signal = new AbortController().signal
    await expect(readOpenRouterQuota('openrouter', 'https://openrouter.ai/api/v1', SECRET, 1000, signal))
      .resolves.toMatchObject({ remaining: 49 })
  })

  it.each([
    ['an error status', () => { respond({}, 500) }],
    ['an unexpected body', () => { respond({ data: {} }) }],
    ['a network failure', () => vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error(`failed with ${SECRET}`))))],
  ])('stays unknown after %s, without exposing the key', async (_name, arrange) => {
    arrange()
    const result = await read()
    expect(result).toEqual({ provider: 'openrouter', state: 'unknown' })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})
