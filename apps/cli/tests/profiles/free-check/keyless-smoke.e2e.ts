import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const binScript = fileURLToPath(new URL('../../../src/bin.ts', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

let home: string | undefined

afterEach(async () => {
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function freeCheck(settings: string) {
  home = await mkdtemp(join(tmpdir(), 'dsh-free-check-'))
  await writeFile(join(home, 'settings.yaml'), settings)
  return execa('node', ['--import', 'tsx/esm', binScript, '--profile', 'free-check', '--json'], {
    cwd: repoRoot,
    env: { DSH_HOME: home, OPENROUTER_API_KEY: '' },
    reject: false,
  })
}

describe('dsh --profile free-check', () => {
  it('reports disabled free mode on an empty home', { timeout: 120_000 }, async () => {
    const result = await freeCheck('{}\n')
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ enabled: false, ready: false, routes: [] })
  })

  it('reports a missing credential instead of failing to start', { timeout: 120_000 }, async () => {
    const result = await freeCheck([
      'llm-pi-ai:',
      '  providers:',
      '    openrouter:',
      '      apiKeyEnv: OPENROUTER_API_KEY',
      '      streamIdleTimeoutMs: 20000',
      '      models:',
      '        - id: google/gemma-4-31b-it:free',
      'llm-free-mode:',
      '  enabled: true',
      '  routes:',
      '    - provider: openrouter',
      '      model: google/gemma-4-31b-it:free',
      '',
    ].join('\n'))
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      enabled: true,
      ready: false,
      routes: [{ model: 'google/gemma-4-31b-it:free', state: 'credential-missing' }],
    })
  })
})
