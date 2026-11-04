/**
 * Instance registry: one dsh provider route (`cpa-<id>`) per configured CPA
 * instance, each with its own catalog, cache, refresh state, and errors. A
 * failing instance never blocks or clears another.
 *
 * The runtime turns "config + catalogs" into the immutable profile map the
 * pi-ai adapter reads on every operation. The map is rebuilt only when an
 * input changes, so unchanged state keeps its identity and the adapter keeps
 * its pi-ai collection.
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  type CatalogModel,
  type CatalogSnapshot,
  deleteCatalogCache,
  fetchCatalog,
  isAuthError,
  loadCatalogCache,
  saveCatalogCache,
} from './catalog.ts'
import {
  credentialRefFor,
  DEFAULT_FETCH_TIMEOUT_MS,
  type InstanceConfig,
  INSTANCE_ID_PATTERN,
  type ModelRule,
  routeFor,
  type ThinkingLevel,
} from './config.ts'
import { type CpaEndpoints, resolveEndpoints } from './endpoints.ts'
import { buildCpaProvider, toPiModel } from './provider.ts'
import { compileRules, type CompiledRules, type EffectiveModel, resolveModel } from './rules.ts'

/** A cache younger than this is trusted at startup instead of refetching. */
export const STARTUP_CACHE_FRESH_MS = 5 * 60_000
/** After a failed attempt, first-use waits do not refetch for this long (pickers reload often). */
export const FIRST_USE_RETRY_MS = 30_000

// Request-shaping defaults matching dsh-llm-pi-ai's own route defaults.
const STREAM_IDLE_TIMEOUT_MS = 300_000
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
// Fields newer dsh-llm-pi-ai releases read; harmless where unknown.
const FORWARD_COMPAT_PROFILE_FIELDS = { maxRequestImages: 50, imageOffloadCountQuantum: 10 }

export interface RuntimeLogger {
  warn(message: string): void
  info?(message: string): void
}

