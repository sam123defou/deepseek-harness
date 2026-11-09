import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  abandonsProvider,
  applyFailoverEvent,
  describeFailover,
  failoverCandidates,
  failoverExhausted,
  failoverStopMessage,
  failureCause,
  initialFailoverState,
} from '../src/failover.ts'
import type { FailureCause, LlmFailoverEventData } from '../src/types.ts'

const A = { provider: 'openrouter', model: 'a:free' }
const B = { provider: 'openrouter', model: 'b:free' }
const G = { provider: 'groq', model: 'g', freeTierConfirmed: true }
const ROUTES = [A, B, G]

function failover(cause: FailureCause, time = 100): SessionEvent {
  const data: LlmFailoverEventData = { turn: 1, step: 1, from: A, to: B, cause, failureCode: 'X', delayMs: 0 }
  return { type: 'llm/failover', seq: 1, time, data } as unknown as SessionEvent
}

describe('failureCause()', () => {
  it.each([
    ['SERVER', 'saturated'],
    ['TIMEOUT', 'saturated'],
    ['TRANSPORT', 'saturated'],
    ['EMPTY_RESPONSE', 'saturated'],
    ['RATE_LIMIT', 'rate-limited'],
    ['PI_AI_ERROR', 'unavailable'],
    ['INVALID_REQUEST', 'invalid-request'],
    ['QUOTA', 'quota-exhausted'],
    ['MISSING_CREDENTIAL', 'credential-missing'],
    ['INVALID_CREDENTIAL', 'credential-missing'],
    ['AUTH', 'auth-refused'],
    ['CONTEXT_WINDOW_EXCEEDED', 'context-exceeded'],
    ['SOMETHING_NEW', 'unknown'],
  ])('maps %s to %s', (code, cause) => {
    expect(failureCause(code)).toBe(cause)
  })
})

describe('abandonsProvider()', () => {
  it('leaves the provider only for quota and credential causes', () => {
    const causes: FailureCause[] = [
      'saturated', 'rate-limited', 'unavailable', 'invalid-request', 'quota-exhausted',
      'credential-missing', 'auth-refused', 'context-exceeded', 'unknown',
    ]
    expect(causes.filter(abandonsProvider)).toEqual(['quota-exhausted', 'credential-missing', 'auth-refused'])
  })

  it('rejects a cause outside the closed union', () => {
    expect(() => abandonsProvider('new' as FailureCause)).toThrow('unhandled failure cause')
  })
})

describe('applyFailoverEvent()', () => {
  it('records the route, the first time, and abandoned providers', () => {
    const first = applyFailoverEvent(initialFailoverState(), failover('quota-exhausted', 100))
    const second = applyFailoverEvent(first, failover('quota-exhausted', 200))
    expect(second).toEqual({
      tried: [A, A],
      startedAt: 100,
      excludedProviders: ['openrouter'],
      invalidRequestSwitched: false,
    })
  })

  it('records the single invalid-request change', () => {
    expect(applyFailoverEvent(initialFailoverState(), failover('invalid-request')).invalidRequestSwitched).toBe(true)
  })

  it('resets at an assistant reply and turn end, and keeps the chain across steps', () => {
    const state = applyFailoverEvent(initialFailoverState(), failover('saturated'))
    expect(applyFailoverEvent(state, { type: 'request/header' } as SessionEvent)).toBe(state)
    expect(applyFailoverEvent(state, { type: 'step/start' } as SessionEvent)).toBe(state)
    expect(applyFailoverEvent(state, { type: 'assistant/message' } as SessionEvent)).toEqual(initialFailoverState())
    expect(applyFailoverEvent(state, { type: 'turn/end' } as SessionEvent)).toEqual(initialFailoverState())
  })
})

describe('failoverExhausted()', () => {
  it('allows one route change for an invalid request', () => {
    const state = initialFailoverState()
    expect(failoverExhausted('invalid-request', state, 0, 1000)).toBe(false)
    expect(failoverExhausted('invalid-request', { ...state, invalidRequestSwitched: true }, 0, 1000)).toBe(true)
  })

  it('stops once the time limit is reached', () => {
    const state = { ...initialFailoverState(), startedAt: 1000 }
    expect(failoverExhausted('saturated', state, 1999, 1000)).toBe(false)
    expect(failoverExhausted('saturated', state, 2000, 1000)).toBe(true)
  })
})

describe('failoverCandidates()', () => {
  it('keeps list order without the failed and tried routes', () => {
    const state = { ...initialFailoverState(), tried: [B] }
    expect(failoverCandidates(ROUTES, A, 'saturated', state)).toEqual([G])
    expect(failoverCandidates(ROUTES, A, 'saturated', initialFailoverState())).toEqual([B, G])
  })

  it('leaves the whole provider for a provider-wide cause', () => {
    expect(failoverCandidates(ROUTES, A, 'quota-exhausted', initialFailoverState())).toEqual([G])
    const excluded = { ...initialFailoverState(), excludedProviders: ['groq'] }
    expect(failoverCandidates(ROUTES, A, 'saturated', excluded)).toEqual([B])
  })
})

describe('describeFailover()', () => {
  it('names the routes and the cause, or the stop action', () => {
    const data: LlmFailoverEventData = { turn: 1, step: 1, from: A, to: B, cause: 'saturated', failureCode: 'SERVER', delayMs: 0 }
    expect(describeFailover(data)).toBe('free mode left openrouter/a:free for openrouter/b:free (saturated)')
    const { to: _to, ...stopped } = data
    expect(describeFailover({ ...stopped, cause: 'quota-exhausted' })).toBe(
      'free mode stopped: the daily free quota is exhausted; retry after the provider reset (last route openrouter/a:free)',
    )
  })
})

describe('failoverStopMessage()', () => {
  it('separates quota, saturation, and missing credentials', () => {
    const messages = (['quota-exhausted', 'saturated', 'credential-missing'] as const).map(failoverStopMessage)
    expect(messages).toEqual([
      'free mode stopped: the daily free quota is exhausted; retry after the provider reset',
      'free mode stopped: free models are saturated; retry in a few minutes',
      'free mode stopped: a credential is missing; run `dsh --profile free-check`',
    ])
  })
})
