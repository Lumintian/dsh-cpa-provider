/**
 * The dsh adapter for CPA routes: dsh-llm-pi-ai's own `PiAiAdapter`, plus a
 * per-model default reasoning level.
 *
 * `PiAiAdapter` owns everything about a request — message conversion, tool
 * calls, images, replay, errors — so CPA routes behave exactly like any other
 * pi-ai route. It only knows a route-wide default level, though, so this
 * subclass rewrites the `defaultEffort` it reports per model. dsh's model
 * picker preselects that level when the user switches to the model, and the
 * runtime sends it whenever a request names no level.
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'

export interface CpaAdapterHooks {
  /** The per-model default level for the current configuration generation. */
  defaultLevel: (provider: string, model: string) => string | undefined
  /** Resolve once the route has had a chance to load its first catalog. */
  ready: (provider: string) => Promise<void>
}

/** Report `level` as the model's default when the model offers it. */
export function withDefaultEffort(info: LlmResolvedModelInfo, level: string | undefined): LlmResolvedModelInfo {
  const reasoning = info.reasoning
  if (level === undefined || reasoning === undefined) return info
  if (!reasoning.efforts.some(effort => String(effort.id) === level)) return info
  return { ...info, reasoning: { ...reasoning, defaultEffort: ReasoningEffortId(level) } }
}

export class CpaAdapter extends PiAiAdapter {
  private readonly hooks: CpaAdapterHooks

  constructor(options: PiAiAdapterOptions, hooks: CpaAdapterHooks) {
    super(options)
    this.hooks = hooks
  }

  // A one-shot run (headless, ACP, SDK) can ask for a model before the
  // background fetch of an uncached catalog has finished; waiting here keeps
  // that first request from failing as an unknown model.

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.hooks.ready(provider)
    return await super.listModels(provider)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.hooks.ready(provider)
    const level = this.hooks.defaultLevel(provider, model)
    return withDefaultEffort(await super.resolveModel(provider, model, signal), level)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    await this.hooks.ready(provider)
    // Read right before the parent captures its snapshot, synchronously, so
    // both come from the same configuration generation.
    const level = this.hooks.defaultLevel(provider, model)
    const call = await super.prepareCall(provider, model, signal)
    return { ...call, model: withDefaultEffort(call.model, level) }
  }
}