export interface RuntimeDeps {
  /** Directory holding one catalog snapshot per instance. */
  cacheDir: string
  /** Resolve a credential reference to its current value. */
  resolveKey: (ref: string) => Promise<string | undefined>
  logger: RuntimeLogger
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export interface RuntimeSettings {
  instances: readonly InstanceConfig[]
  rules: readonly ModelRule[]
  showHidden: boolean
  fetchTimeoutMs: number
}

export interface InstanceState {
  config: InstanceConfig
  route: string
  credentialRef: string
  endpoints?: CpaEndpoints
  /** Why this instance cannot serve (bad URL). */
  configError?: string
  /** Last successful catalog; kept when a refresh fails. */
  catalog?: CatalogSnapshot
  lastError?: string
  lastErrorIsAuth?: boolean
  refreshing: boolean
  generation: number
  controller?: AbortController
  /** The refresh currently in flight, so first use can wait for it. */
  inflight?: Promise<RefreshOutcome>
  /** When the last fetch attempt started. */
  lastAttemptAt?: number
}

export type RefreshOutcome =
  | { status: 'ok'; modelCount: number }
  | { status: 'no-key' }
  | { status: 'superseded' }

export interface RouteView {
  state: InstanceState
  displayName: string
  /** Every catalog model after rules, including hidden ones. */
  models: EffectiveModel[]
  /** Model ids whose requests carry the priority tier. */
  fast: Set<string>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export class CpaRuntime {
  private readonly deps: RuntimeDeps
  private readonly states = new Map<string, InstanceState>()
  private settings: RuntimeSettings = { instances: [], rules: [], showHidden: false, fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS }
  private compiled: CompiledRules = { rules: [], issues: [] }
  private revision = 0
  private memo: { revision: number; views: Map<string, RouteView>; profiles: Map<string, ResolvedPiAiProviderProfile> } | undefined
  private stopped = false
  private readonly listeners = new Set<() => void>()
  /** Problems found in the instance list; the affected entries are skipped. */
  configIssues: string[] = []

  constructor(deps: RuntimeDeps) {
    this.deps = deps
  }

  get ruleIssues(): readonly string[] {
    return this.compiled.issues
  }

  /** Subscribe to changes of anything the adapter or picker can observe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(): InstanceState[] {
    return [...this.states.values()]
  }

  get(instanceId: string): InstanceState | undefined {
    return this.states.get(instanceId)
  }

  byRoute(route: string): InstanceState | undefined {
    return this.list().find(state => state.route === route)
  }

  /** Routes that can be registered: every instance with a usable URL. */
  routes(): string[] {
    return this.list().filter(state => state.endpoints !== undefined).map(state => state.route)
  }

  /** Reconcile with a configuration snapshot. Returns whether anything changed. */
  applySettings(next: RuntimeSettings): boolean {
    const issues: string[] = []
    const wanted = new Map<string, InstanceConfig>()
    next.instances.forEach((instance, index) => {
      if (!INSTANCE_ID_PATTERN.test(instance.id)) {
        issues.push(`instances[${index}]: invalid id ${JSON.stringify(instance.id)}`)
      } else if (wanted.has(instance.id)) {
        issues.push(`instances[${index}]: duplicate id "${instance.id}", skipped`)
      } else {
        wanted.set(instance.id, instance)
      }
    })

    let changed = !sameJson(issues, this.configIssues)
    this.configIssues = issues

    for (const id of [...this.states.keys()]) {
      if (!wanted.has(id)) {
        this.drop(id)
        changed = true
      }
    }
    for (const instance of wanted.values()) {
      const existing = this.states.get(instance.id)
      if (existing && sameJson(existing.config, instance)) continue
      changed = true
      let endpoints: CpaEndpoints | undefined
      let configError: string | undefined
      try {
        endpoints = resolveEndpoints(instance.baseURL)
      } catch (error) {
        configError = errorMessage(error)
      }
      const ref = credentialRefFor(instance)
      if (existing) {
        const urlChanged = existing.endpoints?.modelsUrl !== endpoints?.modelsUrl
        const keyChanged = existing.credentialRef !== ref
        existing.config = instance
        existing.credentialRef = ref
        if (urlChanged) {
          this.cancel(existing)
          existing.generation++
          if (endpoints) existing.endpoints = endpoints
          else delete existing.endpoints
          const cached = endpoints ? loadCatalogCache(this.deps.cacheDir, instance.id, endpoints.modelsUrl) : undefined
          if (cached) existing.catalog = cached
          else delete existing.catalog
          delete existing.lastError
          delete existing.lastErrorIsAuth
        } else if (keyChanged) {
          delete existing.lastError
          delete existing.lastErrorIsAuth
        }
        if (configError) existing.configError = configError
        else delete existing.configError
      } else {
        const cached = endpoints ? loadCatalogCache(this.deps.cacheDir, instance.id, endpoints.modelsUrl) : undefined
        this.states.set(instance.id, {
          config: instance,
          route: routeFor(instance.id),
          credentialRef: ref,
          ...endpoints ? { endpoints } : {},
          ...configError ? { configError } : {},
          ...cached ? { catalog: cached } : {},
          refreshing: false,
          generation: 0,
        })
      }
    }

    if (!sameJson(next.rules, this.settings.rules)) {
      this.compiled = compileRules(next.rules)
      changed = true
    }
    if (next.showHidden !== this.settings.showHidden) changed = true
    this.settings = { ...next, instances: [...wanted.values()] }
    if (changed) this.bump()
    return changed
  }

  /** Fetch one instance's catalog. A failure keeps the previous catalog and is recorded. */
  refresh(instanceId: string, options: { timeoutMs?: number } = {}): Promise<RefreshOutcome> {
    const state = this.states.get(instanceId)
    const run = this.runRefresh(instanceId, options)
    if (state) {
      state.inflight = run
      const clear = (): void => { if (state.inflight === run) delete state.inflight }
      run.then(clear, clear)
    }
    return run
  }

  /**
   * Wait until a route has had one chance to load its catalog. A route with a
   * cached or fetched catalog returns at once; otherwise this joins the
   * in-flight fetch or starts one. Failures are recorded, never thrown: the
   * caller then sees an empty catalog and dsh reports the unknown model.
   */
  async ensureCatalog(route: string): Promise<void> {
    const state = this.byRoute(route)
    if (!state || state.catalog || !state.endpoints) return
    const now = (this.deps.now ?? Date.now)()
    if (!state.inflight && state.lastAttemptAt !== undefined && now - state.lastAttemptAt < FIRST_USE_RETRY_MS) return
    try {
      await (state.inflight ?? this.refresh(state.config.id))
    } catch {
      // Recorded in lastError; surfaced by /cpa.
    }
  }

  private async runRefresh(instanceId: string, options: { timeoutMs?: number }): Promise<RefreshOutcome> {
    const state = this.states.get(instanceId)
    if (!state) throw new Error(`unknown CPA instance "${instanceId}"`)
    if (!state.endpoints) throw new Error(state.configError ?? `CPA instance "${instanceId}" has no usable URL`)
    const apiKey = await this.deps.resolveKey(state.credentialRef)
    if (!apiKey) {
      state.lastError = `no API key: store it with /cpa-key ${instanceId} <key>, or set ${state.credentialRef}`
      state.lastErrorIsAuth = true
      return { status: 'no-key' }
    }

    this.cancel(state)
    state.lastAttemptAt = (this.deps.now ?? Date.now)()
    const generation = ++state.generation
    const controller = new AbortController()
    state.controller = controller
    state.refreshing = true
    const endpoints = state.endpoints
    const isCurrent = (): boolean => !this.stopped && this.states.get(instanceId) === state && state.generation === generation
    try {
      const models = await fetchCatalog(endpoints.modelsUrl, apiKey, {
        timeoutMs: options.timeoutMs ?? this.settings.fetchTimeoutMs,
        signal: controller.signal,
        ...this.deps.fetch ? { fetch: this.deps.fetch } : {},
      })
      if (!isCurrent()) return { status: 'superseded' }
      this.commitCatalog(state, endpoints, models)
      return { status: 'ok', modelCount: models.length }
    } catch (error) {
      if (!isCurrent()) return { status: 'superseded' }
      const message = errorMessage(error)
      if (state.lastError !== message) this.deps.logger.warn(`dsh-cpa-provider: refreshing "${instanceId}" failed: ${message}`)
      state.lastError = message
      state.lastErrorIsAuth = isAuthError(error)
      throw error
    } finally {
      if (state.generation === generation) {
        state.refreshing = false
        delete state.controller
      }
    }
  }

  /** Refresh every serviceable instance; `freshMs` skips catalogs younger than that. */
  async refreshAll(options: { freshMs?: number } = {}): Promise<void> {
    const now = (this.deps.now ?? Date.now)()
    await Promise.allSettled(this.list()
      .filter(state => state.endpoints !== undefined)
      .filter(state => options.freshMs === undefined || !state.catalog || now - state.catalog.fetchedAt >= options.freshMs)
      .map(state => this.refresh(state.config.id)))
  }

  /** Forget an instance's cached catalog on disk (instance removed by the user). */
  deleteCache(instanceId: string): void {
    try {
      deleteCatalogCache(this.deps.cacheDir, instanceId)
    } catch (error) {
      this.deps.logger.warn(`dsh-cpa-provider: failed to delete catalog cache for "${instanceId}": ${errorMessage(error)}`)
    }
  }

  /** Resolve the key a request on one route needs, failing loud when it is missing. */
  async requestKey(route: string): Promise<string> {
    const state = this.byRoute(route)
    if (!state) throw new LlmError(`dsh-cpa-provider does not own provider "${route}"`, 'NO_ADAPTER')
    const key = await this.deps.resolveKey(state.credentialRef)
    if (key) return key
    throw new LlmError(
      `dsh-cpa-provider: no API key for "${route}"; run /cpa-key ${state.config.id} <key> or set ${state.credentialRef}`,
      'MISSING_CREDENTIAL',
    )
  }

  views(): ReadonlyMap<string, RouteView> {
    return this.build().views
  }

  profiles(): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
    return this.build().profiles
  }

