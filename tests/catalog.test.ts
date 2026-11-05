import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CatalogHttpError,
  extractCatalogEntries,
  fetchCatalog,
  isAuthError,
  loadCatalogCache,
  baseModelId,
  mapCatalog,
  modelPrefix,
  saveCatalogCache,
} from '../src/catalog.ts'
import { CPA_CATALOG } from './fixtures.ts'

test('maps CPA entries, dropping duplicates and id-less entries', () => {
  const models = mapCatalog(extractCatalogEntries(CPA_CATALOG))
  assert.deepEqual(models.map(model => model.id), ['gpt-5.5', 'gpt-6-luna', 'claude-sonnet-4-5', 'gpt-image-2'])
  const gpt = models[0]!
  assert.equal(gpt.name, 'GPT-5.5')
  assert.deepEqual(gpt.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.equal(gpt.defaultEffort, 'low')
  assert.equal(gpt.contextWindow, 500000)
  assert.equal(gpt.maxTokens, undefined)
  assert.deepEqual(gpt.input, ['text', 'image'])
  assert.equal(gpt.supportsPriority, true)
  assert.equal(gpt.hidden, false)
  const claude = models[2]!
  assert.equal(claude.supportsPriority, false)
  assert.equal(claude.maxTokens, 64000)
  assert.equal(models[3]!.hidden, true)
})

test('accepts bare arrays and OpenAI {data} lists, rejects other shapes', () => {
  assert.equal(extractCatalogEntries([{ id: 'a' }]).length, 1)
  assert.equal(extractCatalogEntries({ data: [{ id: 'a' }] }).length, 1)
  assert.throws(() => extractCatalogEntries({ nope: true }), /not a model list/)
})

test('fetch sends the key as a bearer token and maps the answer', async () => {
  let seen: { url: string; auth: string | null } | undefined
  const fetch = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get('authorization') }
    return new Response(JSON.stringify(CPA_CATALOG), { status: 200 })
  }) as typeof globalThis.fetch
  const models = await fetchCatalog('http://cpa/v1/models?client_version=dsh', 'sk-test', { timeoutMs: 1000, fetch })
  assert.equal(models.length, 4)
  assert.deepEqual(seen, { url: 'http://cpa/v1/models?client_version=dsh', auth: 'Bearer sk-test' })
})

test('HTTP failures carry the status, and 401/403 count as auth errors', async () => {
  const fetch = (async () => new Response('bad key', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch
  await assert.rejects(fetchCatalog('http://cpa/v1/models', 'k', { timeoutMs: 1000, fetch }), (error: unknown) => {
    assert.ok(error instanceof CatalogHttpError)
    assert.equal(error.status, 401)
    assert.ok(isAuthError(error))
    return true
  })
})

test('cache round-trips per models URL and is private to the user', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-cache-'))
  const models = mapCatalog(CPA_CATALOG.models)
  saveCatalogCache(dir, 'home', { modelsUrl: 'http://a/v1/models', fetchedAt: 42, models })
  assert.deepEqual(loadCatalogCache(dir, 'home', 'http://a/v1/models'), { modelsUrl: 'http://a/v1/models', fetchedAt: 42, models })
  assert.equal(loadCatalogCache(dir, 'home', 'http://b/v1/models'), undefined)
  assert.equal(loadCatalogCache(dir, 'other', 'http://a/v1/models'), undefined)
  assert.equal(statSync(join(dir, 'home.json')).mode & 0o077, 0)
  assert.ok(!readFileSync(join(dir, 'home.json'), 'utf8').includes('sk-'))
})

test('prefixed CPA aliases keep their prefix in the display name', () => {
  // Shape of a real CPA catalog: aliases copy the base model's display_name.
  const models = mapCatalog([
    { slug: 'gpt-6-luna', display_name: 'GPT 6.0 Luna' },
    { slug: 'api/gpt-6-luna', display_name: 'gpt-6-luna' },
    { slug: 'team/gpt-6-luna', display_name: 'GPT 6.0 Luna' },
    { slug: 'team/gpt-6-sol', display_name: 'team/GPT 6.0 Sol' },
    { slug: 'api/x' },
  ])
  assert.deepEqual(models.map(model => model.name), ['GPT 6.0 Luna', 'api/gpt-6-luna', 'team/GPT 6.0 Luna', 'team/GPT 6.0 Sol', 'api/x'])
  assert.equal(modelPrefix('a/b/c'), 'a', 'CPA splits at the first slash')
  assert.equal(modelPrefix('/x'), undefined)
  assert.equal(modelPrefix('x/'), undefined)
  assert.equal(baseModelId('team/gpt-6-luna'), 'gpt-6-luna')
  assert.equal(baseModelId('gpt-6-luna'), 'gpt-6-luna')
})
