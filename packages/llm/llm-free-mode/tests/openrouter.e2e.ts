import { describe, expect, it } from 'vitest'
import { readOpenRouterQuota } from '../src/quota.ts'

const apiKey = process.env['OPENROUTER_API_KEY']

describe.skipIf(apiKey === undefined)('OpenRouter key endpoint', () => {
  it('reads the daily free-model quota without a model request', { timeout: 30_000 }, async () => {
    const quota = await readOpenRouterQuota('openrouter', 'https://openrouter.ai/api/v1', apiKey ?? '', 20_000)
    expect(quota).toMatchObject({ provider: 'openrouter', state: 'known' })
    if (quota.state === 'known') expect(quota.remaining).toBeLessThanOrEqual(quota.limit)
  })
})
