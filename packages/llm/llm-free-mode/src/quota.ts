/**
 * Read of the free-model daily quota from the OpenRouter key endpoint. The
 * failover uses it because a 429 body does not separate the per-minute limit
 * from the daily limit.
 * @module @deepseek-ai/dsh-llm-free-mode/quota
 */

import { z } from 'zod'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/** Daily free-model quota of one provider; `unknown` covers unsupported and failed reads. */
export type FreeModeQuota =
  | { readonly provider: string; readonly state: 'known'; readonly used: number; readonly limit: number; readonly remaining: number }
  | { readonly provider: string; readonly state: 'unknown' }

const keyResponseSchema = z.object({
  data: z.object({
    free_model_daily_requests: z.object({
      used: z.number(),
      limit: z.number(),
      remaining: z.number(),
    }),
  }),
})

/**
 * Tell whether an endpoint is OpenRouter, the only provider with a quota read.
 * @param baseURL - endpoint root of the route.
 * @returns true for the OpenRouter host.
 */
export function isOpenRouterEndpoint(baseURL: string | undefined): boolean {
  if (baseURL === undefined || !URL.canParse(baseURL)) return false
  return new URL(baseURL).hostname === 'openrouter.ai'
}

/**
 * Read the daily quota. Failures of any kind yield `unknown`, and neither the
 * key nor the response body reaches the result.
 * @param provider - provider route being read.
 * @param baseURL - OpenRouter endpoint root.
 * @param apiKey - credential value used only for the request header.
 * @param timeoutMs - limit of the request.
 * @param signal - optional cancellation.
 * @returns the quota, or the `unknown` state.
 */
export async function readOpenRouterQuota(
  provider: string,
  baseURL: string,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FreeModeQuota> {
  const deadline = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/key`, {
      headers: { ...attributionHeaders(), authorization: `Bearer ${apiKey}` },
      signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    })
    if (!response.ok) return { provider, state: 'unknown' }
    const parsed = keyResponseSchema.safeParse(await response.json())
    if (!parsed.success) return { provider, state: 'unknown' }
    return { provider, state: 'known', ...parsed.data.data.free_model_daily_requests }
  } catch (_quotaReadFailure) {
    // Network, abort, and JSON failures all mean the quota stays unknown; the
    // failover then continues inside its time limit.
    return { provider, state: 'unknown' }
  }
}
