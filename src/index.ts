/**
 * DeepSeek Harness provider plugin for CLIProxyAPI (CPA).
 *
 * Each configured CPA instance becomes a provider route `cpa-<id>` whose
 * models come from the instance's own `/v1/models?client_version=…` catalog,
 * reshaped by the ordered `models` rules, with per-model Fast.
 *
 * ```yaml
 * - id: cpa-provider
 *   config:
 *     instances:
 *       - id: home
 *         name: 家用 CPA
 *         baseURL: http://127.0.0.1:8317
 *         fast: [gpt-5.5]
 *     models:
 *       - match: 'gpt-*'
 *         efforts: [low, medium, xhigh, max]
 *         defaultEffort: xhigh
 *       - match: gpt-6-luna
 *         efforts: [low, max]
 *         defaultEffort: low
 * ```
 *
 * @module @lumintian/dsh-cpa-provider
 */

import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-questions'

import type { Context, VolatileSnapshot } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { AuthContext, CredentialStore } from '@earendil-works/pi-ai'
import { CpaAdapter } from './adapter.ts'
import { askVia } from './ask.ts'
import { type CommandHost, createCommands, type CurrentRoute } from './commands.ts'
import { Config, type InstanceConfig, type ModelRule } from './config.ts'
import { CpaRuntime, type RuntimeSettings, STARTUP_CACHE_FRESH_MS } from './runtime.ts'

export { Config } from './config.ts'
export type { InstanceConfig, ModelRule, ThinkingLevel } from './config.ts'

export const name = 'dsh-cpa-provider'
export const inject = ['llm']

/**
 * pi-ai collections need a credential store and an ambient context. CPA keys
 * are resolved by this plugin and passed per request, so pi-ai must neither
 * remember credentials nor discover ambient ones (an unrelated
 * `OPENAI_API_KEY` must never reach a CPA server).
 */
const NO_STORED_CREDENTIALS: CredentialStore = {
  read: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  modify: () => Promise.resolve(undefined),
  delete: () => Promise.resolve(),
}
const NO_AMBIENT_AUTH: AuthContext = {
  env: () => Promise.resolve(undefined),
  fileExists: () => Promise.resolve(false),
}

function plainInstances(value: VolatileSnapshot<InstanceConfig[]> | undefined): InstanceConfig[] {
  return (value ?? []).map(instance => ({
    id: instance.id,
    ...instance.name === undefined ? {} : { name: instance.name },
    baseURL: instance.baseURL,
    ...instance.apiKeyEnv === undefined ? {} : { apiKeyEnv: instance.apiKeyEnv },
    fast: [...instance.fast ?? []],
  }))
}

function plainRules(value: VolatileSnapshot<ModelRule[]> | undefined): ModelRule[] {
  return (value ?? []).map(rule => ({ ...rule, efforts: [...rule.efforts ?? []], input: [...rule.input ?? []] }))
}

