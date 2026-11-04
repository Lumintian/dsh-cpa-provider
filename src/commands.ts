/**
 * `/cpa*` slash commands for the interactive dsh UIs (Web, CLI). Every
 * command runs on the UI command plane: nothing here becomes a model message.
 *
 * Commands that change configuration write the plugin's own section of the
 * profile `cordis.patch.yml` through the settings service, so the result is
 * the same as editing that file by hand.
 */

import {
  assertInstanceId,
  credentialRefFor,
  defaultCredentialRef,
  type InstanceConfig,
  routeFor,
} from './config.ts'
import { resolveEndpoints } from './endpoints.ts'
import type { CpaRuntime, RouteView } from './runtime.ts'

export type CommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string }

export interface KeyStatus {
  configured: boolean
  source?: string
}

/** Everything the commands touch outside the runtime, injectable for tests. */
export interface CommandHost {
  runtime: CpaRuntime
  /** Current effective instance list. */
  readInstances(): readonly InstanceConfig[]
  /** Persist a new instance list; throws with a user-facing reason when the profile is not writable. */
  writeInstances(next: InstanceConfig[]): Promise<void>
  setKey(ref: string, value: string): Promise<void>
  clearKey(ref: string): Promise<void>
  describeKey(ref: string): Promise<KeyStatus | undefined>
}

export interface CpaCommand {
  name: string
  description: string
  hint?: string
  /** False keeps the typed input (an API key) out of the session log. */
  recordInput?: boolean
  run(rawInput: string, currentRoute: CurrentRoute | undefined): Promise<CommandResult>
}

/** The route and model the session last sent a request to. */
export interface CurrentRoute {
  provider: string
  model: string
}

const ok = (text: string): CommandResult => ({ kind: 'success', text })
const fail = (text: string): CommandResult => ({ kind: 'error', text })

