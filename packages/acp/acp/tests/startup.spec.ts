import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AcpSession } from '../src/session.ts'
import type { CreateAcpSessionOptions, ResumeAcpSessionOptions } from '../src/session.ts'

const stopped = new Error('stop after the Agent call')

function fixture() {
  let settle = (): void => undefined
  const settled = new Promise<void>((resolve) => { settle = resolve })
  const create = vi.fn(() => Promise.reject(stopped))
  const resume = vi.fn(() => Promise.reject(stopped))
  const ctx = {
    get: (name: string) => name === 'loader' ? { await: () => settled } : undefined,
    llm: {},
    agents: { create, resume },
  } as unknown as Context
  return { ctx, settle, create, resume }
}

describe('AcpSession startup', () => {
  it('creates no Agent before the Loader has settled', async () => {
    const { ctx, settle, create } = fixture()
    const pending = AcpSession.create(ctx, { mcpServers: [] } as unknown as CreateAcpSessionOptions)
    await new Promise(resolve => setImmediate(resolve))
    expect(create).not.toHaveBeenCalled()

    settle()
    await expect(pending).rejects.toBe(stopped)
    expect(create).toHaveBeenCalledOnce()
  })

  it('resumes no Agent before the Loader has settled', async () => {
    const { ctx, settle, resume } = fixture()
    const pending = AcpSession.resume(ctx, { mcpServers: [] } as unknown as ResumeAcpSessionOptions)
    await new Promise(resolve => setImmediate(resolve))
    expect(resume).not.toHaveBeenCalled()

    settle()
    await expect(pending).rejects.toBe(stopped)
    expect(resume).toHaveBeenCalledOnce()
  })
})
