import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { InstanceConfig } from '../src/config.ts'
import { CpaRuntime, type RuntimeSettings } from '../src/runtime.ts'
import { CPA_CATALOG } from './fixtures.ts'

function instance(fields: Partial<InstanceConfig> & { id: string }): InstanceConfig {
  return { baseURL: `http://${fields.id}.cpa`, fast: [], ...fields }
}

function settings(instances: InstanceConfig[]): RuntimeSettings {
  return { instances, rules: [], showHidden: false, fetchTimeoutMs: 1000 }
}

function setup(options: { keys?: Record<string, string>; fail?: Set<string>; now?: () => number } = {}) {
  const keys = options.keys ?? { CPA_HOME_API_KEY: 'k1', CPA_WORK_API_KEY: 'k2' }
  const calls: string[] = []
  const fetch = (async (url: string) => {
    calls.push(url)
    const host = new URL(url).hostname
    if (options.fail?.has(host)) return new Response('upstream down', { status: 502, statusText: 'Bad Gateway' })
    return new Response(JSON.stringify(CPA_CATALOG), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const warnings: string[] = []
  const runtime = new CpaRuntime({
    cacheDir: mkdtempSync(join(tmpdir(), 'cpa-runtime-')),
    resolveKey: async ref => keys[ref],
    logger: { warn: message => { warnings.push(message) } },
    fetch,
    ...options.now ? { now: options.now } : {},
  })
  return { runtime, calls, warnings }
}

test('each instance is its own route; a bad URL is reported without affecting the others', async () => {
  const { runtime } = setup()
  runtime.applySettings(settings([
    instance({ id: 'home', name: '家用' }),
    instance({ id: 'broken', baseURL: 'ftp://nope' }),
    instance({ id: 'home', baseURL: 'http://dup' }),
  ]))
  assert.deepEqual(runtime.routes(), ['cpa-home'])
  assert.match(runtime.get('broken')!.configError!, /http or https/)
  assert.match(runtime.configIssues[0]!, /duplicate id "home"/)
  await runtime.refreshAll()
  const view = runtime.views().get('cpa-home')!
  assert.equal(view.displayName, '家用')
  assert.equal(view.models.length, 4)
  assert.deepEqual([...runtime.profiles().keys()], ['cpa-home'])
})

test('a failed refresh keeps the last catalog and records the error', async () => {
  const fail = new Set<string>()
  const { runtime, warnings } = setup({ fail })
  runtime.applySettings(settings([instance({ id: 'home' })]))
  await runtime.refresh('home')
  const before = runtime.profiles()
  fail.add('home.cpa')
  await assert.rejects(runtime.refresh('home'), /502/)
  assert.match(runtime.get('home')!.lastError!, /502/)
  assert.equal(warnings.length, 1)
  assert.equal(runtime.profiles(), before, 'unchanged inputs keep the same profile map')
  assert.equal(runtime.views().get('cpa-home')!.models.length, 4)
})

test('fast only applies to models whose catalog lists priority', async () => {
  const { runtime } = setup()
  runtime.applySettings(settings([instance({ id: 'home', fast: ['gpt-5.5', 'claude-sonnet-4-5', 'missing'] })]))
  await runtime.refresh('home')
  assert.equal(runtime.isFast('cpa-home', 'gpt-5.5'), true)
  assert.equal(runtime.isFast('cpa-home', 'claude-sonnet-4-5'), false)
  assert.equal(runtime.isFast('cpa-home', 'missing'), false)
})

test('first use waits for the initial catalog, and a missing key does not hang', async () => {
  const { runtime, calls } = setup({ keys: { CPA_HOME_API_KEY: 'k1' } })
  runtime.applySettings(settings([instance({ id: 'home' }), instance({ id: 'work' })]))
  await runtime.ensureCatalog('cpa-home')
  assert.equal(runtime.views().get('cpa-home')!.models.length, 4)
  await runtime.ensureCatalog('cpa-home')
  assert.equal(calls.length, 1, 'a loaded catalog is not fetched again')
  await runtime.ensureCatalog('cpa-work')
  assert.match(runtime.get('work')!.lastError!, /cpa-key work/)
  await assert.rejects(runtime.requestKey('cpa-work'), /MISSING_CREDENTIAL|no API key/)
})

test('changes notify listeners; identical settings do not', async () => {
  const { runtime } = setup()
  let changes = 0
  runtime.onChange(() => { changes++ })
  runtime.applySettings(settings([instance({ id: 'home' })]))
  assert.equal(changes, 1)
  assert.equal(runtime.applySettings(settings([instance({ id: 'home' })])), false)
  assert.equal(changes, 1)
  await runtime.refresh('home')
  assert.equal(changes, 2)
  await runtime.refresh('home')
  assert.equal(changes, 2, 'an identical catalog is not a change')
  runtime.applySettings(settings([instance({ id: 'home', fast: ['gpt-5.5'] })]))
  assert.equal(changes, 3)
})

test('after a failed first fetch, first-use waits back off instead of refetching every time', async () => {
  let now = 1_000_000
  const fail = new Set(['home.cpa'])
  const { runtime, calls } = setup({ fail, now: () => now })
  runtime.applySettings(settings([instance({ id: 'home' })]))
  await runtime.ensureCatalog('cpa-home')
  await runtime.ensureCatalog('cpa-home')
  assert.equal(calls.length, 1, 'the second wait reuses the recent failure')
  now += 31_000
  fail.clear()
  await runtime.ensureCatalog('cpa-home')
  assert.equal(calls.length, 2)
  assert.equal(runtime.views().get('cpa-home')!.models.length, 4)
})
