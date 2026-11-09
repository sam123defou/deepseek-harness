import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmProviderAccess,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import LlmFreeMode from '../src/index.ts'
import type { FreeModeSettings } from '../src/index.ts'

const SECTION: Partial<FreeModeSettings> = {
  enabled: true,
  rateLimitDelayMs: 1,
  routes: [
    { provider: 'openrouter', model: 'first:free' },
    { provider: 'openrouter', model: 'second:free' },
    { provider: 'openrouter', model: 'third:free' },
    { provider: 'groq', model: 'fallback', freeTierConfirmed: true },
  ],
}

let section: Partial<FreeModeSettings> = SECTION

type Outcome = 'ok' | Error

/** Scripted provider: each model answers from its own list, then repeats the last outcome. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: string[] = []
  access: LlmProviderAccess = { streamIdleTimeoutMs: 20_000 }
  windows: Readonly<Record<string, number>> = {}
  private readonly policy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  }, 'test')

  constructor(private readonly script: Record<string, Outcome[]>) {
    super()
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  override providerAccess(): LlmProviderAccess {
    return this.access
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const contextWindow = this.windows[model]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(`${options.provider}/${options.model}`)
    const outcomes = this.script[options.model] ?? ['ok']
    const outcome = outcomes.length > 1 ? outcomes.shift() : outcomes[0]
    if (outcome instanceof Error) throw outcome
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: options.model }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: options.model } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  section = SECTION
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const ROWS = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-tool-executor-native',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-agent-loop',
]
const RETRY = '@deepseek-ai/dsh-llm-retry'
const FREE = '@deepseek-ai/dsh-llm-free-mode'

async function load(order: readonly string[] = [RETRY, FREE]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-free-mode-'))
  const configPath = join(root, 'cordis.yml')
  const row = (name: string) => name === FREE ? `- name: '${name}'\n  config: ${JSON.stringify(section)}` : `- name: '${name}'`
  await writeFile(configPath, [...ROWS, ...order].map(row).join('\n') + '\n')
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-web', WebRuntime],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    [RETRY, retry],
    [FREE, LlmFreeMode],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

async function run(
  loaded: Context,
  first = { provider: 'openrouter', model: 'first:free' },
): Promise<Agent> {
  const { agent } = await loaded.agents.create({
    sessionId: SessionId(`free-mode-${randomUUID()}`),
    meta: {},
    agentOptions: first,
  })
  await agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle().catch(() => undefined)
  return agent
}

function failovers(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'llm/failover' ? [event.data] : [])
}

function lastText(agent: Agent): unknown {
  return agent.session.deriveMessages().at(-1)?.content
}

const serverDown = () => new LlmError('503 overloaded', 'SERVER')

describe('real Loader composition', () => {
  it.each([
    ['retry listed first', [RETRY, FREE]],
    ['free mode listed first', [FREE, RETRY]],
  ])('exhausts retries, then finishes on the next route (%s)', { timeout: 60_000 }, async (_name, order) => {
    const loaded = await load(order)
    const adapter = new ScriptedAdapter({ 'first:free': [serverDown()] })
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    const agent = await run(loaded)

    expect(adapter.requests).toEqual([
      'openrouter/first:free',
      'openrouter/first:free',
      'openrouter/second:free',
    ])
    expect(failovers(agent)).toEqual([{
      turn: 1,
      step: 1,
      from: { provider: 'openrouter', model: 'first:free' },
      to: { provider: 'openrouter', model: 'second:free' },
      cause: 'saturated',
      failureCode: 'SERVER',
      delayMs: 0,
    }])
    expect(lastText(agent)).toEqual([{ type: 'text', text: 'second:free' }])
    expect(agent.session.requestHeader()?.config).toMatchObject({ model: 'second:free' })
  })

  it('stops after the last route, records the end, and calls nothing else', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const down = [serverDown()]
    const adapter = new ScriptedAdapter({
      'first:free': down, 'second:free': down, 'third:free': down, 'fallback': down, 'paid': ['ok'],
    })
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    const agent = await run(loaded)

    expect(new Set(adapter.requests)).toEqual(new Set([
      'openrouter/first:free', 'openrouter/second:free', 'openrouter/third:free', 'groq/fallback',
    ]))
    const events = failovers(agent)
    expect(events.at(-1)).toMatchObject({ from: { model: 'fallback' }, cause: 'saturated' })
    expect(events.at(-1)?.to).toBeUndefined()
  })

  it('leaves a provider whose daily quota is exhausted and continues elsewhere', { timeout: 60_000 }, async () => {
    const loaded = await load()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      data: { free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } },
    })))))
    const adapter = new ScriptedAdapter({ 'first:free': [new LlmError('429 Rate limit exceeded', 'RATE_LIMIT')] })
    adapter.access = { streamIdleTimeoutMs: 20_000, baseURL: 'https://openrouter.ai/api/v1', credentialRef: 'OPENROUTER_API_KEY' }
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    const credentials = { resolve: () => Promise.resolve({ value: 'secret' }) }
    vi.spyOn(loaded, 'get').mockImplementation(((name: string) => name === 'credentials' ? credentials : undefined) as never)
    const agent = await run(loaded)

    expect(failovers(agent)).toMatchObject([{
      from: { model: 'first:free' },
      to: { provider: 'groq', model: 'fallback' },
      cause: 'quota-exhausted',
    }])
  })

  it('waits after a rate limit when quota remains or is unknown', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const adapter = new ScriptedAdapter({ 'first:free': [new LlmError('429', 'RATE_LIMIT')] })
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    const agent = await run(loaded)
    expect(failovers(agent)).toMatchObject([{ cause: 'rate-limited', delayMs: 1, to: { model: 'second:free' } }])
  })

  it('requires a larger capacity after a context overflow', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const adapter = new ScriptedAdapter({
      'first:free': [new LlmError('too long', 'CONTEXT_WINDOW_EXCEEDED')],
    })
    adapter.windows = { 'first:free': 1000, 'second:free': 500, 'third:free': 2000 }
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    const agent = await run(loaded)
    expect(failovers(agent)).toMatchObject([{ cause: 'context-exceeded', to: { model: 'third:free' } }])
  })

  it('skips a candidate that cannot resolve instead of ending the turn', { timeout: 60_000 }, async () => {
    const loaded = await load()
    class PartialAdapter extends ScriptedAdapter {
      missing = false
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        if (this.missing && model === 'second:free') throw new LlmError('gone', 'UNKNOWN_MODEL')
        return super.resolveModel(provider, model)
      }
    }
    const adapter = new PartialAdapter({ 'first:free': [serverDown()] })
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    await loaded.freeMode.checkRoutes()
    await loaded.llm.prepareCall({ provider: 'openrouter', model: 'first:free' })
    adapter.missing = true
    await expect(loaded.freeMode.checkRoutes()).resolves.toMatchObject([{ problem: 'model-not-configured' }])
    const agent = await run(loaded)
    expect(failovers(agent)).toMatchObject([{ to: { model: 'third:free' } }])
  })

  it('refuses an unlisted route without contacting the provider', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const adapter = new ScriptedAdapter({})
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    await expect(loaded.llm.prepareCall({ provider: 'openrouter', model: 'paid' }))
      .rejects.toMatchObject({ code: 'FREE_MODE_ROUTE_REFUSED' })
    await run(loaded, { provider: 'openrouter', model: 'paid' })
    expect(adapter.requests).toEqual([])
  })

  it.each([
    ['an unknown provider', 'FREE_MODE_ROUTE_UNUSABLE', (loaded: Context) => {
      loaded.llm.registerAdapter(['openrouter'], new ScriptedAdapter({}))
    }],
    ['a stream timeout above the limit', 'FREE_MODE_TIMEOUT_TOO_LONG', (loaded: Context) => {
      const adapter = new ScriptedAdapter({})
      adapter.access = { streamIdleTimeoutMs: 300_000 }
      loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    }],
  ])('refuses requests while the list has %s', { timeout: 60_000 }, async (_name, code, arrange) => {
    const loaded = await load()
    arrange(loaded)
    await expect(loaded.llm.prepareCall({ provider: 'openrouter', model: 'first:free' }))
      .rejects.toMatchObject({ code })
  })

  it('refuses unbounded retries on a listed provider', { timeout: 60_000 }, async () => {
    const loaded = await load()
    class Always extends ScriptedAdapter {
      override providerRetryPolicy(): ResolvedRetryPolicy {
        return resolveRetryPolicy({ mode: 'always' }, 'test')
      }
    }
    loaded.llm.registerAdapter(['openrouter', 'groq'], new Always({}))
    await expect(loaded.freeMode.checkRoutes()).resolves.toMatchObject([
      { problem: 'unbounded-retry' }, { problem: 'unbounded-retry' }, { problem: 'unbounded-retry' }, { problem: 'unbounded-retry' },
    ])
  })

  it('refuses billed web search and allows a free provider', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const search = vi.fn(() => Promise.resolve({ sources: [], truncated: false }))
    const dispose = loaded.web.registerSearchProvider({ id: 'paid', billing: 'billed', available: () => true, search })
    await expect(loaded.web.search({ query: 'x' })).rejects.toThrow(WebError)
    await expect(loaded.web.search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_REFUSED_FREE_MODE' })
    expect(search).not.toHaveBeenCalled()
    dispose()
    loaded.web.registerSearchProvider({ id: 'free', billing: 'free', available: () => true, search })
    await loaded.web.search({ query: 'x' })
    expect(search).toHaveBeenCalledOnce()
  })

  it('keeps the list and applies nothing while disabled', { timeout: 60_000 }, async () => {
    section = { ...SECTION, enabled: false }
    const loaded = await load()
    const adapter = new ScriptedAdapter({ paid: [serverDown()] })
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    const agent = await run(loaded, { provider: 'openrouter', model: 'paid' })
    expect(adapter.requests[0]).toBe('openrouter/paid')
    expect(failovers(agent)).toEqual([])
    expect(loaded.freeMode.currentSettings().routes).toHaveLength(4)
    const search = vi.fn(() => Promise.resolve({ sources: [], truncated: false }))
    loaded.web.registerSearchProvider({ id: 'paid', billing: 'billed', available: () => true, search })
    await loaded.web.search({ query: 'x' })
    expect(search).toHaveBeenCalledOnce()
  })

  it('stops at the failover time limit even when routes remain', { timeout: 60_000 }, async () => {
    section = { ...SECTION, maxFailoverMs: 0 }
    const loaded = await load()
    const down = [serverDown()]
    const adapter = new ScriptedAdapter({ 'first:free': down, 'second:free': down })
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    const agent = await run(loaded)
    expect(failovers(agent)).toMatchObject([{ to: { model: 'second:free' } }, { from: { model: 'second:free' } }])
    expect(failovers(agent)[1]?.to).toBeUndefined()
  })

  it('never turns a guard refusal into a route change', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const adapter = new ScriptedAdapter({ 'first:free': [new LlmError('refused', 'FREE_MODE_ROUTE_REFUSED')] })
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    const agent = await run(loaded)
    expect(failovers(agent)).toEqual([])
    expect(new Set(adapter.requests)).toEqual(new Set(['openrouter/first:free']))
  })

  it('reports a missing credential and reads no quota without one', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const adapter = new ScriptedAdapter({})
    adapter.access = { streamIdleTimeoutMs: 1, baseURL: 'https://openrouter.ai/api/v1', credentialRef: 'OPENROUTER_API_KEY' }
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    await expect(loaded.freeMode.readQuota('openrouter')).resolves.toEqual({ provider: 'openrouter', state: 'unknown' })
    expect(loaded.freeMode.hasCatalog('openrouter')).toBe(true)
    const credentials = { resolve: vi.fn(() => Promise.resolve(undefined)) }
    vi.spyOn(loaded, 'get').mockImplementation(((name: string) => name === 'credentials' ? credentials : undefined) as never)
    await expect(loaded.freeMode.checkRoutes()).resolves.toMatchObject([
      { problem: 'credential-missing' }, { problem: 'credential-missing' }, { problem: 'credential-missing' }, { problem: 'credential-missing' },
    ])
    await expect(loaded.freeMode.readQuota('openrouter')).resolves.toEqual({ provider: 'openrouter', state: 'unknown' })
    credentials.resolve.mockResolvedValue({ value: '' } as never)
    await expect(loaded.freeMode.checkRoutes()).resolves.toHaveLength(4)
  })

  it('names the provider configuration error of a listed model', { timeout: 60_000 }, async () => {
    const loaded = await load()
    class MisconfiguredAdapter extends ScriptedAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        if (model === 'second:free') throw new LlmError('model "second:free" needs an api', 'INVALID_CONFIG')
        return super.resolveModel(provider, model)
      }
    }
    loaded.llm.registerAdapter(['openrouter', 'groq'], new MisconfiguredAdapter({}))
    const [found] = await loaded.freeMode.checkRoutes()
    expect(found?.problem).toBe('model-not-configured')
    expect(found?.message).toContain('cannot be resolved: model "second:free" needs an api')
  })

  it('does not hide an unexpected adapter error', { timeout: 60_000 }, async () => {
    const loaded = await load()
    class Broken extends ScriptedAdapter {
      broken = false
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        if (this.broken && model !== 'first:free') throw new TypeError('adapter bug')
        return super.resolveModel(provider, model)
      }
    }
    const adapter = new Broken({ 'first:free': [serverDown()] })
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    await loaded.llm.prepareCall({ provider: 'openrouter', model: 'first:free' })
    adapter.broken = true
    await expect(loaded.freeMode.checkRoutes()).rejects.toThrow('adapter bug')
    const agent = await run(loaded)
    expect(failovers(agent)).toEqual([])
  })

  it('cancels a pending wait when the plugin is disposed', { timeout: 60_000 }, async () => {
    section = { ...SECTION, rateLimitDelayMs: 60_000 }
    const loaded = await load()
    const adapter = new ScriptedAdapter({ 'first:free': [new LlmError('429', 'RATE_LIMIT')] })
    loaded.llm.registerAdapter(['openrouter', 'groq'], adapter)
    const first = { provider: 'openrouter', model: 'first:free' }
    const { agent } = await loaded.agents.create({
      sessionId: SessionId('free-mode-cancel'),
      meta: {},
      agentOptions: first,
    })
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(failovers(agent)).toHaveLength(1) }, { timeout: 5_000 })
    await [...loaded.loader.entries()].find(row => row.options.name === FREE)?.fiber?.dispose()
    await agent.whenIdle().catch(() => undefined)
    expect(adapter.requests.filter(request => request.endsWith('second:free'))).toEqual([])
  })

  it('removes its guards with the plugin', { timeout: 60_000 }, async () => {
    const loaded = await load()
    loaded.llm.registerAdapter(['openrouter', 'groq'], new ScriptedAdapter({}))
    await expect(loaded.llm.checkRoute({ provider: 'openrouter', model: 'paid' })).rejects.toBeDefined()
    const entry = [...loaded.loader.entries()].find(row => row.options.name === FREE)
    await entry?.fiber?.dispose()
    await expect(loaded.llm.checkRoute({ provider: 'openrouter', model: 'paid' })).resolves.toBeUndefined()
  })
})
