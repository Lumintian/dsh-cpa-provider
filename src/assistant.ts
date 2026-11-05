/**
 * Configuration help for the agent: the `cpa_config` tool reads the current
 * setup with each instance's live catalog, previews a proposed setup (schema
 * errors, rule warnings, and the per-model result), and applies it after the
 * user confirms on a card. Everything here is keyless: keys never enter a
 * proposal, a preview, or a result, because tool results land in the session
 * log.
 *
 * A proposal replaces whole lists (`instances`, `models`), the same unit the
 * `/cpa*` commands write. Omitted lists keep their current value.
 */

import { Config, credentialRefFor, INSTANCE_ID_PATTERN, type InstanceConfig, type ModelRule, routeFor } from './config.ts'
import type { CatalogModel } from './catalog.ts'
import { resolveEndpoints } from './endpoints.ts'
import { compileRules, type EffectiveModel, resolveModel, ruleMatches } from './rules.ts'
import type { CommandHost } from './commands.ts'

export interface Proposal {
  instances?: InstanceConfig[]
  models?: ModelRule[]
}

export interface Preview {
  /** Problems that block applying. */
  errors: string[]
  /** Accepted but probably not what was meant. */
  warnings: string[]
  /** One line per instance or model whose effective settings change. */
  changes: string[]
  /** The normalized lists that would be written. */
  instances: InstanceConfig[]
  models: ModelRule[]
  instancesChanged: boolean
  modelsChanged: boolean
}

/** Field names that look like a secret; a proposal carrying one is refused. */
const SECRET_FIELD = /^(api[-_]?key|key|token|secret|password|authorization)$/i

function findSecretFields(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretFields(item, `${path}[${index}]`, found))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELD.test(key)) found.push(`${path}.${key}`)
      findSecretFields(item, `${path}.${key}`, found)
    }
  }
}

const levelsText = (levels: readonly string[]) => (levels.length > 0 ? levels.join('/') : '无')

/** A compact, comparable digest of what dsh sees for one model. */
function digest(model: EffectiveModel, fast: boolean): string {
  if (model.hidden) return '隐藏'
  return [
    `档位 ${levelsText(model.levels)}`,
    `默认 ${model.defaultLevel ?? '无'}`,
    `上下文 ${model.contextWindow}`,
    `输入 ${model.input.join('+')}`,
    ...fast ? ['Fast'] : [],
  ].join(' · ')
}

function normalizeInstances(instances: readonly InstanceConfig[]): InstanceConfig[] {
  return instances.map(instance => ({
    id: instance.id,
    ...instance.name === undefined ? {} : { name: instance.name },
    baseURL: instance.baseURL,
    ...instance.apiKeyEnv === undefined ? {} : { apiKeyEnv: instance.apiKeyEnv },
    fast: [...instance.fast ?? []],
  }))
}

function normalizeRules(rules: readonly ModelRule[]): ModelRule[] {
  return rules.map((rule) => {
    const out: ModelRule = { match: rule.match, efforts: [...rule.efforts ?? []], input: [...rule.input ?? []] }
    if (rule.defaultEffort !== undefined) out.defaultEffort = rule.defaultEffort
    if (rule.contextWindow !== undefined) out.contextWindow = rule.contextWindow
    if (rule.maxTokens !== undefined) out.maxTokens = rule.maxTokens
    if (rule.hidden !== undefined) out.hidden = rule.hidden
    return out
  })
}

/** Catalog models per instance id, from the last successful fetch. */
function catalogs(host: CommandHost): Map<string, CatalogModel[]> {
  return new Map(host.runtime.list().flatMap(state => (state.catalog ? [[state.config.id, state.catalog.models] as const] : [])))
}

/** Volatile config fields parse to handles with `get()`; plain values pass through. */
function unwrap<T>(value: unknown): T {
  const handle = value as { get?: () => unknown } | undefined
  return (typeof handle?.get === 'function' ? handle.get() : value) as T
}

