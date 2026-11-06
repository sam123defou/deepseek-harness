/**
 * Failover decisions and the durable per-step state they read.
 * @module @deepseek-ai/dsh-llm-free-mode/failover
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { sameRoute } from './config.ts'
import type { FreeRoute } from './config.ts'
import type { FailureCause, FreeRouteKey, LlmFailoverEventData } from './types.ts'

/** Code a route guard raises; it ends the request and never reaches another route. */
export const ROUTE_REFUSED_CODE = 'FREE_MODE_ROUTE_REFUSED'

/** Failover facts of the current step. */
export interface FailoverState {
  /** Routes left in this step. */
  tried: FreeRouteKey[]
  /** Time of the first failover of this step, in epoch milliseconds. */
  startedAt?: number
  /** Providers abandoned in this step for quota or credential reasons. */
  excludedProviders: string[]
  /** The single route change allowed for an invalid request has happened. */
  invalidRequestSwitched: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Failover state of the current step. */
    llmFailover: FailoverState
  }
}

/** Runtime schema of the {@link FailoverState} projection. */
export const failoverStateSchema: z.ZodType<FailoverState> = z.object({
  tried: z.array(z.object({ provider: z.string(), model: z.string() })),
  startedAt: z.number().optional(),
  excludedProviders: z.array(z.string()),
  invalidRequestSwitched: z.boolean(),
}) as z.ZodType<FailoverState>

/** @returns a state without any failover in the current step. */
export function initialFailoverState(): FailoverState {
  return { tried: [], excludedProviders: [], invalidRequestSwitched: false }
}

/**
 * Map a stable failure code to its cause. Codes form an open vocabulary, so
 * an unrecognized code falls through to `unknown`.
 * @param code - stable code of the failed request.
 * @returns the cause used for routing and display.
 */
export function failureCause(code: string): FailureCause {
  switch (code) {
    case 'SERVER':
    case 'TIMEOUT':
    case 'TRANSPORT':
    case 'EMPTY_RESPONSE':
      return 'saturated'
    case 'RATE_LIMIT':
      return 'rate-limited'
    case 'PI_AI_ERROR':
      return 'unavailable'
    case 'INVALID_REQUEST':
      return 'invalid-request'
    case 'QUOTA':
      return 'quota-exhausted'
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
      return 'credential-missing'
    case 'AUTH':
      return 'auth-refused'
    case 'CONTEXT_WINDOW_EXCEEDED':
      return 'context-exceeded'
    default:
      return 'unknown'
  }
}

/**
 * Tell whether a cause invalidates every route of the failed provider.
 * @param cause - cause of the failure.
 * @returns true for quota and credential causes.
 */
export function abandonsProvider(cause: FailureCause): boolean {
  switch (cause) {
    case 'quota-exhausted':
    case 'credential-missing':
    case 'auth-refused':
      return true
    case 'saturated':
    case 'rate-limited':
    case 'unavailable':
    case 'invalid-request':
    case 'context-exceeded':
    case 'unknown':
      return false
    default:
      return assertNever(cause)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled failure cause: ${String(value)}`)
}

/**
 * Advance the failover state by one Session event.
 * @param state - state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced state.
 */
export function applyFailoverEvent(state: FailoverState, event: SessionEvent): FailoverState {
  if (event.type === 'step/start' || event.type === 'turn/end') return initialFailoverState()
  if (event.type !== 'llm/failover') return state
  const data: LlmFailoverEventData = event.data
  return {
    tried: [...state.tried, data.from],
    startedAt: state.startedAt ?? event.time,
    excludedProviders: abandonsProvider(data.cause) && !state.excludedProviders.includes(data.from.provider)
      ? [...state.excludedProviders, data.from.provider]
      : state.excludedProviders,
    invalidRequestSwitched: state.invalidRequestSwitched || data.cause === 'invalid-request',
  }
}

/**
 * Tell whether the failover must stop before looking at routes.
 * @param cause - cause of the failure.
 * @param state - failover state of the step.
 * @param now - current time in epoch milliseconds.
 * @param maxFailoverMs - longest failover duration.
 * @returns true when no further route may be tried.
 */
export function failoverExhausted(
  cause: FailureCause,
  state: FailoverState,
  now: number,
  maxFailoverMs: number,
): boolean {
  if (cause === 'invalid-request' && state.invalidRequestSwitched) return true
  return state.startedAt !== undefined && now - state.startedAt >= maxFailoverMs
}

/**
 * List the routes still allowed after one failure, in priority order.
 * @param routes - configured list.
 * @param failed - route of the failed request.
 * @param cause - cause of the failure.
 * @param state - failover state of the step.
 * @returns the candidates.
 */
export function failoverCandidates(
  routes: readonly FreeRoute[],
  failed: FreeRouteKey,
  cause: FailureCause,
  state: FailoverState,
): FreeRoute[] {
  const excluded = abandonsProvider(cause)
    ? [...state.excludedProviders, failed.provider]
    : state.excludedProviders
  return routes.filter(route => !sameRoute(route, failed)
    && !state.tried.some(tried => sameRoute(tried, route))
    && !excluded.includes(route.provider))
}

const CAUSE_MESSAGES: Readonly<Record<FailureCause, string>> = Object.freeze({
  'saturated': 'free models are saturated; retry in a few minutes',
  'rate-limited': 'the per-minute request limit is reached; retry in one minute',
  'unavailable': 'no listed free model is available; run `dsh --profile free-check`',
  'invalid-request': 'the request was rejected by the free models; shorten or simplify it',
  'quota-exhausted': 'the daily free quota is exhausted; retry after the provider reset',
  'credential-missing': 'a credential is missing; run `dsh --profile free-check`',
  'auth-refused': 'the provider refused the credential or the request; run `dsh --profile free-check`',
  'context-exceeded': 'the conversation exceeds the capacity of every remaining free model; start a new session',
  'unknown': 'the free models failed; run `dsh --profile free-check`',
})

/**
 * Describe one failover record for a text surface.
 * @param data - durable failover record.
 * @returns the route change with its cause, or the stop message with its action.
 */
export function describeFailover(data: LlmFailoverEventData): string {
  const from = `${data.from.provider}/${data.from.model}`
  return data.to === undefined
    ? `${failoverStopMessage(data.cause)} (last route ${from})`
    : `free mode left ${from} for ${data.to.provider}/${data.to.model} (${data.cause})`
}

/**
 * Describe the end of a failover with the action the user can take.
 * @param cause - cause of the last failure.
 * @returns one line of English diagnostic text.
 */
export function failoverStopMessage(cause: FailureCause): string {
  return `free mode stopped: ${CAUSE_MESSAGES[cause]}`
}
