/**
 * Free-mode settings: self-contained validation and route checks that need the
 * LLM registry and the credential service.
 * @module @deepseek-ai/dsh-llm-free-mode/config
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { FreeRouteKey } from './types.ts'

/** Provider route whose free models carry a documented marker. */
const OPENROUTER_PROVIDER = 'openrouter'
const OPENROUTER_FREE_ROUTER = 'openrouter/free'
const OPENROUTER_FREE_SUFFIX = ':free'

/** One ordered entry of the free route list. */
export interface FreeRoute extends FreeRouteKey {
  /** Required outside OpenRouter: the user states that this account does not bill the route. */
  freeTierConfirmed?: boolean
}

/** Live free-mode settings read from the plugin's volatile Config fields. */
export interface FreeModeSettings {
  /** `false` keeps `routes` and removes every guard and the failover. */
  enabled: boolean
  /** Routes in priority order. */
  routes: readonly FreeRoute[]
  /** Wait before leaving a route after a rate limit, in milliseconds. */
  rateLimitDelayMs: number
  /** Longest duration of one failover chain, in milliseconds. */
  maxFailoverMs: number
  /** Largest accepted provider `streamIdleTimeoutMs`, in milliseconds. */
  maxRouteIdleMs: number
  /** Limit of each quota or catalog read, in milliseconds. */
  networkTimeoutMs: number
}

/** Compare two routes by provider and model. */
export function sameRoute(left: FreeRouteKey, right: FreeRouteKey): boolean {
  return left.provider === right.provider && left.model === right.model
}

function routeLabel(route: FreeRouteKey): string {
  return `${route.provider}/${route.model}`
}

function isOpenRouterFree(model: string): boolean {
  return model === OPENROUTER_FREE_ROUTER || model.endsWith(OPENROUTER_FREE_SUFFIX)
}

/**
 * Validate the checks that need no other service. Disabled settings are not
 * checked for list contents, so leaving free mode never loses or rejects them.
 * @param settings - schema-valid settings read from the plugin Config.
 * @throws LlmError naming the route and the expected action.
 */
export function validateFreeModeSettings(settings: FreeModeSettings): void {
  if (!settings.enabled) return
  if (settings.routes.length === 0) {
    throw new LlmError('llm-free-mode: add at least one route to `routes`, or set `enabled: false`', 'FREE_MODE_EMPTY_LIST')
  }
  const seen = new Set<string>()
  for (const route of settings.routes) {
    const label = routeLabel(route)
    if (seen.has(label)) {
      throw new LlmError(`llm-free-mode: remove the duplicate route "${label}"`, 'FREE_MODE_DUPLICATE_ROUTE')
    }
    seen.add(label)
    if (route.provider === OPENROUTER_PROVIDER) {
      if (!isOpenRouterFree(route.model)) {
        throw new LlmError(`llm-free-mode: route "${label}" is not a free OpenRouter model; use a ":free" model`, 'FREE_MODE_PAID_ROUTE')
      }
    } else if (route.freeTierConfirmed !== true) {
      throw new LlmError(`llm-free-mode: route "${label}" needs \`freeTierConfirmed: true\` once its account is confirmed free`, 'FREE_MODE_UNCONFIRMED_ROUTE')
    }
  }
}

/** Why a listed route cannot serve requests. */
export type RouteProblem =
  | 'provider-unknown'
  | 'model-not-configured'
  | 'credential-missing'
  | 'unbounded-retry'
  | 'timeout-too-long'

/** One route check failure with its stable configuration code. */
export interface RouteIssue {
  readonly route: FreeRouteKey
  readonly problem: RouteProblem
  readonly code: string
  readonly message: string
}

function issue(route: FreeRouteKey, problem: RouteProblem, code: string, action: string): RouteIssue {
  return { route, problem, code, message: `llm-free-mode: route "${routeLabel(route)}" ${action}` }
}

/**
 * Check one route against the live registry without sending a model request.
 * @param route - listed route.
 * @param maxRouteIdleMs - largest accepted provider idle timeout.
 * @param llm - registry that owns the route.
 * @param credentials - credential service, when mounted.
 * @returns the first issue, or `undefined` for a usable route.
 */
export async function checkRoute(
  route: FreeRouteKey,
  maxRouteIdleMs: number,
  llm: LlmRuntime,
  credentials: CredentialProvider | undefined,
): Promise<RouteIssue | undefined> {
  try {
    await llm.resolveCallConfig({ provider: route.provider, model: route.model })
  } catch (error: unknown) {
    if (!(error instanceof LlmError)) throw error
    if (error.code === 'NO_ADAPTER') {
      return issue(route, 'provider-unknown', 'FREE_MODE_ROUTE_UNUSABLE', 'names an unknown provider; configure it under `llm-pi-ai`')
    }
    return issue(route, 'model-not-configured', 'FREE_MODE_ROUTE_UNUSABLE', error.code === 'UNKNOWN_MODEL'
      ? 'is not configured; add the model to its provider under `llm-pi-ai`'
      : `cannot be resolved: ${error.message}`)
  }
  if (llm.providerRetryPolicy(route.provider).mode === 'always') {
    return issue(route, 'unbounded-retry', 'FREE_MODE_UNBOUNDED_RETRY', 'uses `retryPolicy.mode: always`; use `normal` so failover can start')
  }
  const access = llm.providerAccess(route.provider)
  if (access?.streamIdleTimeoutMs !== undefined && access.streamIdleTimeoutMs > maxRouteIdleMs) {
    return issue(route, 'timeout-too-long', 'FREE_MODE_TIMEOUT_TOO_LONG', `waits ${access.streamIdleTimeoutMs} ms on an idle stream; set \`streamIdleTimeoutMs\` to at most ${maxRouteIdleMs}`)
  }
  if (access?.credentialRef !== undefined && credentials !== undefined) {
    const resolved = await credentials.resolve(credentialRef(access.credentialRef))
    if (resolved === undefined || resolved.value.length === 0) {
      return issue(route, 'credential-missing', 'FREE_MODE_ROUTE_UNUSABLE', `has no credential; set ${access.credentialRef}`)
    }
  }
  return undefined
}
