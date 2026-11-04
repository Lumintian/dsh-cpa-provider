import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Api, Model, ProviderStreams, StreamOptions } from '@earendil-works/pi-ai'
import { buildCpaProvider, thinkingLevelMap, toPiModel, withPriorityTier } from '../src/provider.ts'
import type { EffectiveModel } from '../src/rules.ts'

const effective: EffectiveModel = {
  id: 'gpt-5.5',
  name: 'GPT-5.5',
  levels: ['low', 'xhigh'],
  defaultLevel: 'xhigh',
  offeredLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  contextWindow: 500000,
  maxTokens: 128000,
  input: ['text', 'image'],
  supportsPriority: true,
  hidden: false,
  matchedRules: [],
  warnings: [],
}

test('every level is explicit: selectable ones map to CPA spelling, the rest are null', () => {
  assert.deepEqual(thinkingLevelMap(['off', 'low', 'xhigh']), {
    off: 'none', minimal: null, low: 'low', medium: null, high: null, xhigh: 'xhigh', max: null,
  })
})

test('models speak openai-responses at the CPA /v1 base and leave the output cap to CPA', () => {
  const model = toPiModel(effective, 'cpa-home', 'http://cpa/v1', false) as Model<'openai-responses'>
  assert.equal(model.api, 'openai-responses')
  assert.equal(model.provider, 'cpa-home')
  assert.equal(model.baseUrl, 'http://cpa/v1')
  assert.equal(model.reasoning, true)
  assert.equal(model.name, 'GPT-5.5')
  assert.equal(model.compat?.supportsMaxOutputTokens, false)
  assert.equal(toPiModel(effective, 'cpa-home', 'http://cpa/v1', true).name, 'GPT-5.5 · Fast')
  const plain = toPiModel({ ...effective, levels: [] }, 'cpa-home', 'http://cpa/v1', false)
  assert.equal(plain.reasoning, false)
  assert.equal(plain.thinkingLevelMap, undefined)
})

test('the priority hook sets service_tier and still lets a caller hook decide last', async () => {
  const model = toPiModel(effective, 'cpa-home', 'http://cpa/v1', true)
  assert.deepEqual(await withPriorityTier(undefined)({ model: 'gpt-5.5' }, model), { model: 'gpt-5.5', service_tier: 'priority' })
  const caller = (payload: unknown) => ({ ...(payload as object), extra: 1 })
  assert.deepEqual(await withPriorityTier(caller)({ a: 1 }, model), { a: 1, service_tier: 'priority', extra: 1 })
})

test('only models in the fast set get the hook', async () => {
  const seen: Array<{ id: string; options: StreamOptions | undefined }> = []
  const api = {
    stream: (model: Model<Api>, _context: unknown, options?: StreamOptions) => { seen.push({ id: model.id, options }); return undefined },
    streamSimple: (model: Model<Api>, _context: unknown, options?: StreamOptions) => { seen.push({ id: model.id, options }); return undefined },
  } as unknown as ProviderStreams
  const fastModel = toPiModel(effective, 'cpa-home', 'http://cpa/v1', true)
  const slowModel = toPiModel({ ...effective, id: 'gpt-6-luna' }, 'cpa-home', 'http://cpa/v1', false)
  const provider = buildCpaProvider({
    route: 'cpa-home', displayName: 'Home', baseUrl: 'http://cpa/v1', models: [fastModel, slowModel], fastModels: new Set(['gpt-5.5']), api,
  })
  provider.streamSimple(fastModel, { messages: [] } as never, { apiKey: 'k' })
  provider.streamSimple(slowModel, { messages: [] } as never, { apiKey: 'k' })
  assert.equal(typeof seen[0]?.options?.onPayload, 'function')
  assert.equal(seen[0]?.options?.apiKey, 'k')
  assert.equal(seen[1]?.options?.onPayload, undefined)
  assert.deepEqual(provider.getModels().map(model => model.id), ['gpt-5.5', 'gpt-6-luna'])
  const auth = await provider.auth.apiKey!.resolve({ ctx: {} as never, credential: { type: 'api_key', key: 'sk' } as never, signal: AbortSignal.timeout(1000) })
  assert.deepEqual(auth?.auth, { apiKey: 'sk' })
})
