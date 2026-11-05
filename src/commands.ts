/**
 * `/cpa*` slash commands for the interactive dsh UIs (Web, CLI). Every
 * command runs on the UI command plane: nothing here becomes a model message.
 *
 * Every command works without arguments: whatever is missing is asked with a
 * question card (see `ask.ts`), and arguments stay available as shortcuts.
 * Where no UI can answer cards, commands fall back to usage text.
 *
 * dsh shows a command result collapsed to its first line, so every result
 * starts with a one-line summary; details follow on later lines.
 *
 * Commands that change configuration write the plugin's own section of the
 * profile `cordis.patch.yml` through the settings service, so the result is
 * the same as editing that file by hand.
 */

import { type Ask, AskCancelled, AskUnavailable, type Choice, multiple, single } from './ask.ts'
import {
  credentialRefFor,
  defaultCredentialRef,
  type InstanceConfig,
  INSTANCE_ID_PATTERN,
  isThinkingLevel,
  type ModelRule,
  routeFor,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './config.ts'
import { resolveEndpoints } from './endpoints.ts'
import type { EffectiveModel } from './rules.ts'
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
  /** Current effective model rules. */
  readRules(): readonly ModelRule[]
  /** Persist a new rule list. */
  writeRules(next: ModelRule[]): Promise<void>
  setKey(ref: string, value: string): Promise<void>
  clearKey(ref: string): Promise<void>
  describeKey(ref: string): Promise<KeyStatus | undefined>
}

/** The route and model the session last sent a request to. */
export interface CurrentRoute {
  provider: string
  model: string
}

export interface Invocation {
  /** Text after the command name. */
  args: string
  current?: CurrentRoute
  /** Ask question cards; throws `AskUnavailable` where no UI answers them. */
  ask: Ask
}

export interface CpaCommand {
  name: string
  description: string
  hint?: string
  /** False keeps the typed input (an API key) out of the session log. */
  recordInput?: boolean
  run(invocation: Invocation): Promise<CommandResult>
}

const ok = (text: string): CommandResult => ({ kind: 'success', text })
const fail = (text: string): CommandResult => ({ kind: 'error', text })
const cancelled = (): CommandResult => ok('已取消，没有做任何修改')

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

function sortLevels(levels: Iterable<ThinkingLevel>): ThinkingLevel[] {
  const set = new Set(levels)
  return THINKING_LEVELS.filter(level => set.has(level))
}

/** Something that reads as an address rather than an instance id. */
function looksLikeAddress(token: string): boolean {
  if (!/[.:/]/.test(token) && token !== 'localhost') return false
  try {
    resolveEndpoints(token)
    return true
  } catch {
    return false
  }
}

/** A readable, unused instance id derived from an address. */
export function suggestInstanceId(baseURL: string, taken: ReadonlySet<string>): string {
  let host = ''
  try {
    host = new URL(resolveEndpoints(baseURL).root).hostname
  } catch {
    // Fall through to the generic id.
  }
  const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host)
  const label = loopback ? 'local' : /^[0-9.]+$/.test(host) ? 'lan' : host.split('.')[0] ?? ''
  const base = label.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[-_]+/, '').slice(0, 28) || 'cpa'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** One model as a card option, with the route it belongs to. */
interface ModelPick {
  view: RouteView
  model: EffectiveModel
}

/** Label models by id when one instance serves them all, else by `cpa-<id>/<model>`. */
function modelOptions(
  views: readonly RouteView[],
  filter: (view: RouteView, model: EffectiveModel) => boolean,
  current: CurrentRoute | undefined,
  describe: (view: RouteView, model: EffectiveModel) => string,
): { options: Choice[]; byLabel: Map<string, ModelPick> } {
  const qualified = views.length > 1
  const picks: Array<ModelPick & { label: string; isCurrent: boolean }> = []
  for (const view of views) {
    for (const model of view.models) {
      if (model.hidden || !filter(view, model)) continue
      picks.push({
        view,
        model,
        label: qualified ? `${view.state.route}/${model.id}` : model.id,
        isCurrent: current?.provider === view.state.route && current.model === model.id,
      })
    }
  }
  picks.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
  return {
    options: picks.map(pick => ({
      label: pick.label,
      description: [describe(pick.view, pick.model), pick.isCurrent ? '当前会话的模型' : ''].filter(Boolean).join(' · '),
    })),
    byLabel: new Map(picks.map(pick => [pick.label, { view: pick.view, model: pick.model }])),
  }
}

/**
 * Resolve `cpa-<id>/<model>`, `<id>/<model>`, or a bare model id (unique, or
 * on the current route). A CPA-prefixed id such as `api/gpt-6-luna` is itself
 * a bare model id, so a leading segment that names no instance falls through
 * to the bare lookup instead of being reported as an unknown instance.
 */