export function apply(ctx: Context, config: Config): void {
  const settingsNs = ctx.fiber.entry?.options.id ?? name

  const readSettings = (): RuntimeSettings => ({
    instances: plainInstances(config.instances.get()),
    rules: plainRules(config.models.get()),
    showHidden: config.showHiddenModels.get() === true,
    fetchTimeoutMs: config.fetchTimeoutMs.get(),
  })

  const resolveKey = async (ref: string): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    const value = credentials !== undefined
      ? (await credentials.resolve(credentialRef(ref)))?.value
      // Without the credential seam the launch environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    return value !== undefined && value.length > 0 ? value : undefined
  }

  const runtime = new CpaRuntime({
    cacheDir: dshCachePath('dsh-cpa-provider'),
    resolveKey,
    logger: { warn: message => ctx.logger.warn(message), info: message => ctx.logger.info(message) },
  })
  runtime.applySettings(readSettings())

  const adapter = new CpaAdapter({
    profiles: () => runtime.profiles(),
    resolveApiKey: provider => runtime.requestKey(provider),
    auth: { credentials: NO_STORED_CREDENTIALS, authContext: NO_AMBIENT_AUTH },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`dsh-cpa-provider: unusable replay state for "${provider}/${model}"; sending provider-neutral history (${reason})`)
    },
  }, {
    defaultLevel: (provider, model) => runtime.defaultLevel(provider, model),
    ready: provider => runtime.ensureCatalog(provider),
  })

  // Registering (or re-registering the same routes) publishes
  // `llm/adapters-updated`, which is what makes model pickers reload.
  let registration: AdapterRegistrationHandle | undefined
  let registeredRoutes: string | undefined
  let announcedFacts: string | undefined
  const facts = (): string => JSON.stringify([...runtime.views()].map(([route, view]) => [
    route,
    view.displayName,
    view.models.filter(model => !model.hidden).map(model => [
      model.id, model.name, model.levels, model.defaultLevel, model.contextWindow, model.input, view.fast.has(model.id),
    ]),
  ]))
  const publish = (): void => {
    const routes = runtime.routes()
    const nextFacts = facts()
    try {
      if (registration === undefined) {
        if (routes.length === 0) return
        registration = ctx.llm.registerAdapter(routes, adapter)
      } else if (JSON.stringify(routes) !== registeredRoutes || nextFacts !== announcedFacts) {
        registration.replace(routes)
      }
      registeredRoutes = JSON.stringify(routes)
      announcedFacts = nextFacts
    } catch (error) {
      ctx.logger.error('dsh-cpa-provider: registering CPA routes failed (another plugin may own the same route)')
      ctx.logger.error(error)
    }
  }
  let publishQueued = false
  runtime.onChange(() => {
    if (publishQueued) return
    publishQueued = true
    queueMicrotask(() => {
      publishQueued = false
      publish()
    })
  })
  publish()

  // Periodic refresh, re-armed when the interval changes.
  let timer: ReturnType<typeof setInterval> | undefined
  let timerMinutes: number | undefined
  const armTimer = (): void => {
    const minutes = config.refreshIntervalMinutes.get()
    if (minutes === timerMinutes) return
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    timerMinutes = minutes
    if (minutes > 0) {
      timer = setInterval(() => { void runtime.refreshAll() }, minutes * 60_000)
      timer.unref?.()
    }
  }
  armTimer()
  ctx.effect(() => () => {
    if (timer !== undefined) clearInterval(timer)
    runtime.stop()
  })

  ctx.on('loader/volatile-update', () => {
    const before = new Set(runtime.list().filter(state => state.catalog === undefined).map(state => state.config.id))
    runtime.applySettings(readSettings())
    armTimer()
    // Fetch catalogs for instances that just appeared or were re-pointed.
    for (const state of runtime.list()) {
      if (state.catalog === undefined && state.endpoints !== undefined && !state.refreshing && !before.has(state.config.id)) {
        void runtime.refresh(state.config.id).catch(() => {})
      }
    }
  })

  // A key stored elsewhere (Models page, another command) refreshes its instance.
  ctx.on('credentials/reference-updated', (ref) => {
    for (const state of runtime.list()) {
      if (state.credentialRef === String(ref) && state.endpoints !== undefined) void runtime.refresh(state.config.id).catch(() => {})
    }
  })

  void runtime.refreshAll({ freshMs: STARTUP_CACHE_FRESH_MS })

  const writeSection = async (field: 'instances' | 'models', value: unknown): Promise<void> => {
    const settings = ctx.get('settings')
    if (settings === undefined) {
      throw new Error(`当前组合没有设置服务，请直接编辑 profile 的 cordis.patch.yml 中 id 为 ${settingsNs} 的条目`)
    }
    await settings.mutate(settingsNs, [{ op: 'set', path: [field], value }])
  }

  const host: CommandHost = {
    runtime,
    readInstances: () => plainInstances(config.instances.get()),
    writeInstances: async (next) => { await writeSection('instances', next) },
    readRules: () => plainRules(config.models.get()),
    writeRules: async (next) => { await writeSection('models', next) },
    setKey: async (ref, value) => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error(`当前组合没有凭据存储，请改用环境变量 ${ref}`)
      await credentials.set(credentialRef(ref), value)
    },
    clearKey: async (ref) => {
      await ctx.get('credentials')?.unset(credentialRef(ref))
    },
    describeKey: async (ref) => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const info = await credentials.describe(credentialRef(ref))
        return { configured: info.configured, ...info.source === undefined ? {} : { source: String(info.source) } }
      }
      const value = launchEnvironmentOf(ctx).get(ref)?.value
      return { configured: value !== undefined && value.length > 0, ...value ? { source: 'environment' } : {} }
    },
  }

  ctx.inject(['commands'], (child) => {
    child.effect(function* () {
      for (const command of createCommands(host)) {
        yield child.commands.register({
          name: command.name,
          description: command.description,
          ...command.hint === undefined ? {} : { input: { hint: command.hint } },
          ...command.recordInput === undefined ? {} : { recordInput: command.recordInput },
          handler: async ({ agent, rawInput, signal }) => {
            const context = agent.session.requestContext()
            const current: CurrentRoute | undefined = context ? { provider: context.provider, model: context.model } : undefined
            return await command.run({
              args: rawInput,
              ...current ? { current } : {},
              ask: askVia(ctx.get('userQuestions'), agent, signal),
            })
          },
        })
      }
    })
  })
}
