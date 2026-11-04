/**
 * Model rules: match catalog models and compute the settings dsh sees.
 *
 * Rules apply in list order; a later matching rule overrides an earlier one
 * field by field. Reasoning levels can only be narrowed: a level the CPA
 * catalog does not offer for a model is ignored with a warning, because
 * sending it would make the upstream reject the request.
 */

import { type ModelRule, type Modality, THINKING_LEVELS, type ThinkingLevel } from './config.ts'
import { type CatalogModel, FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS } from './catalog.ts'

export interface CompiledRule {
  index: number
  rule: ModelRule
  regex: RegExp
}

export interface CompiledRules {
  rules: CompiledRule[]
  /** Rules that could not be compiled; each is skipped. */
  issues: string[]
}

/** The settings one model ends up with after its catalog entry and every matching rule. */
export interface EffectiveModel {
  id: string
  name: string
  /** Selectable dsh levels, lowest first; empty means the model is not a reasoning model. */
  levels: ThinkingLevel[]
  defaultLevel?: ThinkingLevel
  /** Every level the CPA catalog offers for this model, before rules narrow it. */
  offeredLevels: ThinkingLevel[]
  /** The catalog's own default level, when it maps to a dsh level. */
  catalogDefault?: ThinkingLevel
  contextWindow: number
  maxTokens: number
  input: Modality[]
  supportsPriority: boolean
  hidden: boolean
  /** Indexes of the rules that matched, in order. */
  matchedRules: number[]
  /** Rule settings that could not be honored. */
  warnings: string[]
}

/** Parse `/pattern/flags` as a regular expression, anything else as a case-insensitive glob. */
export function parseMatch(match: string): RegExp {
  const trimmed = match.trim()
  if (!trimmed) throw new Error('match is empty')
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(trimmed)
  if (literal) {
    // Stateful flags would make repeated tests alternate between hits and misses.
    const flags = (literal[2] ?? '').replace(/[gy]/g, '')
    return new RegExp(literal[1] ?? '', flags)
  }
  const source = trimmed.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${source}$`, 'i')
}

export function compileRules(rules: readonly ModelRule[]): CompiledRules {
  const compiled: CompiledRule[] = []
  const issues: string[] = []
  rules.forEach((rule, index) => {
    try {
      compiled.push({ index, rule, regex: parseMatch(rule.match) })
    } catch (error) {
      issues.push(`models[${index}] (${JSON.stringify(rule.match)}): ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return { rules: compiled, issues }
}

export function ruleMatches(rule: CompiledRule, route: string, modelId: string): boolean {
  return rule.regex.test(modelId) || rule.regex.test(`${route}/${modelId}`)
}

/** CPA spells "no reasoning" as `none`; dsh calls it `off`. Unknown levels such as `ultra` have no dsh slot. */
export function levelFromCatalog(effort: string): ThinkingLevel | undefined {
  if (effort === 'none') return 'off'
  if (effort === 'off') return undefined
  return (THINKING_LEVELS as readonly string[]).includes(effort) ? effort as ThinkingLevel : undefined
}

/** The wire spelling CPA expects for one dsh level. */
export function wireEffort(level: ThinkingLevel): string {
  return level === 'off' ? 'none' : level
}

interface MergedRule {
  efforts?: ThinkingLevel[]
  defaultEffort?: ThinkingLevel
  contextWindow?: number
  maxTokens?: number
  input?: Modality[]
  hidden?: boolean
}

function mergeMatching(rules: readonly CompiledRule[], route: string, modelId: string): { merged: MergedRule; matched: number[] } {
  const merged: MergedRule = {}
  const matched: number[] = []
  for (const compiled of rules) {
    if (!ruleMatches(compiled, route, modelId)) continue
    matched.push(compiled.index)
    const { rule } = compiled
    if (rule.efforts && rule.efforts.length > 0) merged.efforts = [...rule.efforts]
    if (rule.defaultEffort !== undefined) merged.defaultEffort = rule.defaultEffort
    if (rule.contextWindow !== undefined) merged.contextWindow = rule.contextWindow
    if (rule.maxTokens !== undefined) merged.maxTokens = rule.maxTokens
    if (rule.input && rule.input.length > 0) merged.input = [...new Set(rule.input)]
    if (rule.hidden !== undefined) merged.hidden = rule.hidden
  }
  return { merged, matched }
}

function sortLevels(levels: Iterable<ThinkingLevel>): ThinkingLevel[] {
  const set = new Set(levels)
  return THINKING_LEVELS.filter((level) => set.has(level))
}

export interface ResolveOptions {
  /** List models the catalog hides unless a rule hides them again. */
  showHidden?: boolean
}

export function resolveModel(
  catalog: CatalogModel,
  route: string,
  rules: readonly CompiledRule[],
  options: ResolveOptions = {},
): EffectiveModel {
  const { merged, matched } = mergeMatching(rules, route, catalog.id)
  const warnings: string[] = []

  const offered = sortLevels(catalog.efforts.flatMap((effort) => levelFromCatalog(effort) ?? []))
  let levels = offered
  if (merged.efforts) {
    const wanted = new Set(merged.efforts)
    const missing = merged.efforts.filter((level) => !offered.includes(level))
    if (missing.length > 0) {
      warnings.push(
        offered.length === 0
          ? `CPA 没有为该模型提供思考档位，efforts 被忽略`
          : `CPA 没有提供 ${missing.join(', ')}，已忽略（可选：${offered.join(', ')}）`,
      )
    }
    levels = offered.filter((level) => wanted.has(level))
    if (levels.length === 0 && offered.length > 0) {
      warnings.push('efforts 与 CPA 提供的档位没有交集，该模型将不发送思考强度')
    }
  }

  let defaultLevel: ThinkingLevel | undefined
  if (merged.defaultEffort !== undefined) {
    if (levels.includes(merged.defaultEffort)) defaultLevel = merged.defaultEffort
    else if (levels.length > 0) warnings.push(`defaultEffort "${merged.defaultEffort}" 不在可选档位里（${levels.join(', ')}），已改用 CPA 默认值`)
  }
  const catalogDefault = catalog.defaultEffort === undefined ? undefined : levelFromCatalog(catalog.defaultEffort)
  if (defaultLevel === undefined && catalogDefault !== undefined && levels.includes(catalogDefault)) {
    defaultLevel = catalogDefault
  }

  return {
    id: catalog.id,
    name: catalog.name,
    levels,
    ...defaultLevel === undefined ? {} : { defaultLevel },
    offeredLevels: offered,
    ...catalogDefault === undefined ? {} : { catalogDefault },
    contextWindow: merged.contextWindow ?? catalog.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: merged.maxTokens ?? catalog.maxTokens ?? FALLBACK_MAX_TOKENS,
    input: merged.input ?? [...catalog.input],
    supportsPriority: catalog.supportsPriority,
    hidden: merged.hidden ?? (catalog.hidden && options.showHidden !== true),
    matchedRules: matched,
    warnings,
  }
}
