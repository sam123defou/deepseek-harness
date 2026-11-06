/**
 * Free mode: admits only listed free routes, moves a failed step to the next
 * listed route after request retries end, and reads the daily quota. The
 * plugin stays inert until `llm-free-mode.enabled` is true in settings.
 * @module @deepseek-ai/dsh-llm-free-mode
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { cancellableDelay } from '@deepseek-ai/dsh-timeout'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-settings'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  checkRoute,
  FREE_MODE_SETTINGS_NAMESPACE,
  FreeModeSettingsSchema,
  sameRoute,
  validateFreeModeSettings,
} from './config.ts'
import type { FreeModeSettings, FreeRoute, RouteIssue } from './config.ts'
import {
  applyFailoverEvent,
  failoverCandidates,
  failoverExhausted,
  failoverStateSchema,
  failoverStopMessage,
  failureCause,
  initialFailoverState,
  ROUTE_REFUSED_CODE,
} from './failover.ts'
import type { FailoverState } from './failover.ts'
import { isOpenRouterEndpoint, readOpenRouterQuota } from './quota.ts'
import type { FreeModeQuota } from './quota.ts'
import type { FailureCause, FreeRouteKey, LlmFailoverEventData } from './types.ts'

export type { FreeModeSettings, FreeRoute, RouteIssue, RouteProblem } from './config.ts'
export { describeFailover, failoverStopMessage, ROUTE_REFUSED_CODE } from './failover.ts'
export { FREE_MODE_SETTINGS_NAMESPACE } from './config.ts'
export type { FreeModeQuota } from './quota.ts'
export type { FailureCause, FreeRouteKey, LlmFailoverEventData } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Free-route policy shared by the failover and the `free-check` profile. */
    freeMode: LlmFreeMode
  }
}

/** Composition entry of the plugin. */
export interface Config {
  /** `free-check` only: reports unusable routes instead of refusing requests for them. */
  reportOnly?: boolean
}

/** Free-mode service; see the module documentation. */
export class LlmFreeMode extends Service {
  static inject = ['agents', 'llm', 'sessionProjections', 'settings']

  static Config: z<Config> = z.object({
    reportOnly: z.boolean().default(false),
  })

