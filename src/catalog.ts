/**
 * CPA model catalog: fetch `/v1/models?client_version=…`, normalize the
 * Codex-style entries CPA returns, and keep a per-instance snapshot on disk.
 *
 * CPA answers this query with every model it serves (not only Codex ones),
 * each carrying reasoning levels, a default level, context window, input
 * modalities, service tiers, and visibility.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertInstanceId } from './config.ts'

export const FALLBACK_CONTEXT_WINDOW = 272_000
export const FALLBACK_MAX_TOKENS = 128_000
const CACHE_VERSION = 1

/** Instance-independent model entry, as stored in the cache. */
export interface CatalogModel {
  id: string
  name: string
  /** Normalized lowercase reasoning efforts as CPA spells them (`none`, `low`, …, `ultra`). */
  efforts: string[]
  /** CPA's `default_reasoning_level`, normalized. */
  defaultEffort?: string
  contextWindow?: number
  maxTokens?: number
  input: Array<'text' | 'image'>
  /** The catalog explicitly lists the `priority` service tier. */
  supportsPriority: boolean
  /** CPA marks the model `visibility: hide` (image/video or internal models). */
  hidden: boolean
}

export interface CatalogSnapshot {
  modelsUrl: string
  fetchedAt: number
  models: CatalogModel[]
}

export class CatalogHttpError extends Error {
  readonly status: number

  constructor(status: number, statusText: string, body: string) {
    const detail = body.trim() ? `: ${body.trim().slice(0, 200)}` : ''
    super(`models request failed with HTTP ${status} ${statusText}${detail}`)
    this.name = 'CatalogHttpError'
    this.status = status
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof CatalogHttpError && (error.status === 401 || error.status === 403)
}

type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return undefined
}

function nonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function normalizeEffort(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined
}

export function reasoningEfforts(raw: Raw): string[] {
  if (!Array.isArray(raw.supported_reasoning_levels)) return []
  const efforts: string[] = []
  for (const entry of raw.supported_reasoning_levels as unknown[]) {
    const effort = normalizeEffort(isRecord(entry) ? entry.effort : entry)
    if (effort && !efforts.includes(effort)) efforts.push(effort)
  }
  return efforts
}

function inputModalities(raw: Raw): Array<'text' | 'image'> {
  const input: Array<'text' | 'image'> = ['text']
  if (Array.isArray(raw.input_modalities)) {
    for (const modality of raw.input_modalities) {
      if (String(modality).trim().toLowerCase() === 'image' && !input.includes('image')) input.push('image')
    }
  }
  return input
}

/** Fast requires an explicit `priority` tier; a non-empty tier list alone is not enough. */
export function supportsPriorityTier(raw: Raw): boolean {
  if (!Array.isArray(raw.service_tiers)) return false
  return (raw.service_tiers as unknown[]).some((tier) => {
    const id = isRecord(tier) ? tier.id : tier
    return typeof id === 'string' && id.trim().toLowerCase() === 'priority'
  })
}

export function toCatalogModel(raw: Raw): CatalogModel | undefined {
  const id = nonEmptyString(raw.slug, raw.id)
  if (!id) return undefined
  const defaultEffort = normalizeEffort(raw.default_reasoning_level)
  const contextWindow = positiveInt(raw.context_window, raw.max_context_window, raw.context_length)
  const maxTokens = positiveInt(raw.max_tokens, raw.max_output_tokens, raw.max_completion_tokens)
  return {
    id,
    name: nonEmptyString(raw.display_name, raw.name) ?? id,
    efforts: reasoningEfforts(raw),
    ...defaultEffort ? { defaultEffort } : {},
    ...contextWindow ? { contextWindow } : {},
    ...maxTokens ? { maxTokens } : {},
    input: inputModalities(raw),
    supportsPriority: supportsPriorityTier(raw),
    hidden: String(raw.visibility ?? '').trim().toLowerCase() === 'hide',
  }
}

/** Map a raw catalog, dropping unusable entries and duplicate ids (first wins). */
export function mapCatalog(rawModels: unknown[]): CatalogModel[] {
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of rawModels) {
    const model = isRecord(raw) ? toCatalogModel(raw) : undefined
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

export function extractCatalogEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (isRecord(payload)) {
    if (Array.isArray(payload.models)) return payload.models
    if (Array.isArray(payload.data)) return payload.data
  }
  throw new Error('models response is not a model list (expected an array, {models: [...]}, or {data: [...]})')
}

export interface FetchCatalogOptions {
  timeoutMs: number
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string>
}

export async function fetchCatalog(modelsUrl: string, apiKey: string, options: FetchCatalogOptions): Promise<CatalogModel[]> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await (options.fetch ?? globalThis.fetch)(modelsUrl, {
      headers: { ...options.headers, Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal,
    })
  } catch (error) {
    if (timeout.aborted && !options.signal?.aborted) {
      throw new Error(`models request timed out after ${options.timeoutMs} ms`)
    }
    throw error
  }
  if (!response.ok) {
    throw new CatalogHttpError(response.status, response.statusText, await response.text().catch(() => ''))
  }
  const text = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('models response is not valid JSON')
  }
  return mapCatalog(extractCatalogEntries(payload))
}

// ---------------------------------------------------------------------------
// Disk cache: one JSON file per instance, never containing the key.

export function cachePathFor(cacheDir: string, instanceId: string): string {
  assertInstanceId(instanceId)
  return join(cacheDir, `${instanceId}.json`)
}

function isCatalogModel(value: unknown): value is CatalogModel {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string'
    && typeof value.name === 'string'
    && Array.isArray(value.efforts)
    && Array.isArray(value.input)
    && typeof value.supportsPriority === 'boolean'
    && typeof value.hidden === 'boolean'
  )
}

/** Load a snapshot only if it was fetched from the instance's current catalog URL. */
export function loadCatalogCache(cacheDir: string, instanceId: string, modelsUrl: string): CatalogSnapshot | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(cachePathFor(cacheDir, instanceId), 'utf8'))
    if (
      !isRecord(data)
      || data.version !== CACHE_VERSION
      || data.modelsUrl !== modelsUrl
      || typeof data.fetchedAt !== 'number'
      || !Array.isArray(data.models)
      || !data.models.every(isCatalogModel)
    ) {
      return undefined
    }
    return { modelsUrl, fetchedAt: data.fetchedAt, models: data.models }
  } catch {
    return undefined
  }
}

export function saveCatalogCache(cacheDir: string, instanceId: string, snapshot: CatalogSnapshot): void {
  const path = cachePathFor(cacheDir, instanceId)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: CACHE_VERSION, ...snapshot }, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

export function deleteCatalogCache(cacheDir: string, instanceId: string): void {
  rmSync(cachePathFor(cacheDir, instanceId), { force: true })
}
