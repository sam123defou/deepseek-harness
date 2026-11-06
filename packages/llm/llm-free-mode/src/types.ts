/**
 * Browser-safe types of the free-mode policy and its durable failover record.
 * @module @deepseek-ai/dsh-llm-free-mode/types
 */

/** One provider and model pair admitted by free mode. */
export interface FreeRouteKey {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Why a model request left a route or ended the failover. */
export type FailureCause =
  | 'saturated'
  | 'rate-limited'
  | 'unavailable'
  | 'invalid-request'
  | 'quota-exhausted'
  | 'credential-missing'
  | 'auth-refused'
  | 'context-exceeded'
  | 'unknown'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of one route change, or of the end of the failover when `to` is absent. */
    'llm/failover': LlmFailoverEventData
  }
}

/** Durable payload recorded before the failed step is replayed on another route. */
export interface LlmFailoverEventData {
  turn: number
  step: number
  /** Route of the failed request. */
  from: FreeRouteKey
  /** Selected route; absent when no route remains. */
  to?: FreeRouteKey
  cause: FailureCause
  /** Stable code of the failed request, without request content or credentials. */
  failureCode: string
  /** Wait applied before the replay, in milliseconds. */
  delayMs: number
}