function resolveModelToken(runtime: CpaRuntime, token: string, current: CurrentRoute | undefined): ModelPick | string {
  const views = runtime.views()
  const slash = token.indexOf('/')
  const qualified = slash > 0 ? views.get(routeFor(instanceIdOf(token.slice(0, slash)))) : undefined
  const bareOwned = [...views.values()].some(view => view.models.some(model => model.id === token))
  if (slash > 0 && (qualified || !bareOwned)) {
    if (!qualified) return `没有 CPA 实例 ${token.slice(0, slash)}`
    const model = qualified.models.find(item => item.id === token.slice(slash + 1))
    if (model) return { view: qualified, model }
    if (!bareOwned) return `${qualified.state.route} 的目录里没有 ${token.slice(slash + 1)}，可以先 /cpa-refresh`
  }
  const owners = [...views.values()].filter(view => view.models.some(model => model.id === token))
  const pick = (view: RouteView): ModelPick => ({ view, model: view.models.find(model => model.id === token)! })
  if (owners.length === 0) return `没有找到模型 ${token}，可以先 /cpa-refresh`
  if (owners.length === 1 && owners[0]) return pick(owners[0])
  const onCurrent = owners.find(view => view.state.route === current?.provider)
  if (onCurrent) return pick(onCurrent)
  return `多个实例都有 ${token}，请写成 <实例>/${token}，例如 ${owners[0]?.state.route}/${token}`
}

function currentPick(runtime: CpaRuntime, current: CurrentRoute | undefined): ModelPick | undefined {
  if (!current) return undefined
  const view = runtime.views().get(current.provider)
  const model = view?.models.find(item => item.id === current.model)
  return view && model ? { view, model } : undefined
}

function pickLabel(pick: ModelPick): string {
  return `${pick.view.state.route}/${pick.model.id}`
}

