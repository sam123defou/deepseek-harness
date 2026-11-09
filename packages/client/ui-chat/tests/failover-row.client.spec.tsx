// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { FailureCause } from '@deepseek-ai/dsh-llm-free-mode/types'
import { FailoverNodeView } from '../src/client/chat/MessageItem.tsx'
import type { FailoverChatData } from '../src/client/contract/chat-nodes.ts'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { en } from '../src/client/locale.ts'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(en, commonEn)
const from = { provider: 'openrouter', model: 'first:free' }

function row(cause: FailureCause, to?: { provider: string; model: string }): string | null {
  const data: FailoverChatData = { seq: 1, time: 1, turn: 1, step: 1, from, cause, failureCode: 'CODE', delayMs: 0, ...(to === undefined ? {} : { to }) }
  const props = { node: { data }, t } as ChatNodeViewProps<'model-failover'>
  const view = render(<FailoverNodeView {...props} />)
  const text = view.getByRole('status').textContent
  view.unmount()
  return text
}

describe('FailoverNodeView', () => {
  it('names both routes and the cause of a route change', () => {
    expect(row('saturated', { provider: 'groq', model: 'next' }))
      .toBe('Free mode switched from openrouter/first:free to groq/next: model saturated')
  })

  it('tells quota, saturation, and a missing credential apart with the action to take', () => {
    expect(row('quota-exhausted')).toBe(
      'Free mode stopped after openrouter/first:free: the daily free quota is exhausted; retry after the provider reset',
    )
    expect(row('saturated')).toBe(
      'Free mode stopped after openrouter/first:free: free models are saturated; retry in a few minutes',
    )
    expect(row('credential-missing')).toBe(
      'Free mode stopped after openrouter/first:free: a credential is missing; run dsh --profile free-check',
    )
  })
})