export function previewProposal(host: CommandHost, proposal: Proposal): Preview {
  const errors: string[] = []
  const warnings: string[] = []
  const changes: string[] = []

  const secrets: string[] = []
  findSecretFields(proposal, 'proposal', secrets)
  if (secrets.length > 0) {
    errors.push(`配置里不能写 key（${secrets.join(', ')}）。key 请让用户用 /cpa-key 设置，或用 apiKeyEnv 指向环境变量名`)
  }

  const currentInstances = normalizeInstances(host.readInstances())
  const currentRules = normalizeRules(host.readRules())
  let instances = currentInstances
  let models = currentRules
  try {
    const parsed = Config({
      instances: proposal.instances ?? currentInstances,
      models: proposal.models ?? currentRules,
    } as never)
    instances = normalizeInstances(unwrap<InstanceConfig[]>(parsed.instances))
    models = normalizeRules(unwrap<ModelRule[]>(parsed.models))
  } catch (error) {
    errors.push(`配置不符合 schema：${error instanceof Error ? error.message : String(error)}`)
    return { errors, warnings, changes, instances, models, instancesChanged: false, modelsChanged: false }
  }

  const seen = new Set<string>()
  for (const [index, instance] of instances.entries()) {
    if (!INSTANCE_ID_PATTERN.test(instance.id)) errors.push(`instances[${index}].id "${instance.id}" 不合法：1–32 位小写字母、数字、-、_`)
    if (seen.has(instance.id)) errors.push(`instances[${index}].id "${instance.id}" 重复`)
    seen.add(instance.id)
    try {
      resolveEndpoints(instance.baseURL)
    } catch (error) {
      errors.push(`instances[${index}].baseURL：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const currentIds = new Set(currentInstances.map(instance => instance.id))
  for (const instance of instances) {
    if (!currentIds.has(instance.id)) {
      changes.push(`+ 新实例 ${routeFor(instance.id)}（${instance.baseURL}）：保存后获取目录；key 用 /cpa-key ${instance.id} 设置，凭据名 ${credentialRefFor(instance)}`)
    }
  }
  for (const instance of currentInstances) {
    if (!seen.has(instance.id)) changes.push(`- 删除实例 ${routeFor(instance.id)}（已保存的会话会找不到它的模型）`)
  }

  const { rules: compiled, issues } = compileRules(models)
  errors.push(...issues.map(issue => `规则 ${issue}`))
  const { rules: before } = compileRules(currentRules)

  const known = catalogs(host)
  const matchedRules = new Set<number>()
  for (const instance of instances) {
    const catalog = known.get(instance.id)
    const route = routeFor(instance.id)
    const old = currentInstances.find(item => item.id === instance.id)
    if (old && old.baseURL !== instance.baseURL) changes.push(`~ ${route} 地址 ${old.baseURL} → ${instance.baseURL}（保存后重新获取目录）`)
    if (old && (old.name ?? '') !== (instance.name ?? '')) changes.push(`~ ${route} 名称 ${old.name ?? '(默认)'} → ${instance.name ?? '(默认)'}`)
    if (old && (old.apiKeyEnv ?? '') !== (instance.apiKeyEnv ?? '')) changes.push(`~ ${route} 凭据名 ${credentialRefFor(old)} → ${credentialRefFor(instance)}`)
    if (!catalog) {
      if (instance.fast.length > 0) warnings.push(`${route} 还没有目录，无法检查 fast 列表`)
      continue
    }
    const ids = new Set(catalog.map(model => model.id))
    for (const id of instance.fast) {
      const model = catalog.find(item => item.id === id)
      if (!model) warnings.push(`${route} 的 fast 里有 ${id}，但目录里没有这个模型（模型 ID 要完整，包括前缀，例如 api/gpt-6-luna）`)
      else if (!model.supportsPriority) warnings.push(`${route}/${id} 的目录没有列出 priority 档位，Fast 不会生效`)
    }
    const fastBefore = new Set(old?.fast ?? [])
    const fastAfter = new Set(instance.fast.filter(id => ids.has(id)))
    for (const model of catalog) {
      for (const rule of compiled) if (ruleMatches(rule, route, model.id)) matchedRules.add(rule.index)
      const next = resolveModel(model, route, compiled)
      for (const warning of next.warnings) warnings.push(`${route}/${model.id}：${warning}`)
      if (!old) continue
      const prev = resolveModel(model, route, before)
      const a = digest(prev, fastBefore.has(model.id) && model.supportsPriority)
      const b = digest(next, fastAfter.has(model.id) && model.supportsPriority)
      if (a !== b) changes.push(`~ ${route}/${model.id}：${a} → ${b}`)
    }
  }
  if (known.size > 0) {
    for (const rule of compiled) {
      if (!matchedRules.has(rule.index)) warnings.push(`规则 models[${rule.index}]（match: ${rule.rule.match}）没有匹配到任何已知模型`)
    }
  }

  const instancesChanged = JSON.stringify(instances) !== JSON.stringify(currentInstances)
  const modelsChanged = JSON.stringify(models) !== JSON.stringify(currentRules)
  return { errors, warnings: [...new Set(warnings)], changes, instances, models, instancesChanged, modelsChanged }
}

// ---------------------------------------------------------------------------
// YAML for manual migration. Strings are JSON-quoted (valid YAML), so the
// output needs no YAML library and never misreads `no`, `1e3`, `*`, etc.

function yamlScalar(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function yamlList(items: readonly unknown[]): string {
  return `[${items.map(yamlScalar).join(', ')}]`
}

function yamlObjectItem(object: Record<string, unknown>, indent: string): string {
  const lines = Object.entries(object)
    .filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? yamlList(value) : yamlScalar(value)}`)
  if (lines.length === 0) return `${indent}- {}`
  return lines.map((line, index) => `${indent}${index === 0 ? '- ' : '  '}${line}`).join('\n')
}

/**
 * The plugin's whole `cordis.patch.yml` entry. dsh replaces an entry's
 * `config` as a whole, so the snippet carries both lists and any non-default
 * scalar settings.
 */
export function patchYaml(settingsNs: string, instances: readonly InstanceConfig[], models: readonly ModelRule[], extra: Record<string, unknown> = {}): string {
  const lines = [`- id: ${settingsNs}`, '  config:']
  lines.push(instances.length === 0 ? '    instances: []' : '    instances:')
  for (const instance of instances) lines.push(yamlObjectItem({ ...instance }, '      '))
  lines.push(models.length === 0 ? '    models: []' : '    models:')
  for (const rule of models) lines.push(yamlObjectItem({ ...rule }, '      '))
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) lines.push(`    ${key}: ${yamlScalar(value)}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Read: the current setup and what each instance's catalog offers.

export interface ReadOptions {
  /** Only this instance (`home` or `cpa-home`). */
  instance?: string
  /** Include models the catalog or a rule hides. */
  includeHidden?: boolean
}

export async function describeSetup(host: CommandHost, settingsNs: string, options: ReadOptions = {}): Promise<string> {
  const instances = normalizeInstances(host.readInstances())
  const rules = normalizeRules(host.readRules())
  const views = host.runtime.views()
  const wanted = options.instance?.replace(/^cpa-/, '')
  const lines: string[] = [
    `CPA 插件配置（cordis.patch.yml 条目 id: ${settingsNs}）：${instances.length} 个实例，${rules.length} 条模型规则`,
    '',
    '## 当前配置（YAML）',
    '```yaml',
    patchYaml(settingsNs, instances, rules),
    '```',
  ]
  if (host.runtime.configIssues.length > 0) lines.push('', `配置问题：${host.runtime.configIssues.join('；')}`)
  for (const instance of instances) {
    if (wanted !== undefined && instance.id !== wanted) continue
    const route = routeFor(instance.id)
    const view = views.get(route)
    const state = view?.state ?? host.runtime.get(instance.id)
    const key = await host.describeKey(credentialRefFor(instance)).catch(() => undefined)
    lines.push('', `## ${route}（${view?.displayName ?? instance.name ?? instance.id}）`)
    lines.push(`地址 ${instance.baseURL} · 凭据名 ${credentialRefFor(instance)} · key ${key?.configured ? '已设置' : '未设置（让用户执行 /cpa-key）'}`)
    if (state?.configError) lines.push(`地址错误：${state.configError}`)
    if (state?.lastError) lines.push(`最近一次获取目录失败：${state.lastError}`)
    if (!view || !state?.catalog) {
      lines.push('还没有模型目录。')
      continue
    }
    lines.push(`目录获取于 ${new Date(state.catalog.fetchedAt).toISOString()}。每行：模型 ID | 显示名 | CPA 提供的档位 (CPA 默认) | 生效档位 (生效默认) | 上下文 | 输入 | 能否 Fast | 规则`)
    for (const model of view.models) {
      if (model.hidden && !options.includeHidden) continue
      lines.push([
        model.id,
        model.name,
        `${levelsText(model.offeredLevels)} (${model.catalogDefault ?? '-'})`,
        `${levelsText(model.levels)} (${model.defaultLevel ?? '-'})`,
        String(model.contextWindow),
        model.input.join('+'),
        model.supportsPriority ? (view.fast.has(model.id) ? 'Fast 已开' : '可 Fast') : '不支持 Fast',
        model.matchedRules.length > 0 ? `models[${model.matchedRules.join(',')}]` : '-',
        ...model.hidden ? ['隐藏'] : [],
        ...model.warnings.length > 0 ? [`⚠ ${model.warnings.join('；')}`] : [],
      ].join(' | '))
    }
    const hidden = view.models.filter(model => model.hidden).length
    if (hidden > 0 && !options.includeHidden) lines.push(`（另有 ${hidden} 个隐藏模型，includeHidden: true 可列出）`)
  }
  return lines.join('\n')
}

export function previewText(settingsNs: string, preview: Preview): string {
  const lines: string[] = []
  const blocked = preview.errors.length > 0
  const nothing = !preview.instancesChanged && !preview.modelsChanged
  lines.push(blocked ? `✗ 方案有 ${preview.errors.length} 个错误，不能应用` : nothing ? '方案与当前配置相同' : `✓ 方案可以应用：${preview.changes.length} 处生效变化`)
  if (preview.errors.length > 0) lines.push('', '错误：', ...preview.errors.map(item => `- ${item}`))
  if (preview.warnings.length > 0) lines.push('', '提醒：', ...preview.warnings.map(item => `- ${item}`))
  if (preview.changes.length > 0) lines.push('', '变化：', ...preview.changes.map(item => `- ${item}`))
  lines.push('', `完整条目（可手动替换 profile 的 cordis.patch.yml 里 id 为 ${settingsNs} 的条目）：`, '```yaml', patchYaml(settingsNs, preview.instances, preview.models), '```')
  return lines.join('\n')
}
