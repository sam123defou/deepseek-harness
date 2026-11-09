/**
 * The `free-check` application: reports whether free mode can run, without any
 * model request, then exits. It never prints a credential value.
 * @module @deepseek-ai/dsh-free-check
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { attributionHeaders, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { LlmFreeMode, FreeModeQuota, FreeRouteKey, RouteProblem } from '@deepseek-ai/dsh-llm-free-mode'
import { z } from 'zod'

/** Stable Cordis plugin name. */
export const name = 'free-check'

/** Services read by the diagnostic. */
export const inject = ['cmdlineArgs', 'freeMode', 'llm']

/** State of one listed route. */
export type RouteState = 'ok' | 'unknown' | 'model-withdrawn' | 'model-now-paid' | RouteProblem

/** Diagnostic result of one listed route. */
export interface RouteReport extends FreeRouteKey {
  state: RouteState
  /** What the user can do; absent for `ok` and `unknown`. */
  action?: string
}

/** Complete diagnostic result. */
export interface FreeCheckReport {
  enabled: boolean
  ready: boolean
  routes: RouteReport[]
  quota: FreeModeQuota[]
}

/** Model facts read from one provider catalog; absent when no catalog can be read. */
type Catalog = ReadonlyMap<string, { readonly free: boolean }>

const catalogSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    pricing: z.object({ prompt: z.string(), completion: z.string() }),
  })),
})

/** Read the public model catalog of an OpenRouter-compatible endpoint. */
async function readCatalog(baseURL: string, timeoutMs: number): Promise<Catalog | undefined> {
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers: attributionHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const parsed = catalogSchema.safeParse(await response.json())
    if (!parsed.success) return undefined
    return new Map(parsed.data.data.map(model => [model.id, {
      free: Number(model.pricing.prompt) === 0 && Number(model.pricing.completion) === 0,
    }]))
  } catch (_catalogReadFailure) {
    // Network, abort, and JSON failures leave the model state unknown, which
    // the report shows instead of claiming the route is usable.
    return undefined
  }
}

function catalogState(route: FreeRouteKey, catalog: Catalog | undefined): RouteReport {
  if (catalog === undefined) return { ...route, state: 'unknown' }
  const model = catalog.get(route.model)
  if (model === undefined) {
    return { ...route, state: 'model-withdrawn', action: 'remove this model from llm-free-mode.routes' }
  }
  return model.free
    ? { ...route, state: 'ok' }
    : { ...route, state: 'model-now-paid', action: 'remove this model from llm-free-mode.routes' }
}

/** The free-mode and provider-access reads that {@link diagnose} performs. */
export interface FreeCheckServices {
  freeMode: Pick<LlmFreeMode, 'currentSettings' | 'checkRoutes' | 'hasCatalog' | 'readQuota'>
  llm: Pick<LlmRuntime, 'providerAccess'>
}

/**
 * Build the report. The two reads per provider run together so the command
 * stays within one network timeout.
 * @param ctx - context carrying `freeMode` and `llm`.
 * @returns the complete report.
 */
export async function diagnose(ctx: FreeCheckServices): Promise<FreeCheckReport> {
  const freeMode = ctx.freeMode
  const settings = freeMode.currentSettings()
  const issues = await freeMode.checkRoutes()
  const providers = [...new Set(settings.routes.map(route => route.provider))]
  const usable = providers.filter(provider => !issues.some(issue => issue.route.provider === provider && issue.problem === 'provider-unknown'))
  const [catalogs, quota] = await Promise.all([
    Promise.all(usable.map(async (provider) => {
      const access = ctx.llm.providerAccess(provider)
      const catalog = access?.baseURL !== undefined && freeMode.hasCatalog(provider)
        ? await readCatalog(access.baseURL, settings.networkTimeoutMs)
        : undefined
      return [provider, catalog] as const
    })),
    Promise.all(usable.map(provider => freeMode.readQuota(provider))),
  ])
  const byProvider = new Map(catalogs)
  const routes = settings.routes.map((route): RouteReport => {
    const key = { provider: route.provider, model: route.model }
    const found = issues.find(issue => issue.route.provider === key.provider && issue.route.model === key.model)
    return found === undefined
      ? catalogState(key, byProvider.get(key.provider))
      : { ...key, state: found.problem, action: found.message }
  })
  return {
    enabled: settings.enabled,
    ready: settings.enabled
      && routes.some(route => route.state === 'ok' || route.state === 'unknown')
      && !routes.some(route => route.state === 'model-now-paid'),
    routes,
    quota,
  }
}

/**
 * Render the report for a terminal.
 * @param report - complete report.
 * @returns text ending in a newline.
 */
export function renderReport(report: FreeCheckReport): string {
  const lines = [`free mode: ${report.enabled ? 'enabled' : 'disabled'}, ${report.ready ? 'ready' : 'not ready'}`]
  for (const route of report.routes) {
    lines.push(`  ${route.state.padEnd(20)} ${route.provider}/${route.model}${route.action === undefined ? '' : ` - ${route.action}`}`)
  }
  for (const quota of report.quota) {
    lines.push(quota.state === 'known'
      ? `  quota ${quota.provider}: ${quota.used}/${quota.limit} used, ${quota.remaining} left today`
      : `  quota ${quota.provider}: unknown`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Tell the process exit code of a report.
 * @param report - complete report.
 * @returns `0` when ready or disabled, otherwise `1`.
 */
export function exitCode(report: FreeCheckReport): number {
  return report.ready || !report.enabled ? 0 : 1
}

/** Run the diagnostic and request the process exit. */
async function run(ctx: Context, json: boolean, exit: (code: number) => void): Promise<void> {
  // Loader siblings mount concurrently; every provider route must exist first.
  await ctx.get('loader')?.await()
  const report = await diagnose(ctx)
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report))
  exit(exitCode(report))
}

/**
 * Mount the diagnostic.
 * @param ctx - plugin context carrying the command line and free mode.
 */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('free-check: the launcher must provide ctx.appExit before the tree mounts')
  const program = new Command()
    .name('dsh --profile free-check')
    .description('Report whether free mode can run, without any model request.')
    .helpOption('-h, --help', 'show this help')
    .option('--json', 'print the report as JSON')
  program.action(() => {
    void run(ctx, program.opts<{ json?: boolean }>().json === true, exit).catch((error: unknown) => {
      process.stderr.write(`dsh: free-check failed: ${error instanceof Error ? error.message : String(error)}\n`)
      exit(2)
    })
  })
  parseCmdline(ctx, program)
}
