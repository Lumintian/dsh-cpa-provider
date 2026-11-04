/**
 * pi-ai pieces for one CPA route: model descriptors and the provider that
 * streams them through the stock OpenAI Responses implementation.
 *
 * Fast is applied here. The provider wraps the protocol's stream calls and,
 * for models with Fast on, adds a payload hook that sets
 * `service_tier: "priority"` on the request body right before it is sent.
 * CPA forwards that field to Codex (subscription: faster, uses quota faster)
 * or to the OpenAI API (API key: Priority processing, billed at priority
 * rates). Nothing else about the request changes.
 */

import type {
  Api,
  ApiKeyAuth,
  Model,
  Provider,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
  ThinkingLevelMap,
} from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { THINKING_LEVELS } from './config.ts'
import type { EffectiveModel } from './rules.ts'
import { wireEffort } from './rules.ts'

export const CPA_API = 'openai-responses'
export const FAST_SERVICE_TIER = 'priority'

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Every level gets an explicit entry: the wire spelling when selectable,
 * `null` when not. pi-ai treats a missing `xhigh`/`max` as unsupported but a
 * missing lower level as supported, so leaving gaps would offer levels CPA
 * never listed. `off: null` also stops pi-ai from sending `effort: "none"`
 * to a model that cannot turn reasoning off.
 */
export function thinkingLevelMap(levels: readonly string[]): ThinkingLevelMap {
  const allowed = new Set(levels)
  const map: ThinkingLevelMap = {}
  for (const level of THINKING_LEVELS) map[level] = allowed.has(level) ? wireEffort(level) : null
  return map
}

export function fastDisplayName(name: string, fast: boolean): string {
  return fast ? `${name} · Fast` : name
}

export function toPiModel(model: EffectiveModel, route: string, baseUrl: string, fast: boolean): Model<Api> {
  const reasoning = model.levels.length > 0
  return {
    id: model.id,
    name: fastDisplayName(model.name, fast),
    api: CPA_API,
    provider: route,
    baseUrl,
    reasoning,
    ...reasoning ? { thinkingLevelMap: thinkingLevelMap(model.levels) } : {},
    input: [...model.input],
    cost: { ...NO_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // CPA and its upstreams pick the output cap; a guessed cap could cut a
    // long xhigh answer short or be refused by a smaller upstream model.
    compat: { supportsMaxOutputTokens: false },
  } as Model<Api>
}

type PayloadHook = NonNullable<StreamOptions['onPayload']>

/** Set the priority tier, then let any caller hook keep the final say. */
export function withPriorityTier(onPayload: StreamOptions['onPayload']): PayloadHook {
  return async (payload, model) => {
    const fast = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>), service_tier: FAST_SERVICE_TIER }
      : payload
    const next = await onPayload?.(fast, model)
    return next === undefined ? fast : next
  }
}

/** Api-key auth for a key the adapter already resolved and passes per request. */
function requestKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

export interface CpaProviderSpec {
  route: string
  displayName: string
  baseUrl: string
  models: readonly Model<Api>[]
  /** Model ids whose requests carry the priority tier, fixed for this provider generation. */
  fastModels: ReadonlySet<string>
  /** Injection point for tests; defaults to pi-ai's lazily loaded Responses implementation. */
  api?: ProviderStreams
}

export function buildCpaProvider(spec: CpaProviderSpec): Provider {
  const api = spec.api ?? openAIResponsesApi()
  const fastOptions = <T extends StreamOptions | SimpleStreamOptions>(model: Model<Api>, options: T | undefined): T | undefined =>
    spec.fastModels.has(model.id)
      ? { ...options, onPayload: withPriorityTier(options?.onPayload) } as T
      : options
  return {
    id: spec.route,
    name: spec.displayName,
    baseUrl: spec.baseUrl,
    auth: { apiKey: requestKeyAuth(spec.displayName) },
    getModels: () => spec.models,
    stream: (model, context, options) => api.stream(model, context, fastOptions(model, options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, fastOptions(model, options)),
  } as Provider
}
