/**
 * The `cpa_config` agent tool: read, preview, and apply plugin configuration.
 * Applying always asks the user on a card first; without a card (headless,
 * ACP) or without a settings service it writes nothing and returns the YAML
 * entry for the user to paste instead.
 */

import { AskCancelled, AskUnavailable, type Ask, single } from './ask.ts'
import { describeSetup, patchYaml, previewProposal, previewText, type Proposal } from './assistant.ts'
import type { CommandHost } from './commands.ts'

export const TOOL_NAME = 'cpa_config'

export interface ToolHost extends CommandHost {
  /** The plugin's `cordis.patch.yml` entry id. */
  settingsNs: string
  /** Whether a settings service can persist changes. */
  canWrite(): boolean
}

export interface ToolArgs {
  action: 'read' | 'preview' | 'apply'
  instance?: string
  includeHidden?: boolean
  instances?: unknown
  models?: unknown
}

const DESCRIPTION = [
  '读取、预览、应用 dsh-cpa-provider（CPA 模型提供商）的配置。使用前先加载 cpa-provider-config 技能。',
  'action=read：当前配置 YAML 和每个实例的真实模型目录（ID、CPA 档位、生效档位、能否 Fast）。',
  'action=preview：检查方案（instances/models 为整体替换的完整列表，省略的保持不变），返回错误、提醒、逐模型变化和完整 YAML。',
  'action=apply：同一方案，先弹卡片请用户确认，确认后写入并立即生效。',
  '不要在方案里放 API key。',
].join('\n')

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Raw JSON Schema for the arguments; dsh validates calls against it. */
export const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['read', 'preview', 'apply'], description: 'read | preview | apply' },
    instance: { type: 'string', description: 'read 时只看这个实例（home 或 cpa-home）' },
    includeHidden: { type: 'boolean', description: 'read 时也列出隐藏模型' },
    instances: {
      type: 'array',
      description: '完整的实例列表（整体替换）。省略则不改',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          baseURL: { type: 'string' },
          apiKeyEnv: { type: 'string' },
          fast: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'baseURL'],
      },
    },
    models: {
      type: 'array',
      description: '完整的模型规则列表（整体替换，按顺序生效）。省略则不改',
      items: {
        type: 'object',
        properties: {
          match: { type: 'string' },
          efforts: { type: 'array', items: { type: 'string', enum: LEVELS } },
          defaultEffort: { type: 'string', enum: LEVELS },
          contextWindow: { type: 'integer' },
          maxTokens: { type: 'integer' },
          input: { type: 'array', items: { type: 'string', enum: ['text', 'image'] } },
          hidden: { type: 'boolean' },
        },
        required: ['match'],
      },
    },
  },
  required: ['action'],
} as const

function proposalOf(args: ToolArgs): Proposal {
  return {
    ...args.instances === undefined ? {} : { instances: args.instances as Proposal['instances'] & object },
    ...args.models === undefined ? {} : { models: args.models as Proposal['models'] & object },
  }
}

export async function runConfigTool(host: ToolHost, args: ToolArgs, ask: Ask): Promise<string> {
  if (args.action === 'read') {
    return await describeSetup(host, host.settingsNs, {
      ...args.instance === undefined ? {} : { instance: args.instance },
      ...args.includeHidden === undefined ? {} : { includeHidden: args.includeHidden },
    })
  }
  if (args.instances === undefined && args.models === undefined) {
    return `${args.action} 需要方案：至少提供 instances 或 models 之一`
  }
  const preview = previewProposal(host, proposalOf(args))
  const text = previewText(host.settingsNs, preview)
  if (args.action === 'preview') return text
  if (args.action !== 'apply') return `未知 action ${String(args.action)}`

  if (preview.errors.length > 0) return `未应用。\n${text}`
  if (!preview.instancesChanged && !preview.modelsChanged) return '未应用：方案与当前配置相同'
  const yaml = patchYaml(host.settingsNs, preview.instances, preview.models)
  const manual = `请把下面的条目交给用户，替换 profile 的 cordis.patch.yml 里 id 为 ${host.settingsNs} 的条目：\n\`\`\`yaml\n${yaml}\n\`\`\``
  if (!host.canWrite()) return `未应用：当前组合没有设置服务，不能直接写入。\n${manual}`

  const summary = preview.changes.length > 0 ? preview.changes.slice(0, 12).join('\n') : '规则或实例字段有调整（生效结果不变）'
  const more = preview.changes.length > 12 ? `\n…另有 ${preview.changes.length - 12} 处` : ''
  let answer: string | undefined
  try {
    const answers = await ask([{
      id: 'confirm',
      header: 'CPA 配置',
      question: `应用这些修改吗？\n${summary}${more}${preview.warnings.length > 0 ? `\n提醒：${preview.warnings.slice(0, 3).join('；')}` : ''}`,
      options: [{ label: '应用', description: '写入配置，立即生效' }, { label: '取消', description: '不做修改' }],
    }])
    answer = single(answers.get('confirm'))
  } catch (error) {
    if (error instanceof AskUnavailable) return `未应用：这个界面没法请用户确认。\n${manual}`
    if (error instanceof AskCancelled) return '未应用：用户关闭了确认卡片'
    throw error
  }
  if (answer !== '应用') return `未应用：用户没有确认${answer && answer !== '取消' ? `（用户回复：${answer}）` : ''}`

  if (preview.instancesChanged) await host.writeInstances(preview.instances)
  if (preview.modelsChanged) await host.writeRules(preview.models)
  const added = preview.instances.filter(item => !host.runtime.get(item.id)?.catalog)
  return [
    `✓ 已应用 CPA 配置：${preview.changes.length} 处变化`,
    ...preview.changes.map(item => `- ${item}`),
    ...added.length > 0 ? [`新实例需要 key 时请用户执行 /cpa-key ${added[0]!.id}`] : [],
  ].join('\n')
}

/** The dsh `ToolDefinition` shape (dsh-tools ≥ 0.2.1-rc.5), kept structural so the plugin needs no runtime dependency on it. */
export function configToolDefinition(host: ToolHost, askFor: (exec: { agent?: unknown; signal: AbortSignal }) => Ask) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: TOOL_PARAMETERS as unknown as Record<string, unknown>,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    timeoutMs: 10 * 60_000,
    isConcurrencySafe: (args: unknown) => (args as ToolArgs | undefined)?.action !== 'apply',
    execute: async (args: unknown, exec: { agent?: unknown; signal: AbortSignal }) => await runConfigTool(host, args as ToolArgs, askFor(exec)),
  }
}
