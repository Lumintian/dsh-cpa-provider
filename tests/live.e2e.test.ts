/**
 * Live end to end against a real CPA instance. Skipped unless both
 * `CPA_LIVE_URL` and `CPA_LIVE_KEY` are set; the key only lives in the
 * environment and the in-memory credential stand-in, never on disk.
 *
 *   CPA_LIVE_URL=https://cpa.example.com CPA_LIVE_KEY=sk-… node --test tests/live.e2e.test.ts
 *
 * Optional: `CPA_LIVE_MODEL` (default `gpt-6-luna`) picks the base model whose
 * plain and prefixed variants are exercised. Every request asks for a few
 * tokens at the lowest effort to keep usage small.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { createUserMessage, ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'

const URL = process.env.CPA_LIVE_URL
const KEY = process.env.CPA_LIVE_KEY
const BASE = process.env.CPA_LIVE_MODEL ?? 'gpt-6-luna'
const skip = !URL || !KEY ? 'set CPA_LIVE_URL and CPA_LIVE_KEY to run against a real CPA' : false

let home: string
const realFetch = globalThis.fetch
/** Request bodies sent to /v1/responses (no headers, so no key). */
const sent: Array<Record<string, unknown>> = []

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-cpa-live-'))
  process.env.DSH_HOME = home
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    if (url.endsWith('/v1/responses') && typeof init?.body === 'string') sent.push(JSON.parse(init.body) as Record<string, unknown>)
    return await realFetch(input, init)
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
  rmSync(home, { recursive: true, force: true })
})

async function boot(config: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const values = new Map([['CPA_LIVE_API_KEY', KEY!]])
  ctx.provide('credentials', {
    resolve: async (ref: string) => (values.has(ref) ? { value: values.get(ref)!, source: 'store' } : undefined),
    describe: async (ref: string) => ({ configured: values.has(ref), writable: false }),
    set: async () => {},
    unset: async () => {},
  } as never)
  ctx.provide('commands', { register: () => () => {} } as never)
  await ctx.plugin(Loader)
  ctx.loader.builtins['cpa-under-test'] = plugin
  const id = await ctx.loader.create({ id: 'cpa-provider', name: 'cordis:cpa-under-test', config } as { name: string; config: unknown })
  await ctx.loader.resolve(id).fiber!.await()
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const textOf = (chunks: StreamChunk[]) => chunks.flatMap(chunk => (chunk.type === 'text-delta' ? [chunk.text] : [])).join('')
const finishOf = (chunks: StreamChunk[]) => chunks.find(chunk => chunk.type === 'finish')

test('live CPA: catalog, prefixed models, rules, requests, Fast, tool call', { skip, timeout: 180_000 }, async () => {
  const app = await boot({
    instances: [{ id: 'live', name: 'CPA live', baseURL: URL, fast: [`team/${BASE}`] }],
    models: [{ match: BASE, efforts: ['low', 'max'], defaultEffort: 'low' }],
  })
  try {
    const { ctx } = app
    const route = 'cpa-live'
    const models = await ctx.llm.listModels(route)
    assert.ok(models.length > 0, 'the catalog loads')
    const ids = models.map(model => model.id)
    console.log(`catalog: ${models.length} visible models`)
    for (const model of models) console.log(`  ${model.id}  →  ${model.name}`)

    // Every visible model has a name of its own, so prefixed aliases are distinguishable.
    const names = models.map(model => model.name)
    const repeated = names.filter((name, index) => names.indexOf(name) !== index)
    assert.deepEqual(repeated, [], 'no two models in one group share a display name')

    const variants = [BASE, `api/${BASE}`, `team/${BASE}`].filter(id => ids.includes(id))
    console.log(`variants under test: ${variants.join(', ')}`)
    assert.ok(variants.length > 0, `${BASE} is served`)
    for (const id of variants) {
      const info = await ctx.llm.resolveModelInfo(route, id)
      assert.deepEqual(info.reasoning?.efforts.map(effort => String(effort.id)), ['low', 'max'], `${id}: the ${BASE} rule applies`)
      assert.equal(String(info.reasoning?.defaultEffort), 'low', `${id}: default effort from the rule`)
    }

    const ask = (text: string) => [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })]
    for (const id of variants) {
      const before = sent.length
      const chunks = await collect(ctx.llm.stream({ provider: route, model: id, messages: ask('Reply with exactly: OK') }))
      const finish = finishOf(chunks)
      console.log(`${id}: finish=${JSON.stringify(finish && 'reason' in finish ? finish.reason : finish)} text=${JSON.stringify(textOf(chunks))}`)
      assert.ok(textOf(chunks).trim().length > 0, `${id} answers`)
      const body = sent.slice(before).at(-1)
      assert.ok(body, `${id}: a /v1/responses request was sent`)
      assert.equal(body.model, id, `${id}: the full prefixed id goes on the wire`)
      assert.deepEqual(body.reasoning, { effort: 'low', summary: 'auto' })
      if (id === `team/${BASE}`) assert.equal(body.service_tier, 'priority', 'Fast adds the priority tier')
      else assert.equal(body.service_tier, undefined, `${id}: no Fast`)
    }

    // A tool call round trip on the plain model.
    const tool = {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
    }
    const toolChunks = await collect(ctx.llm.stream({
      provider: route,
      model: variants[0]!,
      reasoningEffort: ReasoningEffortId('low'),
      tools: [tool],
      messages: ask('Use the get_weather tool for Paris. Do not answer without calling it.'),
    }))
    const calls = toolChunks.flatMap(chunk => (chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : []))
    console.log(`tool call: ${JSON.stringify(calls)}`)
    assert.equal(calls.length > 0, true, 'the model calls the tool')
    assert.equal((calls[0] as { name?: string }).name, 'get_weather')
  } finally {
    await app.dispose()
  }
})
