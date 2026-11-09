import { describe, expect, it } from 'vitest'
import { validateFreeModeSettings } from '../src/config.ts'
import type { FreeModeSettings, FreeRoute } from '../src/config.ts'

function settings(routes: FreeRoute[], enabled = true): FreeModeSettings {
  return { enabled, routes, rateLimitDelayMs: 5_000, maxFailoverMs: 55_000, maxRouteIdleMs: 20_000, networkTimeoutMs: 10_000 }
}

function codeOf(value: FreeModeSettings): unknown {
  try {
    validateFreeModeSettings(value)
    return undefined
  } catch (error: unknown) {
    return (error as { code: unknown }).code
  }
}

describe('validateFreeModeSettings()', () => {
  it('accepts free OpenRouter routes and confirmed routes of other providers', () => {
    expect(codeOf(settings([
      { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'groq', model: 'llama-3.3-70b-versatile', freeTierConfirmed: true },
    ]))).toBeUndefined()
  })

  it.each([
    ['an empty list', [], 'FREE_MODE_EMPTY_LIST'],
    ['a paid OpenRouter route', [{ provider: 'openrouter', model: 'google/gemma-4-31b-it' }], 'FREE_MODE_PAID_ROUTE'],
    ['an unconfirmed provider', [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }], 'FREE_MODE_UNCONFIRMED_ROUTE'],
    ['a duplicate route', [
      { provider: 'openrouter', model: 'a:free' },
      { provider: 'openrouter', model: 'a:free' },
    ], 'FREE_MODE_DUPLICATE_ROUTE'],
  ])('refuses %s', (_name, routes, code) => {
    expect(codeOf(settings(routes as FreeRoute[]))).toBe(code)
  })

  it('keeps a disabled list without checking it', () => {
    const disabled = settings([{ provider: 'openrouter', model: 'paid' }], false)
    expect(codeOf(disabled)).toBeUndefined()
    expect(disabled.routes).toHaveLength(1)
  })
})
