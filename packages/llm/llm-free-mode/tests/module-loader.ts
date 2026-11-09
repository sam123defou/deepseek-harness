/** Loader module resolution limited to the plugins a composition test supplies. */

import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'

/**
 * Resolve Loader imports from a fixed module table and reject every other module operation.
 * @param modules - specifier-to-module table; an absent specifier rejects its import.
 * @returns a Loader `internal` value for `ctx.loader.internal`.
 */
export function fixtureModuleLoader(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}
