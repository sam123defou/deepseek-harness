import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AcpSession } from '../src/session.ts'
import type { CreateAcpSessionOptions, ResumeAcpSessionOptions } from '../src/session.ts'

const stopped = new Error('stop after the Agent call')

function fixture() {
  let settle = (): void => undefined
  const settled = new Promise<void>((resolve) => { settle = resolve })
  const create = vi.fn(() => Promise.reject(stopped))
  const resume = vi.fn(() => Promise.reject(stopped))
  const ctx = new Context()
  ctx.provide('loader')
  ctx.provide('agents')
  ctx.set('loader', { await: () => settled })
  ctx.set('agents', { create, resume })
  return { ctx, settle, create, resume }
}

function options(): CreateAcpSessionOptions & ResumeAcpSessionOptions {
  return {
    sessionId: SessionId('acp-startup'),
    cwd: '/',
    mcpServers: [],
    agentOptions: {},
    signal: new AbortController().signal,
    notify: () => Promise.resolve(),
  }
}

describe('AcpSession startup', () => {
  it('creates no Agent before the Loader has settled', async () => {
    const { ctx, settle, create } = fixture()
    const pending = AcpSession.create(ctx, options())
    await new Promise(resolve => setImmediate(resolve))
    expect(create).not.toHaveBeenCalled()

    settle()
    await expect(pending).rejects.toBe(stopped)
    expect(create).toHaveBeenCalledOnce()
  })

  it('resumes no Agent before the Loader has settled', async () => {
    const { ctx, settle, resume } = fixture()
    const pending = AcpSession.resume(ctx, options())
    await new Promise(resolve => setImmediate(resolve))
    expect(resume).not.toHaveBeenCalled()

    settle()
    await expect(pending).rejects.toBe(stopped)
    expect(resume).toHaveBeenCalledOnce()
  })
})