  /** The per-model default level for the current generation. */
  defaultLevel(route: string, modelId: string): ThinkingLevel | undefined {
    return this.views().get(route)?.models.find(model => model.id === modelId)?.defaultLevel
  }

  isFast(route: string, modelId: string): boolean {
    return this.views().get(route)?.fast.has(modelId) ?? false
  }

  stop(): void {
    this.stopped = true
    for (const state of this.states.values()) this.cancel(state)
    this.listeners.clear()
  }

  private commitCatalog(state: InstanceState, endpoints: CpaEndpoints, models: CatalogModel[]): void {
    const snapshot: CatalogSnapshot = { modelsUrl: endpoints.modelsUrl, fetchedAt: (this.deps.now ?? Date.now)(), models }
    try {
      saveCatalogCache(this.deps.cacheDir, state.config.id, snapshot)
    } catch (error) {
      this.deps.logger.warn(`dsh-cpa-provider: failed to write catalog cache for "${state.config.id}": ${errorMessage(error)}`)
    }
    const changed = !sameJson(state.catalog?.models, models)
    state.catalog = snapshot
    delete state.lastError
    delete state.lastErrorIsAuth
    if (changed) this.bump()
  }

  private bump(): void {
    this.revision++
    if (this.stopped) return
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.deps.logger.warn(`dsh-cpa-provider: change listener failed: ${errorMessage(error)}`)
      }
    }
  }

  private build(): { views: Map<string, RouteView>; profiles: Map<string, ResolvedPiAiProviderProfile> } {
    if (this.memo?.revision === this.revision) return this.memo
    const views = new Map<string, RouteView>()
    const profiles = new Map<string, ResolvedPiAiProviderProfile>()
    for (const state of this.states.values()) {
      if (!state.endpoints) continue
      const displayName = state.config.name && state.config.name.trim() ? state.config.name.trim() : `CPA ${state.config.id}`
      const models = (state.catalog?.models ?? []).map(model =>
        resolveModel(model, state.route, this.compiled.rules, { showHidden: this.settings.showHidden }))
      const fastWanted = new Set(state.config.fast)
      const fast = new Set(models.filter(model => model.supportsPriority && fastWanted.has(model.id)).map(model => model.id))
      views.set(state.route, { state, displayName, models, fast })

      const baseUrl = state.endpoints.inferenceBaseUrl
      const piModels = models
        .filter(model => !model.hidden)
        .map(model => toPiModel(model, state.route, baseUrl, fast.has(model.id)))
      const piProvider = buildCpaProvider({ route: state.route, displayName, baseUrl, models: piModels, fastModels: fast })
      const profile = {
        ...FORWARD_COMPAT_PROFILE_FIELDS,
        provider: state.route,
        displayName,
        apiKeyEnv: credentialRef(state.credentialRef),
        api: 'openai-responses',
        baseURL: baseUrl,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
        requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
        requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
        retryPolicy: resolveRetryPolicy(undefined, `dsh-cpa-provider: provider "${state.route}" retryPolicy`),
        piProvider,
        modelErrors: new Map<string, string>(),
        configuredMaxTokens: new Map<string, number>(),
      } satisfies ResolvedPiAiProviderProfile & typeof FORWARD_COMPAT_PROFILE_FIELDS
      profiles.set(state.route, profile)
    }
    this.memo = { revision: this.revision, views, profiles }
    return this.memo
  }

  private drop(instanceId: string): void {
    const state = this.states.get(instanceId)
    if (!state) return
    this.cancel(state)
    state.generation++
    this.states.delete(instanceId)
  }

  private cancel(state: InstanceState): void {
    state.controller?.abort()
    delete state.controller
    state.refreshing = false
  }
}
