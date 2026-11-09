import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { executeSessionTitleLlm, resolveSessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import WebRuntime from '@deepseek-ai/dsh-web'
import LlmFreeMode from '../src/index.ts'
import type { FreeModeSettings } from '../src/index.ts'
import { fixtureModuleLoader } from './module-loader.ts'

const FIRST = { provider: 'openrouter', model: 'first:free' }
const LISTED = [
  FIRST,
  { provider: 'openrouter', model: 'second:free' },
]
const PAID = { provider: 'paid', model: 'premium' }
const REFUSED = 'FREE_MODE_ROUTE_REFUSED'

let section: Partial<FreeModeSettings> = { enabled: true, routes: LISTED }

/** A provider with a usable paid key: every request reaching it is recorded, and listed models fail. */
class PaidKeyAdapter extends LlmAdapter {
  readonly requests: string[] = []
  private readonly policy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  }, 'test')

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  override providerAccess() {
    return { streamIdleTimeoutMs: 20_000 }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(`${options.provider}/${options.model}`)
    await Promise.resolve()
    if (options.provider !== PAID.provider) throw new LlmError('503 overloaded', 'SERVER')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'paid answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'paid answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  section = { enabled: true, routes: LISTED }
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const MODULES = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-web', WebRuntime],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ['@deepseek-ai/dsh-llm-retry', retry],
  ['@deepseek-ai/dsh-llm-free-mode', LlmFreeMode],
])

async function load(): Promise<{ loaded: Context; adapter: PaidKeyAdapter }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-free-guarantee-'))
  const configPath = join(root, 'cordis.yml')
  const row = (name: string) => name === '@deepseek-ai/dsh-llm-free-mode'
    ? `- name: '${name}'\n  config: ${JSON.stringify(section)}`
    : `- name: '${name}'`
  await writeFile(configPath, [...MODULES.keys()].map(row).join('\n') + '\n')
  const loaded = new Context()
  context = loaded
  loaded.baseUrl = pathToFileURL(root).href + '/'
  await loaded.plugin(Loader)
  loaded.loader.builtins.include = Include
  loaded.loader.internal = fixtureModuleLoader(MODULES)
  await loaded.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await loaded.loader.await()
  const adapter = new PaidKeyAdapter()
  loaded.llm.registerAdapter(['openrouter', 'paid'], adapter)
  return { loaded, adapter }
}

async function agentOn(loaded: Context, route: { provider: string; model: string }): Promise<Agent> {
  const { agent } = await loaded.agents.create({
    sessionId: SessionId(`free-guarantee-${randomUUID()}`),
    meta: {},
    agentOptions: route,
  })
  await agent.whenIdle()
  return agent
}

function userMessage() {
  return createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
}

describe('free-mode no-charge guarantee', () => {
  it('sends nothing to a paid route when every listed route fails', { timeout: 60_000 }, async () => {
    const { loaded, adapter } = await load()
    const agent = await agentOn(loaded, FIRST)
    agent.followup(userMessage())
    await agent.whenIdle().catch(() => undefined)

    expect(adapter.requests.length).toBeGreaterThan(0)
    expect(adapter.requests).not.toContain('paid/premium')
  })

  it('refuses a subagent-style Agent pinned to a paid route', { timeout: 60_000 }, async () => {
    const { loaded, adapter } = await load()
    const agent = await agentOn(loaded, PAID)
    agent.followup(userMessage())
    await agent.whenIdle().catch(() => undefined)

    expect(adapter.requests).toEqual([])
  })

  it('refuses compaction configured on a paid route', { timeout: 60_000 }, async () => {
    const { loaded, adapter } = await load()
    const agent = await agentOn(loaded, FIRST)

    await expect(summarizeWithLlm(
      loaded,
      { summarizationProvider: PAID.provider, summarizationModel: PAID.model, maxTokens: 64 },
      { messages: [userMessage()] },
      agent,
    )).rejects.toMatchObject({ code: REFUSED })
    expect(adapter.requests).toEqual([])
  })

  it('refuses a session title configured on a paid route', { timeout: 60_000 }, async () => {
    const { loaded, adapter } = await load()
    const agent = await agentOn(loaded, FIRST)
    const config = resolveSessionTitleLlmConfig({
      ...PAID, maxInputBytes: 1_000, maxOutputTokens: 16, timeoutMs: 5_000,
    })

    await expect(executeSessionTitleLlm(
      loaded,
      config,
      { session: agent.session, signal: new AbortController().signal } as never,
      'free-guarantee' as never,
      { system: 'title', input: 'go', messageSeqs: [1] as never, selectReasoningEffort: () => undefined },
    )).rejects.toMatchObject({ code: REFUSED })
    expect(adapter.requests).toEqual([])
  })

  it('removes every refusal while disabled and keeps the configured list', { timeout: 60_000 }, async () => {
    section = { enabled: false, routes: LISTED }
    const { loaded, adapter } = await load()
    const agent = await agentOn(loaded, PAID)
    agent.followup(userMessage())
    await agent.whenIdle()

    expect(adapter.requests).toEqual(['paid/premium'])
    expect(loaded.freeMode.currentSettings().routes).toEqual(LISTED)
  })
})
