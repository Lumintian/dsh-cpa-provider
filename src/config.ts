/**
 * Plugin configuration: the CPA instances this plugin serves and the ordered
 * model rules applied on top of each instance's catalog.
 *
 * Every field is volatile, so editing the profile's `cordis.patch.yml` (or a
 * `/cpa-*` command writing it) takes effect without remounting the plugin.
 * API keys never live here: each instance names a credential reference that
 * resolves through the harness credential store, then the environment.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** dsh's selectable reasoning levels, lowest to highest. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]

export const MODALITIES = ['text', 'image'] as const
export type Modality = typeof MODALITIES[number]

export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export const DEFAULT_REFRESH_INTERVAL_MINUTES = 10
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000

/** One CPA server. */
export interface InstanceConfig {
  /** Stable id; the provider route is `cpa-<id>`. Changing it orphans saved sessions and the stored key. */
  id: string
  /** Name shown as the provider group in the model picker; defaults to `CPA <id>`. */
  name?: string
  /** CPA address, e.g. `http://127.0.0.1:8317`; `/v1` is optional. */
  baseURL: string
  /** Credential reference holding this instance's API key; defaults to `CPA_<ID>_API_KEY`. */
  apiKeyEnv?: string
  /** Model ids with Fast (`service_tier: priority`) enabled. */
  fast: string[]
}

/**
 * One model rule. Rules apply in order and later ones override earlier ones
 * field by field, so general rules go first and specific ones after them.
 * Empty lists mean "not set", because the schema materializes absent arrays.
 */
export interface ModelRule {
  /**
   * Which models this rule applies to, matched against both `<model>` and
   * `cpa-<instance>/<model>`. A glob (`*` wildcard, case-insensitive, whole
   * name), or a regular expression written as `/pattern/flags`.
   */
  match: string
  /** Selectable reasoning levels; only narrows what the catalog offers. */
  efforts: ThinkingLevel[]
  /** Level preselected when switching to this model. */
  defaultEffort?: ThinkingLevel
  /** Context window in tokens. */
  contextWindow?: number
  /** Output capability in tokens (metadata; requests leave the cap to CPA). */
  maxTokens?: number
  /** Input modalities. */
  input: Modality[]
  /** `true` removes the model from this plugin's list; `false` shows a model the catalog hides. */
  hidden?: boolean
}

export interface Config {
  instances: Volatile<InstanceConfig[]>
  models: Volatile<ModelRule[]>
  /** Minutes between background catalog refreshes; 0 disables periodic refresh. */
  refreshIntervalMinutes: Volatile<number>
  /** Timeout for one catalog request. */
  fetchTimeoutMs: Volatile<number>
  /** Also list models the catalog marks hidden (image/video and internal models). */
  showHiddenModels: Volatile<boolean>
}

const Instance = z.object({
  id: z.string().pattern(INSTANCE_ID_PATTERN).required()
    .description('实例 ID：1–32 位小写字母、数字、- 或 _；provider 为 cpa-<id>'),
  name: z.string().description('模型选择器里的分组名，默认 CPA <id>'),
  baseURL: z.string().required().description('CPA 地址，例如 http://127.0.0.1:8317'),
  apiKeyEnv: z.string().pattern(CREDENTIAL_REF_PATTERN).role('credential-ref')
    .description('保存 API key 的凭据名，默认 CPA_<ID>_API_KEY'),
  fast: z.array(z.string()).default([]).description('开启 Fast 的模型 ID'),
})

const Rule = z.object({
  match: z.string().required().description('通配符（* ，不区分大小写）或 /正则/flags'),
  efforts: z.array(z.union(THINKING_LEVELS)).default([]).description('可选思考强度（只能收窄 CPA 提供的档位）'),
  defaultEffort: z.union(THINKING_LEVELS).description('切换到该模型时的默认思考强度'),
  contextWindow: z.natural().min(1).description('上下文窗口（token）'),
  maxTokens: z.natural().min(1).description('最大输出（token）'),
  input: z.array(z.union(MODALITIES)).default([]).description('输入类型'),
  hidden: z.boolean().description('true 隐藏该模型；false 显示目录隐藏的模型'),
})

/** Raw section as written in `cordis.patch.yml`, before defaults. */
export interface ConfigInput {
  instances?: Array<Partial<InstanceConfig>> | null
  models?: Array<Partial<ModelRule>> | null
  refreshIntervalMinutes?: number | null
  fetchTimeoutMs?: number | null
  showHiddenModels?: boolean | null
}

export const Config: z<ConfigInput, Config> = z.object({
  instances: z.array(Instance).default([]).volatile().description('CPA 实例'),
  models: z.array(Rule).default([]).volatile().description('模型规则：按顺序生效，后面的覆盖前面的'),
  refreshIntervalMinutes: z.number().min(0).default(DEFAULT_REFRESH_INTERVAL_MINUTES).volatile()
    .description('后台刷新模型目录的间隔（分钟），0 表示不定时刷新'),
  fetchTimeoutMs: z.natural().min(1000).default(DEFAULT_FETCH_TIMEOUT_MS).volatile()
    .description('获取模型目录的超时（毫秒）'),
  showHiddenModels: z.boolean().default(false).volatile().description('同时列出目录标记为隐藏的模型'),
})

export function routeFor(instanceId: string): string {
  return `cpa-${instanceId}`
}

export function defaultCredentialRef(instanceId: string): string {
  return `CPA_${instanceId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

export function credentialRefFor(instance: Pick<InstanceConfig, 'id' | 'apiKeyEnv'>): string {
  return instance.apiKeyEnv && instance.apiKeyEnv.length > 0 ? instance.apiKeyEnv : defaultCredentialRef(instance.id)
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
}

export function assertInstanceId(id: string): void {
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`invalid instance id "${id}": use 1-32 lowercase letters, digits, "-" or "_", starting with a letter or digit`)
  }
}