function words(rawInput: string): string[] {
  return rawInput.trim().split(/\s+/).filter(Boolean)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function instanceIdOf(token: string): string {
  return token.startsWith('cpa-') ? token.slice('cpa-'.length) : token
}

type FastMode = 'on' | 'off' | 'toggle' | 'status'

function isFastMode(value: string | undefined): value is FastMode {
  return value === 'on' || value === 'off' || value === 'toggle' || value === 'status'
}

interface FastTarget {
  view: RouteView
  modelId: string
}

/** Resolve `cpa-<id>/<model>`, `<id>/<model>`, or a bare model id (unique, or on the current route). */
function resolveFastTarget(runtime: CpaRuntime, token: string | undefined, current: CurrentRoute | undefined): FastTarget | string {
  const views = runtime.views()
  if (token === undefined) {
    if (!current) return '当前会话还没有发过请求，无法确定是哪个模型。请写明模型，例如 /cpa-fast on cpa-home/gpt-5.5'
    const view = views.get(current.provider)
    if (!view) return `当前模型 ${current.provider}/${current.model} 不属于 CPA 实例`
    return { view, modelId: current.model }
  }
  const slash = token.indexOf('/')
  if (slash > 0) {
    const route = routeFor(instanceIdOf(token.slice(0, slash)))
    const view = views.get(route)
    if (!view) return `没有 CPA 实例 ${token.slice(0, slash)}`
    return { view, modelId: token.slice(slash + 1) }
  }
  const owners = [...views.values()].filter(view => view.models.some(model => model.id === token))
  if (owners.length === 0) return `没有找到模型 ${token}`
  if (owners.length === 1 && owners[0]) return { view: owners[0], modelId: token }
  const onCurrent = owners.find(view => view.state.route === current?.provider)
  if (onCurrent) return { view: onCurrent, modelId: token }
  return `多个实例都有 ${token}，请写成 <实例>/${token}，例如 ${owners[0]?.state.route}/${token}`
}

export function createCommands(host: CommandHost): CpaCommand[] {
  const { runtime } = host

  const updateInstance = async (instanceId: string, change: (instance: InstanceConfig) => InstanceConfig): Promise<void> => {
    const instances = host.readInstances()
    const index = instances.findIndex(instance => instance.id === instanceId)
    if (index < 0) throw new Error(`没有 CPA 实例 ${instanceId}`)
    const next = instances.map((instance, i) => (i === index ? change({ ...instance, fast: [...instance.fast] }) : instance))
    await host.writeInstances(next)
  }

  const keyLine = async (ref: string, instanceId: string): Promise<string> => {
    const status = await host.describeKey(ref).catch(() => undefined)
    if (status === undefined) return `key: 无法检查（${ref}）`
    if (!status.configured) return `key: 未设置 → /cpa-key ${instanceId} <key>（或设置环境变量 ${ref}）`
    return `key: 已设置${status.source ? `（${status.source}）` : ''}`
  }

  const describeInstance = async (view: RouteView | undefined, instance: InstanceConfig): Promise<string[]> => {
    const state = runtime.get(instance.id)
    const route = routeFor(instance.id)
    const lines = [`• ${route}  ${view?.displayName ?? instance.name ?? ''}  ${instance.baseURL}`.trimEnd()]
    if (state?.configError) {
      lines.push(`  配置错误: ${state.configError}`)
      return lines
    }
    lines.push(`  ${await keyLine(credentialRefFor(instance), instance.id)}`)
    if (view && state?.catalog) {
      const hidden = view.models.filter(model => model.hidden).length
      lines.push(`  模型: ${view.models.length - hidden} 个${hidden ? `（另有 ${hidden} 个隐藏）` : ''}，目录更新于 ${formatTime(state.catalog.fetchedAt)}`)
    } else {
      lines.push(`  模型: 尚未获取${state?.refreshing ? '（正在获取）' : ''}`)
    }
    if (view && view.fast.size > 0) lines.push(`  Fast: ${[...view.fast].join(', ')}`)
    const inactive = instance.fast.filter(id => !view?.fast.has(id))
    if (inactive.length > 0) lines.push(`  Fast 未生效（目录里没有或不支持 priority）: ${inactive.join(', ')}`)
    if (state?.lastError) lines.push(`  最近错误: ${state.lastError}`)
    return lines
  }

  const status: CpaCommand = {
    name: 'cpa',
    description: '查看 CPA 实例、模型、Fast 与规则状态；/cpa <实例> 查看每个模型',
    hint: '[实例]',
    async run(rawInput) {
      const [target] = words(rawInput)
      const instances = host.readInstances()
      const views = runtime.views()
      if (target) {
        const instanceId = instanceIdOf(target)
        const instance = instances.find(item => item.id === instanceId)
        if (!instance) return fail(`没有 CPA 实例 ${target}`)
        const view = views.get(routeFor(instanceId))
        const lines = await describeInstance(view, instance)
        if (view) {
          lines.push('', '模型（思考档位 / 默认 / 上下文 / 输入）:')
          for (const model of view.models) {
            const levels = model.levels.length > 0 ? model.levels.join(',') : '无'
            const flags = [
              model.hidden ? '隐藏' : '',
              view.fast.has(model.id) ? 'Fast' : model.supportsPriority ? '可开Fast' : '',
            ].filter(Boolean).join(' ')
            lines.push(`  ${model.id}  [${levels}] / ${model.defaultLevel ?? '-'} / ${formatTokens(model.contextWindow)} / ${model.input.join('+')}${flags ? `  ${flags}` : ''}`)
            for (const warning of model.warnings) lines.push(`    ⚠ ${warning}`)
          }
        }
        return ok(lines.join('\n'))
      }
      if (instances.length === 0) {
        return ok('还没有 CPA 实例。用 /cpa-add <实例ID> <地址> [名称] 添加，例如：\n/cpa-add home http://127.0.0.1:8317 家用 CPA')
      }
      const lines = ['CPA 实例:']
      for (const instance of instances) lines.push(...await describeInstance(views.get(routeFor(instance.id)), instance))
      const issues = [...runtime.configIssues, ...runtime.ruleIssues]
      if (issues.length > 0) lines.push('', '配置问题:', ...issues.map(issue => `  ⚠ ${issue}`))
      const warned = [...views.values()].flatMap(view => view.models
        .filter(model => !model.hidden && model.warnings.length > 0)
        .map(model => `  ⚠ ${view.state.route}/${model.id}: ${model.warnings.join('；')}`))
      if (warned.length > 0) lines.push('', '规则提示:', ...warned)
      return ok(lines.join('\n'))
    },
  }

  const refresh: CpaCommand = {
    name: 'cpa-refresh',
    description: '重新获取 CPA 模型目录；省略实例时刷新全部',
    hint: '[实例]',
    async run(rawInput) {
      const [target] = words(rawInput)
      const ids = target ? [instanceIdOf(target)] : runtime.list().map(state => state.config.id)
      if (ids.length === 0) return fail('还没有 CPA 实例，先用 /cpa-add 添加')
      const lines: string[] = []
      let failed = false
      for (const id of ids) {
        try {
          const outcome = await runtime.refresh(id)
          if (outcome.status === 'ok') lines.push(`${routeFor(id)}: 已获取 ${outcome.modelCount} 个模型`)
          else if (outcome.status === 'no-key') {
            failed = true
            lines.push(`${routeFor(id)}: 没有 API key，先运行 /cpa-key ${id} <key>`)
          } else lines.push(`${routeFor(id)}: 已被更新的刷新取代`)
        } catch (error) {
          failed = true
          lines.push(`${routeFor(id)}: 失败 — ${errorMessage(error)}`)
        }
      }
      return failed ? fail(lines.join('\n')) : ok(lines.join('\n'))
    },
  }

  const fast: CpaCommand = {
    name: 'cpa-fast',
    description: '开关模型的 Fast（priority 服务档）；不写模型时作用于当前会话的模型',
    hint: '[on|off|status] [实例/模型]',
    async run(rawInput, current) {
      const args = words(rawInput)
      let mode: FastMode = 'toggle'
      if (isFastMode(args[0])) {
        mode = args[0]
        args.shift()
      }
      if (mode === 'status' && args.length === 0) {
        const lines = [...runtime.views().values()].flatMap(view =>
          [...view.fast].map(id => `  ${view.state.route}/${id}`))
        return ok(lines.length > 0 ? `已开启 Fast:\n${lines.join('\n')}` : '没有开启 Fast 的模型')
      }
      const target = resolveFastTarget(runtime, args[0], current)
      if (typeof target === 'string') return fail(target)
      const { view, modelId } = target
      const label = `${view.state.route}/${modelId}`
      const model = view.models.find(item => item.id === modelId)
      if (!model) return fail(`${view.state.route} 的目录里没有 ${modelId}，可以先 /cpa-refresh`)
      const enabled = view.fast.has(modelId)
      if (mode === 'status') return ok(`${label}: Fast ${enabled ? '已开启' : '未开启'}${model.supportsPriority ? '' : '（该模型不支持）'}`)
      const want = mode === 'toggle' ? !enabled : mode === 'on'
      if (want && !model.supportsPriority) {
        return fail(`${label} 在 CPA 目录里没有 priority 档位，不能开启 Fast（通常只有纯 Codex 渠道的模型支持）`)
      }
      if (want === enabled && view.state.config.fast.includes(modelId) === want) {
        return ok(`${label}: Fast 已经是${want ? '开启' : '关闭'}状态`)
      }
      try {
        await updateInstance(view.state.config.id, instance => ({
          ...instance,
          fast: want
            ? [...new Set([...instance.fast, modelId])]
            : instance.fast.filter(id => id !== modelId),
        }))
      } catch (error) {
        return fail(`保存失败：${errorMessage(error)}`)
      }
      return ok(want
        ? `${label}: 已开启 Fast，下一次请求生效。\n订阅账号会更快消耗额度；官方 API key 按 priority 单价计费。`
        : `${label}: 已关闭 Fast，下一次请求生效。`)
    },
  }

  const key: CpaCommand = {
    name: 'cpa-key',
    description: '保存或清除 CPA 实例的 API key（存入 dsh 凭据存储，不写进配置文件，也不记入会话日志）',
    hint: '<实例> <key> | <实例> --clear',
    recordInput: false,
    async run(rawInput) {
      const [target, value, ...rest] = words(rawInput)
      if (!target || !value || rest.length > 0) return fail('用法：/cpa-key <实例> <key>，或 /cpa-key <实例> --clear')
      const instanceId = instanceIdOf(target)
      const instance = host.readInstances().find(item => item.id === instanceId)
      if (!instance) return fail(`没有 CPA 实例 ${target}，先用 /cpa-add 添加`)
      const ref = credentialRefFor(instance)
      try {
        if (value === '--clear') {
          await host.clearKey(ref)
          return ok(`已清除 ${routeFor(instanceId)} 的 key（${ref}）`)
        }
        await host.setKey(ref, value)
      } catch (error) {
        return fail(`保存 key 失败：${errorMessage(error)}`)
      }
      try {
        const outcome = await runtime.refresh(instanceId)
        if (outcome.status === 'ok') return ok(`已保存 key（${ref}），获取到 ${outcome.modelCount} 个模型`)
        return ok(`已保存 key（${ref}）`)
      } catch (error) {
        return fail(`已保存 key（${ref}），但获取模型目录失败：${errorMessage(error)}`)
      }
    },
  }

  const add: CpaCommand = {
    name: 'cpa-add',
    description: '添加 CPA 实例',
    hint: '<实例ID> <地址> [名称]',
    async run(rawInput) {
      const [id, baseURL, ...nameParts] = words(rawInput)
      if (!id || !baseURL) return fail('用法：/cpa-add <实例ID> <地址> [名称]，例如 /cpa-add home http://127.0.0.1:8317 家用 CPA')
      try {
        assertInstanceId(id)
        resolveEndpoints(baseURL)
      } catch (error) {
        return fail(errorMessage(error))
      }
      const instances = host.readInstances()
      if (instances.some(instance => instance.id === id)) return fail(`实例 ${id} 已存在`)
      const name = nameParts.join(' ')
      try {
        await host.writeInstances([...instances, { id, baseURL, ...name ? { name } : {}, fast: [] }])
      } catch (error) {
        return fail(`保存失败：${errorMessage(error)}`)
      }
      const ref = defaultCredentialRef(id)
      const status = await host.describeKey(ref).catch(() => undefined)
      return ok(status?.configured
        ? `已添加 ${routeFor(id)}，正在获取模型目录。`
        : `已添加 ${routeFor(id)}。下一步：/cpa-key ${id} <你的 CPA API key>`)
    },
  }

  const remove: CpaCommand = {
    name: 'cpa-remove',
    description: '删除 CPA 实例，并清除它的模型缓存和默认凭据',
    hint: '<实例>',
    async run(rawInput) {
      const [target] = words(rawInput)
      if (!target) return fail('用法：/cpa-remove <实例>')
      const instanceId = instanceIdOf(target)
      const instances = host.readInstances()
      const instance = instances.find(item => item.id === instanceId)
      if (!instance) return fail(`没有 CPA 实例 ${target}`)
      try {
        await host.writeInstances(instances.filter(item => item.id !== instanceId))
      } catch (error) {
        return fail(`保存失败：${errorMessage(error)}`)
      }
      runtime.deleteCache(instanceId)
      const ref = credentialRefFor(instance)
      // A custom reference may be shared with something else; only the
      // plugin's own default name is ours to delete.
      if (ref === defaultCredentialRef(instanceId)) await host.clearKey(ref).catch(() => undefined)
      return ok(`已删除 ${routeFor(instanceId)}`)
    },
  }

  return [status, refresh, fast, key, add, remove]
}