  // Assigned synchronously by `installSection`; `settings` is a required injection.
  private source!: () => FreeModeSettings
  private validated: FreeModeSettings | undefined
  private readonly reportOnly: boolean
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<RequestErrorAction>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'freeMode')
    const entry = FreeModeSettingsSchema({} as FreeModeSettings)
    this.reportOnly = config.reportOnly === true
    ctx.settings.installSection(ctx, FREE_MODE_SETTINGS_NAMESPACE, FreeModeSettingsSchema, entry, {
      validate: validateFreeModeSettings,
      setSource: (current) => { this.source = current },
      onChange: () => { this.validated = undefined },
    })
    ctx.sessionProjections.register({
      key: 'llmFailover',
      stateVersion: 1,
      stateSchema: failoverStateSchema,
      init: initialFailoverState,
      apply: applyFailoverEvent,
    })
    ctx.llm.registerRouteGuard(route => this.admit(route))
    ctx.inject(['web'], (webCtx) => {
      webCtx.web.registerSearchGuard((provider) => {
        if (this.source().enabled && provider.billing !== 'free') {
          throw new WebError(`free mode refused web search provider "${provider.id}": it may bill requests`, 'WEB_PROVIDER_REFUSED_FREE_MODE')
        }
      })
    })
    const disposeListener = ctx.on('agent/request-error', (payload, next: () => Promise<RequestErrorAction>) => {
      return this.track(this.recover(payload, next))
    })
    ctx.effect(() => async () => {
      disposeListener()
      this.lifetime.abort(new Error('llm-free-mode plugin disposed'))
      await Promise.allSettled([...this.active])
    }, 'llm-free-mode: abort and drain active failover')
  }

  /**
   * Read the current section, with the list kept even when disabled.
   * @returns the resolved settings.
   */
  currentSettings(): FreeModeSettings {
    return this.source()
  }

  /**
   * Check every listed route without sending a model request.
   * @returns the problems found, in list order.
   */
  async checkRoutes(): Promise<RouteIssue[]> {
    const settings = this.source()
    const credentials = this.ctx.get('credentials')
    const issues: RouteIssue[] = []
    for (const route of settings.routes) {
      const found = await checkRoute(route, settings.maxRouteIdleMs, this.ctx.llm, credentials)
      if (found !== undefined) issues.push(found)
    }
    return issues
  }

  /**
   * Tell whether a provider publishes a catalog with per-model prices.
   * @param provider - registered provider route.
   * @returns true for an OpenRouter endpoint.
   */
  hasCatalog(provider: string): boolean {
    return isOpenRouterEndpoint(this.ctx.llm.providerAccess(provider)?.baseURL)
  }

  /**
   * Read the daily quota of one provider without a model request.
   * @param provider - registered provider route.
   * @param signal - optional cancellation.
   * @returns the quota, or `unknown` when the provider has no quota read.
   */
  async readQuota(provider: string, signal?: AbortSignal): Promise<FreeModeQuota> {
    const access = this.ctx.llm.providerAccess(provider)
    const ref = access?.credentialRef
    if (ref === undefined || access?.baseURL === undefined || !isOpenRouterEndpoint(access.baseURL)) {
      return { provider, state: 'unknown' }
    }
    const credential = await this.ctx.get('credentials')?.resolve(credentialRef(ref))
    if (credential === undefined) return { provider, state: 'unknown' }
    return readOpenRouterQuota(provider, access.baseURL, credential.value, this.source().networkTimeoutMs, signal)
  }

  private async admit(route: FreeRouteKey): Promise<void> {
    const settings = this.source()
    if (!settings.enabled) return
    if (!settings.routes.some(listed => sameRoute(listed, route))) {
      throw new LlmError(
        `free mode refused "${route.provider}/${route.model}": only routes listed in llm-free-mode may be used`,
        ROUTE_REFUSED_CODE,
      )
    }
    if (this.reportOnly || this.validated === settings) return
    const [first] = await this.checkRoutes()
    if (first !== undefined) throw new LlmError(first.message, first.code)
    this.validated = settings
  }

  private track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => this.active.delete(tracked))
    this.active.add(tracked)
    return tracked
  }

  private async causeOf(code: string, provider: string, signal: AbortSignal): Promise<FailureCause> {
    const cause = failureCause(code)
    if (cause !== 'rate-limited') return cause
    const quota = await this.readQuota(provider, signal)
    return quota.state === 'known' && quota.remaining <= 0 ? 'quota-exhausted' : cause
  }

  /** Resolve a route, or `undefined` when it cannot serve; a request config error ends here, not the turn. */
  private async prepare(route: FreeRouteKey, signal: AbortSignal): Promise<PreparedLlmCall | undefined> {
    try {
      return await this.ctx.llm.prepareCall({ provider: route.provider, model: route.model }, signal)
    } catch (error: unknown) {
      if (error instanceof LlmError) return undefined
      throw error
    }
  }

  private async nextRoute(
    candidates: readonly FreeRoute[],
    failed: FreeRouteKey,
    cause: FailureCause,
    signal: AbortSignal,
  ): Promise<FreeRoute | undefined> {
    const failedWindow = cause === 'context-exceeded'
      ? (await this.prepare(failed, signal))?.context?.contextWindow
      : undefined
    for (const candidate of candidates) {
      const prepared = await this.prepare(candidate, signal)
      if (prepared === undefined) continue
      if (cause !== 'context-exceeded') return candidate
      const window = prepared.context?.contextWindow
      if (failedWindow !== undefined && window !== undefined && window > failedWindow) return candidate
    }
    return undefined
  }

  private async recover(
    { agent, turn, step, failure, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const delegated = await next()
    const settings = this.source()
    const fused = AbortSignal.any([signal, this.lifetime.signal])
    if (delegated?.kind === 'retry' || fused.aborted || !settings.enabled) return delegated
    if (failure.code === ROUTE_REFUSED_CODE) return delegated
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a failed request logged its header first
    const { provider, model } = agent.session.requestHeader()!.config
    const from: FreeRouteKey = { provider, model }
    const cause = await this.causeOf(failure.code, from.provider, fused)
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'llmFailover') as FailoverState
    const route = failoverExhausted(cause, state, Date.now(), settings.maxFailoverMs)
      ? undefined
      : await this.nextRoute(failoverCandidates(settings.routes, from, cause, state), from, cause, fused)
    const record: LlmFailoverEventData = { turn, step, from, cause, failureCode: failure.code, delayMs: 0 }
    if (route === undefined) {
      agent.session.append('llm/failover', record)
      this.ctx.logger.warn(failoverStopMessage(cause))
      return undefined
    }
    const to: FreeRouteKey = { provider: route.provider, model: route.model }
    const applied = await agentEvents(this.ctx, agent).serial('agent/model-reroute', { route: to })
    if (applied !== true) {
      agent.session.append('llm/failover', record)
      return undefined
    }
    const delayMs = cause === 'rate-limited' ? settings.rateLimitDelayMs : 0
    agent.session.append('llm/failover', { ...record, to, delayMs })
    return await cancellableDelay(delayMs, fused) ? { kind: 'retry' } : undefined
  }
}

export default LlmFreeMode