export function createCommands(host: CommandHost): CpaCommand[] {
  const { runtime } = host

  const updateInstances = async (change: (instance: InstanceConfig) => InstanceConfig | undefined): Promise<void> => {
    const next = host.readInstances().flatMap((instance) => {
      const changed = change({ ...instance, fast: [...instance.fast] })
      return changed ? [changed] : []
    })
    await host.writeInstances(next)
  }

  const keyStatus = async (instance: InstanceConfig): Promise<KeyStatus | undefined> =>
    await host.describeKey(credentialRefFor(instance)).catch(() => undefined)

  const keyLine = (status: KeyStatus | undefined, instance: InstanceConfig): string => {
    const ref = credentialRefFor(instance)
    if (status === undefined) return `key: 无法检查（${ref}）`
    if (!status.configured) return `key: 未设置 → /cpa-key ${instance.id}（或设置环境变量 ${ref}）`
    return `key: 已设置${status.source ? `（${status.source}）` : ''}`
  }

  const visibleCount = (view: RouteView | undefined): number => view?.models.filter(model => !model.hidden).length ?? 0

  const issueLines = (): string[] => {
    const views = [...runtime.views().values()]
    return [
      ...runtime.configIssues,
      ...runtime.ruleIssues,
      ...views.flatMap(view => view.models
        .filter(model => !model.hidden && model.warnings.length > 0)
        .map(model => `${view.state.route}/${model.id}: ${model.warnings.join('；')}`)),
    ]
  }

  const overviewSummary = (): string => {
    const instances = host.readInstances()
    if (instances.length === 0) return '还没有 CPA 实例'
    const views = [...runtime.views().values()]
    const models = views.reduce((sum, view) => sum + visibleCount(view), 0)
    const fast = views.reduce((sum, view) => sum + view.fast.size, 0)
    const failing = runtime.list().filter(state => state.lastError || state.configError).length
    const issues = issueLines().length
    return [
      `${instances.length} 个实例`,
      `${models} 个模型`,
      fast > 0 ? `Fast ${fast} 个` : '',
      failing > 0 ? `⚠ ${failing} 个实例有错误` : '',
      issues > 0 ? `⚠ ${issues} 条规则提示` : '',
    ].filter(Boolean).join(' · ')
  }

  const describeInstance = async (instance: InstanceConfig, lines: string[]): Promise<void> => {
    const state = runtime.get(instance.id)
    const view = runtime.views().get(routeFor(instance.id))
    lines.push(`• ${routeFor(instance.id)}（${view?.displayName ?? instance.name ?? `CPA ${instance.id}`}）  ${instance.baseURL}`)
    if (state?.configError) {
      lines.push(`  ⚠ 地址有误：${state.configError}`)
      return
    }
    lines.push(`  ${keyLine(await keyStatus(instance), instance)}`)
    if (view && state?.catalog) {
      const hidden = view.models.length - visibleCount(view)
      lines.push(`  模型: ${visibleCount(view)} 个${hidden ? `（另有 ${hidden} 个隐藏）` : ''}，目录更新于 ${formatTime(state.catalog.fetchedAt)}`)
    } else {
      lines.push(`  模型: 尚未获取${state?.refreshing ? '（正在获取）' : ''}`)
    }
    if (view && view.fast.size > 0) lines.push(`  Fast: ${[...view.fast].join(', ')}`)
    const inactive = instance.fast.filter(id => !view?.fast.has(id))
    if (inactive.length > 0) lines.push(`  Fast 未生效（目录里没有或不支持 priority）: ${inactive.join(', ')}`)
    if (state?.lastError) lines.push(`  ⚠ 最近错误: ${state.lastError}`)
  }

  const overview = async (): Promise<CommandResult> => {
    const instances = host.readInstances()
    if (instances.length === 0) {
      return ok('还没有 CPA 实例 · 输入 /cpa-add 开始添加\n不带参数会逐项询问；也可以一次写全：/cpa-add http://127.0.0.1:8317 家用 CPA')
    }
    const lines = [`CPA：${overviewSummary()}`]
    for (const instance of instances) await describeInstance(instance, lines)
    const issues = issueLines()
    if (issues.length > 0) lines.push('', '提示:', ...issues.map(issue => `  ⚠ ${issue}`))
    lines.push('', '查看某个实例的模型：/cpa <实例>；更多操作：/cpa（不带参数）')
    return ok(lines.join('\n'))
  }

  const detail = async (target: string): Promise<CommandResult> => {
    const instanceId = instanceIdOf(target)
    const instance = host.readInstances().find(item => item.id === instanceId)
    if (!instance) return fail(`没有 CPA 实例 ${target} · 现有：${host.readInstances().map(item => item.id).join(', ') || '无'}`)
    const view = runtime.views().get(routeFor(instanceId))
    const status = await keyStatus(instance)
    const state = runtime.get(instanceId)
    const lines = [[
      `${routeFor(instanceId)}（${view?.displayName ?? instance.name ?? `CPA ${instanceId}`}）`,
      state?.catalog ? `${visibleCount(view)} 个模型` : '模型尚未获取',
      status?.configured ? 'key 已设置' : 'key 未设置',
      view && view.fast.size > 0 ? `Fast ${view.fast.size} 个` : '',
      state?.lastError || state?.configError ? '⚠ 有错误' : '',
    ].filter(Boolean).join(' · ')]
    await describeInstance(instance, lines)
    if (view && view.models.length > 0) {
      lines.push('', '模型（可选档位 / 默认 / 上下文 / 输入）:')
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

  /** Pick one instance: the argument, the only one, or a card. */
  const chooseInstance = async (
    token: string | undefined,
    ask: Ask,
    question: string,
  ): Promise<InstanceConfig | CommandResult> => {
    const instances = host.readInstances()
    if (instances.length === 0) return fail('还没有 CPA 实例 · 先用 /cpa-add 添加')
    if (token !== undefined) {
      const found = instances.find(item => item.id === instanceIdOf(token))
      return found ?? fail(`没有 CPA 实例 ${token} · 现有：${instances.map(item => item.id).join(', ')}`)
    }
    if (instances.length === 1 && instances[0]) return instances[0]
    const views = runtime.views()
    const answers = await ask([{
      id: 'instance',
      header: '实例',
      question,
      options: instances.map(item => ({
        label: item.id,
        description: `${views.get(routeFor(item.id))?.displayName ?? item.name ?? ''} ${item.baseURL}`.trim(),
      })),
    }])
    const chosen = single(answers.get('instance'))
    if (chosen === undefined) throw new AskCancelled()
    return instances.find(item => item.id === instanceIdOf(chosen))
      ?? fail(`没有 CPA 实例 ${chosen}`)
  }

  /** Run a command body, turning card outcomes into results. */
  const guarded = async (body: () => Promise<CommandResult>, usage: string): Promise<CommandResult> => {
    try {
      return await body()
    } catch (error) {
      if (error instanceof AskCancelled) return cancelled()
      if (error instanceof AskUnavailable) return fail(`这里不能弹出选项，请带上参数 · 用法：${usage}`)
      return fail(`出错了：${errorMessage(error)}`)
    }
  }

  const saveKeyAndRefresh = async (instance: InstanceConfig, value: string): Promise<string> => {
    const ref = credentialRefFor(instance)
    await host.setKey(ref, value)
    try {
      const outcome = await runtime.refresh(instance.id)
      return outcome.status === 'ok' ? `获取到 ${outcome.modelCount} 个模型` : '已保存'
    } catch (error) {
      return `但获取模型目录失败：${errorMessage(error)}`
    }
  }

  // -------------------------------------------------------------------------

  const commands: Record<string, CpaCommand> = {}

  commands.cpa = {
    name: 'cpa',
    description: 'CPA 总入口：不带参数弹出操作菜单；/cpa status 看总览，/cpa <实例> 看模型列表',
    hint: '[status | 实例]',
    async run({ args, current, ask }) {
      const [target] = words(args)
      if (target === 'status' || target === '状态') return await overview()
      if (target !== undefined) return await detail(target)
      const empty = host.readInstances().length === 0
      const actions: Array<{ label: string; description: string; command?: string }> = [
        { label: '查看状态', description: overviewSummary() },
        { label: '添加实例', description: '/cpa-add', command: 'cpa-add' },
        ...empty ? [] : [
          { label: '保存 API key', description: '/cpa-key', command: 'cpa-key' },
          { label: '开关 Fast', description: '/cpa-fast', command: 'cpa-fast' },
          { label: '设置模型思考强度', description: '/cpa-model', command: 'cpa-model' },
          { label: '刷新模型目录', description: '/cpa-refresh', command: 'cpa-refresh' },
          { label: '删除实例', description: '/cpa-remove', command: 'cpa-remove' },
        ],
      ]
      if (empty) actions.reverse()
      let answers
      try {
        answers = await ask([{ id: 'action', header: 'CPA', question: '要做什么？', options: actions }])
      } catch (error) {
        if (error instanceof AskUnavailable) return await overview()
        if (error instanceof AskCancelled) return cancelled()
        throw error
      }
      const answer = single(answers.get('action'))
      if (answer === undefined) return cancelled()
      const chosen = actions.find(action => action.label === answer)
      if (!chosen) {
        // Free text in the card: an instance name shows that instance.
        if (host.readInstances().some(item => item.id === instanceIdOf(answer))) return await detail(answer)
        return fail(`没有「${answer}」这个操作 · 可选：${actions.map(action => action.label).join('、')}`)
      }
      if (!chosen.command) return await overview()
      return await commands[chosen.command]!.run({ args: '', ...current ? { current } : {}, ask })
    },
  }

  commands['cpa-add'] = {
    name: 'cpa-add',
    description: '添加 CPA 实例（不带参数会逐项询问地址、名称、key）',
    hint: '[地址] [名称]',
    async run({ args, ask }) {
      const usage = '/cpa-add <地址> [名称]，例如 /cpa-add http://127.0.0.1:8317 家用 CPA'
      return await guarded(async () => {
        const parts = words(args)
        const instances = host.readInstances()
        const taken = new Set(instances.map(item => item.id))
        let id: string | undefined
        let baseURL: string | undefined
        let name: string | undefined
        // Older form: /cpa-add <id> <address> [name]
        if (parts.length >= 2 && INSTANCE_ID_PATTERN.test(parts[0]!) && !looksLikeAddress(parts[0]!) && looksLikeAddress(parts[1]!)) {
          id = parts[0]
          baseURL = parts[1]
          name = parts.slice(2).join(' ') || undefined
        } else if (parts.length > 0) {
          if (!looksLikeAddress(parts[0]!)) return fail(`「${parts[0]}」不像 CPA 地址 · 用法：${usage}`)
          baseURL = parts[0]
          name = parts.slice(1).join(' ') || undefined
        }

        let key: string | undefined
        const interactive = baseURL === undefined || parts.length < 2
        if (baseURL === undefined) {
          const answers = await ask([{
            id: 'url',
            header: '地址',
            question: 'CPA 的地址是？（只写 host:port 即可，/v1 可写可不写）',
            options: [{ label: 'http://127.0.0.1:8317', description: '本机 CPA 的默认端口' }],
          }])
          baseURL = single(answers.get('url'))
          if (baseURL === undefined) throw new AskCancelled()
        }
        try {
          resolveEndpoints(baseURL)
        } catch (error) {
          return fail(`地址不对：${errorMessage(error)} · 用法：${usage}`)
        }
        const suggested = id ?? suggestInstanceId(baseURL, taken)

        if (interactive) {
          try {
            const answers = await ask([
              ...name === undefined ? [{
                id: 'name',
                header: '名称',
                question: '在模型选择器里显示的分组名？',
                options: [{ label: '不设置', description: `显示为「CPA ${suggested}」` }],
              }] : [],
              ...id === undefined ? [{
                id: 'id',
                header: '实例 ID',
                question: '实例 ID（provider 名会是 cpa-<ID>，建好后别改）',
                options: [{ label: suggested, description: `provider 名 cpa-${suggested}` }],
              }] : [],
              {
                id: 'key',
                header: 'API key',
                question: 'CPA 的 API key？直接输入即可；它会存进 dsh 凭据存储，不写进配置文件和会话日志',
                options: [{ label: '稍后再设置', description: '之后用 /cpa-key 保存，或设置环境变量' }],
              },
            ])
            if (name === undefined) {
              const typed = single(answers.get('name'))
              name = typed === '不设置' ? undefined : typed
            }
            if (id === undefined) id = single(answers.get('id')) ?? suggested
            const typedKey = answers.get('key')?.custom?.trim()
            key = typedKey ? typedKey : undefined
          } catch (error) {
            // A UI that cannot ask still gets the instance with defaults.
            if (!(error instanceof AskUnavailable)) throw error
          }
        }
        id ??= suggested

        if (!INSTANCE_ID_PATTERN.test(id)) return fail(`实例 ID「${id}」不合法：用 1–32 位小写字母、数字、- 或 _`)
        if (taken.has(id)) return fail(`实例 ${id} 已存在 · 换一个 ID，或先 /cpa-remove ${id}`)
        const instance: InstanceConfig = { id, baseURL, ...name ? { name } : {}, fast: [] }
        try {
          await host.writeInstances([...instances, instance])
        } catch (error) {
          return fail(`保存失败：${errorMessage(error)}`)
        }
        const label = `cpa-${id}（${name ?? `CPA ${id}`}）`
        if (key) {
          let outcome: string
          try {
            outcome = await saveKeyAndRefresh(instance, key)
          } catch (error) {
            return fail(`⚠ 已添加 ${label}，但保存 key 失败：${errorMessage(error)} · 重试：/cpa-key ${id}`)
          }
          return ok(`✓ 已添加 ${label}，${outcome}\n在模型选择器的「${name ?? `CPA ${id}`}」组里选择模型。`)
        }
        const status = await keyStatus(instance)
        return ok(status?.configured
          ? `✓ 已添加 ${label}，正在获取模型目录\n稍后在模型选择器的「${name ?? `CPA ${id}`}」组里选择模型。`
          : `✓ 已添加 ${label} · 下一步：/cpa-key ${id} 保存 API key`)
      }, usage)
    },
  }

  commands['cpa-key'] = {
    name: 'cpa-key',
    description: '保存或清除 CPA 实例的 API key（存入 dsh 凭据存储，不写进配置文件，也不记入会话日志）',
    hint: '[实例] [key | --clear]',
    recordInput: false,
    async run({ args, ask }) {
      const usage = '/cpa-key <实例> <key>，或 /cpa-key <实例> --clear'
      return await guarded(async () => {
        const parts = words(args)
        const instances = host.readInstances()
        let instanceToken: string | undefined
        let value: string | undefined
        if (parts.length >= 2) {
          instanceToken = parts[0]
          value = parts[1]
        } else if (parts.length === 1) {
          if (instances.some(item => item.id === instanceIdOf(parts[0]!))) instanceToken = parts[0]
          else if (instances.length === 1) value = parts[0]
          else return fail(`没有 CPA 实例 ${parts[0]} · 用法：${usage}`)
        }
        const chosen = await chooseInstance(instanceToken, ask, '要给哪个实例保存 key？')
        if ('kind' in chosen) return chosen
        const instance = chosen
        const ref = credentialRefFor(instance)
        if (value === undefined) {
          const status = await keyStatus(instance)
          const answers = await ask([{
            id: 'key',
            header: 'API key',
            question: `cpa-${instance.id} 的 API key？直接输入即可；不写进配置文件和会话日志${status?.configured ? '（已经设置过，输入新的会覆盖）' : ''}`,
            options: status?.configured ? [{ label: '清除已保存的 key', description: ref }] : [],
          }])
          const answer = answers.get('key')
          if (answer?.custom?.trim()) value = answer.custom.trim()
          else if (answer?.selected.includes('清除已保存的 key')) value = '--clear'
          else throw new AskCancelled()
        }
        if (value === '--clear') {
          await host.clearKey(ref)
          return ok(`✓ 已清除 cpa-${instance.id} 的 key（${ref}）`)
        }
        const outcome = await saveKeyAndRefresh(instance, value)
        return outcome.startsWith('但')
          ? fail(`⚠ 已保存 cpa-${instance.id} 的 key（${ref}），${outcome}`)
          : ok(`✓ 已保存 cpa-${instance.id} 的 key（${ref}），${outcome}`)
      }, usage)
    },
  }

  const applyFast = async (changes: ReadonlyMap<string, ReadonlyMap<string, boolean>>): Promise<void> => {
    await updateInstances((instance) => {
      const wanted = changes.get(instance.id)
      if (!wanted) return instance
      const fast = new Set(instance.fast)
      for (const [modelId, on] of wanted) {
        if (on) fast.add(modelId)
        else fast.delete(modelId)
      }
      return { ...instance, fast: [...fast] }
    })
  }

  const fastResult = (turnedOn: string[], turnedOff: string[]): CommandResult => {
    const parts = [
      turnedOn.length > 0 ? `已开启 ${turnedOn.join(', ')}` : '',
      turnedOff.length > 0 ? `已关闭 ${turnedOff.join(', ')}` : '',
    ].filter(Boolean)
    if (parts.length === 0) return ok('没有改动 Fast')
    const lines = [`✓ Fast：${parts.join('；')}（下一次请求生效）`]
    if (turnedOn.length > 0) lines.push('订阅账号会更快消耗额度；官方 API key 按 priority 单价计费。')
    return ok(lines.join('\n'))
  }

  commands['cpa-fast'] = {
    name: 'cpa-fast',
    description: '开关模型的 Fast（priority 服务档）；不带参数弹出可开 Fast 的模型列表',
    hint: '[on|off|status] [实例/模型]',
    async run({ args, current, ask }) {
      const parts = words(args)
      const mode = parts[0] === 'on' || parts[0] === 'off' || parts[0] === 'status' || parts[0] === 'toggle' ? parts.shift() : undefined
      const views = [...runtime.views().values()]

      if (mode === 'status' && parts.length === 0) {
        const lines = views.flatMap(view => [...view.fast].map(id => `  ${view.state.route}/${id}`))
        return ok(lines.length > 0 ? `已开启 Fast 的模型：${lines.length} 个\n${lines.join('\n')}` : '没有开启 Fast 的模型')
      }

      let pick: ModelPick | undefined
      if (parts[0] !== undefined) {
        const resolved = resolveModelToken(runtime, parts[0], current)
        if (typeof resolved === 'string') return fail(resolved)
        pick = resolved
      } else if (mode !== undefined) {
        pick = currentPick(runtime, current)
        if (!pick) return fail('当前会话的模型不是 CPA 模型 · 写明模型，例如 /cpa-fast on cpa-home/gpt-5.5，或不带参数从列表里选')
      }

      if (pick === undefined) {
        // No target: offer every Fast-capable model as a toggle list.
        const { options, byLabel } = modelOptions(views, (_view, model) => model.supportsPriority, current,
          (view, model) => (view.fast.has(model.id) ? '当前：已开启' : '当前：未开启'))
        if (options.length === 0) {
          return ok('没有可以开启 Fast 的模型 · CPA 只给全部渠道都是 codex（订阅或 codex 下的官方 key）的模型提供 priority 档位')
        }
        let answers
        try {
          answers = await ask([{
            id: 'models',
            header: 'Fast',
            question: '勾选要切换 Fast 的模型（已开启的会关闭，未开启的会开启）',
            options,
            multiSelect: true,
          }])
        } catch (error) {
          if (error instanceof AskCancelled) return cancelled()
          if (!(error instanceof AskUnavailable)) return fail(`出错了：${errorMessage(error)}`)
          // Without cards: toggle the session's current model, as before.
          pick = currentPick(runtime, current)
          if (!pick) return fail('这里不能弹出选项 · 用法：/cpa-fast on|off <实例/模型>')
          answers = undefined
        }
        if (answers !== undefined) {
          const chosen = multiple(answers.get('models')).flatMap(label => byLabel.get(label) ?? [])
          if (chosen.length === 0) return cancelled()
          const changes = new Map<string, Map<string, boolean>>()
          const on: string[] = []
          const off: string[] = []
          for (const item of chosen) {
            const enable = !item.view.fast.has(item.model.id)
            const perInstance = changes.get(item.view.state.config.id) ?? new Map<string, boolean>()
            perInstance.set(item.model.id, enable)
            changes.set(item.view.state.config.id, perInstance)
            ;(enable ? on : off).push(pickLabel(item))
          }
          try {
            await applyFast(changes)
          } catch (error) {
            return fail(`保存失败：${errorMessage(error)}`)
          }
          return fastResult(on, off)
        }
      }

      const { view, model } = pick!
      const label = `${view.state.route}/${model.id}`
      const enabled = view.fast.has(model.id)
      if (mode === 'status') return ok(`${label}：Fast ${enabled ? '已开启' : '未开启'}${model.supportsPriority ? '' : '（该模型不支持）'}`)
      const want = mode === 'on' ? true : mode === 'off' ? false : !enabled
      if (want && !model.supportsPriority) {
        return fail(`${label} 在 CPA 目录里没有 priority 档位，不能开启 Fast（通常只有纯 codex 渠道的模型支持）`)
      }
      if (want === enabled && view.state.config.fast.includes(model.id) === want) {
        return ok(`${label}：Fast 已经是${want ? '开启' : '关闭'}状态`)
      }
      try {
        await applyFast(new Map([[view.state.config.id, new Map([[model.id, want]])]]))
      } catch (error) {
        return fail(`保存失败：${errorMessage(error)}`)
      }
      return fastResult(want ? [label] : [], want ? [] : [label])
    },
  }

  const RESET_LABEL = '恢复默认'

  commands['cpa-model'] = {
    name: 'cpa-model',
    description: '设置单个模型的可选思考强度和默认强度（弹出选项，写入配置文件的模型规则）',
    hint: '[实例/模型]',
    async run({ args, current, ask }) {
      const usage = '/cpa-model <实例/模型>（需要能弹出选项的界面；也可以直接编辑配置文件的 models 规则）'
      return await guarded(async () => {
        const [token] = words(args)
        let pick: ModelPick | undefined
        if (token !== undefined) {
          const resolved = resolveModelToken(runtime, token, current)
          if (typeof resolved === 'string') return fail(resolved)
          pick = resolved
        } else {
          const views = [...runtime.views().values()]
          const { options, byLabel } = modelOptions(views, (_view, model) => model.offeredLevels.length > 0, current,
            (_view, model) => `可选 ${model.levels.join(',') || '无'} · 默认 ${model.defaultLevel ?? '-'}`)
          if (options.length === 0) return fail('没有可以设置思考强度的 CPA 模型 · 先 /cpa-add 添加实例，或 /cpa-refresh 刷新目录')
          const answers = await ask([{ id: 'model', header: '模型', question: '要设置哪个模型？', options }])
          const chosen = single(answers.get('model'))
          if (chosen === undefined) throw new AskCancelled()
          pick = byLabel.get(chosen) ?? (() => {
            const resolved = resolveModelToken(runtime, chosen, current)
            return typeof resolved === 'string' ? undefined : resolved
          })()
          if (!pick) return fail(`没有找到模型 ${chosen}`)
        }

        const { view, model } = pick
        const label = pickLabel(pick)
        if (model.offeredLevels.length === 0) return fail(`${label} 在 CPA 目录里没有思考档位，不能设置思考强度`)
        const answers = await ask([
          {
            id: 'efforts',
            header: '可选档位',
            question: `${label} 在选择器里提供哪些思考强度？（不勾选表示不改）`,
            multiSelect: true,
            options: [
              ...model.offeredLevels.map(level => ({ label: level, ...model.levels.includes(level) ? { description: '当前可选' } : {} })),
              { label: RESET_LABEL, description: '删除为这个模型单独设置的规则' },
            ],
          },
          {
            id: 'default',
            header: '默认档位',
            question: '切换到这个模型时默认用哪一档？（跳过表示不改）',
            options: model.offeredLevels.map(level => ({
              label: level,
              description: [level === model.defaultLevel ? '当前默认' : '', level === model.catalogDefault ? 'CPA 默认' : ''].filter(Boolean).join(' · '),
            })),
          },
        ])
        const match = `${view.state.route}/${model.id}`
        const rules = host.readRules()
        const existing = rules.find(rule => rule.match === match)
        const others = rules.filter(rule => rule.match !== match)
        const picked = multiple(answers.get('efforts'))
        if (picked.includes(RESET_LABEL)) {
          if (!existing) return ok(`${label} 没有单独设置过规则，无需恢复`)
          await host.writeRules(others)
          return ok(`✓ 已恢复 ${label} 的默认设置（删除了它的单独规则；通配规则仍然生效）`)
        }
        let efforts = sortLevels(picked.filter(isThinkingLevel).filter(level => model.offeredLevels.includes(level)))
        const chosenDefault = single(answers.get('default'))
        const defaultEffort = chosenDefault !== undefined && isThinkingLevel(chosenDefault) && model.offeredLevels.includes(chosenDefault)
          ? chosenDefault
          : undefined
        if (efforts.length === 0 && defaultEffort === undefined) return cancelled()
        const notes: string[] = []
        const finalEfforts = efforts.length > 0 ? efforts : model.levels
        if (defaultEffort !== undefined && !finalEfforts.includes(defaultEffort)) {
          efforts = sortLevels([...finalEfforts, defaultEffort])
          notes.push(`默认档位 ${defaultEffort} 不在可选档位里，已把它加进去`)
        }
        const rule: ModelRule = {
          ...existing,
          match,
          efforts: efforts.length > 0 ? efforts : existing?.efforts ?? [],
          input: existing?.input ?? [],
          ...defaultEffort !== undefined ? { defaultEffort } : {},
        }
        // Last in the list so it wins over every pattern rule.
        try {
          await host.writeRules([...others, rule])
        } catch (error) {
          return fail(`保存失败：${errorMessage(error)}`)
        }
        const shownEfforts = rule.efforts.length > 0 ? rule.efforts : model.levels
        const lines = [`✓ ${label}：可选 ${shownEfforts.join(', ')} · 默认 ${rule.defaultEffort ?? model.defaultLevel ?? '-'}`]
        lines.push(...notes, '已写入配置文件的 models 规则，在模型选择器里切换到该模型时生效。')
        return ok(lines.join('\n'))
      }, usage)
    },
  }

  commands['cpa-refresh'] = {
    name: 'cpa-refresh',
    description: '重新获取 CPA 模型目录；不写实例时刷新全部',
    hint: '[实例]',
    async run({ args }) {
      const [target] = words(args)
      const ids = target ? [instanceIdOf(target)] : runtime.list().map(state => state.config.id)
      if (ids.length === 0) return fail('还没有 CPA 实例 · 先用 /cpa-add 添加')
      const lines: string[] = []
      let failed = 0
      let total = 0
      for (const id of ids) {
        try {
          const outcome = await runtime.refresh(id)
          if (outcome.status === 'ok') {
            total += outcome.modelCount
            lines.push(`  cpa-${id}: ${outcome.modelCount} 个模型`)
          } else if (outcome.status === 'no-key') {
            failed++
            lines.push(`  cpa-${id}: 没有 API key → /cpa-key ${id}`)
          } else {
            lines.push(`  cpa-${id}: 已被更新的刷新取代`)
          }
        } catch (error) {
          failed++
          lines.push(`  cpa-${id}: 失败 — ${errorMessage(error)}`)
        }
      }
      const head = failed === 0
        ? `✓ 已刷新 ${ids.length} 个实例，共 ${total} 个模型`
        : `⚠ ${failed} 个实例刷新失败（共 ${ids.length} 个）`
      return failed === 0 ? ok([head, ...lines].join('\n')) : fail([head, ...lines].join('\n'))
    },
  }

  commands['cpa-remove'] = {
    name: 'cpa-remove',
    description: '删除 CPA 实例，并清除它的模型缓存和默认凭据（不带参数会让你选择并确认）',
    hint: '[实例]',
    async run({ args, ask }) {
      const usage = '/cpa-remove <实例>'
      return await guarded(async () => {
        const [target] = words(args)
        const instances = host.readInstances()
        if (instances.length === 0) return fail('还没有 CPA 实例')
        let instance: InstanceConfig | undefined
        if (target !== undefined) {
          instance = instances.find(item => item.id === instanceIdOf(target))
          if (!instance) return fail(`没有 CPA 实例 ${target} · 现有：${instances.map(item => item.id).join(', ')}`)
        } else {
          const views = runtime.views()
          const answers = await ask([
            ...instances.length > 1 ? [{
              id: 'instance',
              header: '实例',
              question: '要删除哪个实例？',
              options: instances.map(item => ({
                label: item.id,
                description: `${views.get(routeFor(item.id))?.displayName ?? item.name ?? ''} ${item.baseURL}`.trim(),
              })),
            }] : [],
            {
              id: 'confirm',
              header: '确认',
              question: instances.length > 1
                ? '确认删除？会同时清除它的模型缓存和默认凭据'
                : `确认删除 cpa-${instances[0]!.id}？会同时清除它的模型缓存和默认凭据`,
              options: [{ label: '删除' }, { label: '取消' }],
            },
          ])
          if (single(answers.get('confirm')) !== '删除') return cancelled()
          const chosen = instances.length > 1 ? single(answers.get('instance')) : instances[0]!.id
          instance = instances.find(item => item.id === chosen)
          if (!instance) return cancelled()
        }
        const removed = instance
        try {
          await host.writeInstances(instances.filter(item => item.id !== removed.id))
        } catch (error) {
          return fail(`保存失败：${errorMessage(error)}`)
        }
        runtime.deleteCache(removed.id)
        const ref = credentialRefFor(removed)
        // A custom reference may be shared with something else; only the
        // plugin's own default name is ours to delete.
        if (ref === defaultCredentialRef(removed.id)) await host.clearKey(ref).catch(() => undefined)
        return ok(`✓ 已删除 cpa-${removed.id}`)
      }, usage)
    },
  }

  return Object.values(commands)
}
