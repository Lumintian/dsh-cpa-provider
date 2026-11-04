/**
 * Question cards for the `/cpa*` commands.
 *
 * Interactive dsh UIs answer `ctx.userQuestions.ask()` with a card in the
 * composer seat: single or multiple choice plus free text. A command uses it
 * to collect whatever its arguments left out, so every command also works
 * with no arguments at all. Answers are not written to the session log; only
 * the command's own result text is, so a result must never echo a secret.
 */

export interface Choice {
  label: string
  description?: string
}

export interface Question {
  id: string
  /** Short label above the question. */
  header?: string
  question: string
  options?: Choice[]
  multiSelect?: boolean
}

export interface Answer {
  id: string
  selected: string[]
  custom?: string
}

/** Ask a batch of questions; answers come back keyed by question id. */
export type Ask = (questions: Question[]) => Promise<Map<string, Answer>>

/** No UI can answer here (headless, ACP, a composition without the service). */
export class AskUnavailable extends Error {
  constructor() {
    super('question cards are not available in this interface')
    this.name = 'AskUnavailable'
  }
}

/** The user closed the card or the page went away. */
export class AskCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'AskCancelled'
  }
}

/** The free text, else the single selected label; empty means skipped. */
export function single(answer: Answer | undefined): string | undefined {
  const custom = answer?.custom?.trim()
  if (custom) return custom
  const selected = answer?.selected[0]?.trim()
  return selected || undefined
}

/** Every selected label plus free text split on commas or whitespace. */
export function multiple(answer: Answer | undefined): string[] {
  if (!answer) return []
  const typed = answer.custom?.split(/[\s,，]+/).map(item => item.trim()).filter(Boolean) ?? []
  return [...new Set([...answer.selected, ...typed])]
}

interface UserQuestionsLike {
  ask(request: {
    questions: Question[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers: readonly Answer[] }>
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** Adapt dsh's user-questions service, mapping its failures to the two outcomes commands handle. */
export function askVia(service: UserQuestionsLike | undefined, agent: unknown, signal: AbortSignal | undefined): Ask {
  return async (questions) => {
    if (service === undefined) throw new AskUnavailable()
    let result: { answers: readonly Answer[] }
    try {
      result = await service.ask({ questions, agent, ...signal ? { signal } : {} })
    } catch (error) {
      if (errorCode(error) === 'NO_PROVIDER' || errorCode(error) === 'AGENT_SCOPE') throw new AskUnavailable()
      if (signal?.aborted || errorCode(error) === 'ASK_ABORTED' || (error as Error | undefined)?.name === 'AbortError') {
        throw new AskCancelled()
      }
      throw error
    }
    return new Map(result.answers.map(answer => [answer.id, answer]))
  }
}
