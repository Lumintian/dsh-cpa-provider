/**
 * End to end: the plugin mounted through Cordis' Loader beside the real dsh
 * LLM runtime, talking to a scripted CPA server over HTTP. Exercises catalog
 * discovery, rules, per-model default effort, Fast on the wire, volatile
 * config updates, and the slash commands.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { CPA_CATALOG } from './fixtures.ts'

interface Seen {
  modelsAuth: string[]
  responses: Array<{ auth: string | undefined; body: Record<string, unknown> }>
}

const seen: Seen = { modelsAuth: [], responses: [] }
let server: Server
let baseURL: string
let home: string
const KEY = 'sk-cpa-test'

function sse(events: Array<Record<string, unknown>>): string {
  return events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

const reply = sse([
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hello from cpa' },
  { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: 'hello from cpa' },
  { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'hello from cpa', annotations: [] } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello from cpa', annotations: [] }] } },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello from cpa', annotations: [] }] }],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    },
  },
])

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return body
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-cpa-e2e-'))
  process.env.DSH_HOME = home
  server = createServer((request, response) => {
    void (async () => {
      const auth = request.headers.authorization
      if (request.method === 'GET' && request.url === '/v1/models?client_version=dsh') {
        seen.modelsAuth.push(auth ?? '')
        if (auth !== `Bearer ${KEY}`) {
          response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad key"}')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(CPA_CATALOG))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/responses') {
        seen.responses.push({ auth, body: JSON.parse(await readBody(request)) as Record<string, unknown> })
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(reply)
        return
      }
      response.writeHead(404).end()
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
})

/** In-memory stand-in for the harness credential store. */
function fakeCredentials(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    service: {
      resolve: async (ref: string) => (values.has(ref) ? { value: values.get(ref)!, source: 'store' } : undefined),
      describe: async (ref: string) => ({ configured: values.has(ref), writable: true, ...values.has(ref) ? { source: 'store' } : {} }),
      set: async (ref: string, value: string) => { values.set(ref, value) },
      unset: async (ref: string) => { values.delete(ref) },
    },
  }
}

/** In-memory stand-in for the settings service: path writes become Loader config updates. */
function fakeSettings(apply: (section: Record<string, unknown>) => Promise<void>, current: () => Record<string, unknown>) {
  return {
    mutate: async (_ns: string, ops: Array<{ op: 'set'; path: string[]; value: unknown }>) => {
      const next = structuredClone(current())
      for (const op of ops) {
        assert.equal(op.path.length, 1)
        next[op.path[0]!] = op.value
      }
      await apply(next)
    },
  }
}

async function boot(config: Record<string, unknown>, keys: Record<string, string>) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const credentials = fakeCredentials(keys)
  ctx.provide('credentials', credentials.service as never)
  const commands = new Map<string, { handler: (invocation: unknown) => Promise<{ kind: string; text?: string }> }>()
  ctx.provide('commands', {
    register: (definition: { name: string; handler: (invocation: unknown) => Promise<{ kind: string; text?: string }> }) => {
      commands.set(definition.name, definition)
      return () => { commands.delete(definition.name) }
    },
  } as never)
  const skills = new Map<string, { description: string; content: string; source: string }>()
  ctx.provide('skills', {
    register: (skill: { name: string; description: string; content: string; source: string }) => {
      skills.set(skill.name, skill)
      return () => { skills.delete(skill.name) }
    },
  } as never)
  const tools = new Map<string, { parameters: unknown; execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown> }>()
  ctx.provide('tools', {
    register: (tool: { name: string; parameters: unknown; execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown> }) => {
      tools.set(tool.name, tool)
      return () => { tools.delete(tool.name) }
    },
  } as never)
  await ctx.plugin(Loader)
  ctx.loader.builtins['cpa-under-test'] = plugin
  // The runtime keeps a caller-chosen id (the profile row id); the published type omits it.
  const id = await ctx.loader.create({ id: 'cpa-provider', name: 'cordis:cpa-under-test', config } as { name: string; config: unknown })
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  const update = async (next: Record<string, unknown>) => {
    await entry.update({ config: next })
    await entry.fiber!.await()
  }
  ctx.provide('settings', fakeSettings(update, () => entry.options.config as Record<string, unknown>) as never)
  const run = async (name: string, rawInput = '', requestContext?: { provider: string; model: string }) => {
    const command = commands.get(name)
    assert.ok(command, `command /${name} is registered`)
    return await command.handler({ rawInput, agent: { session: { requestContext: () => requestContext } } })
  }
  /** Install a scripted user-questions service; it records what each card asked and who asked it. */
  const answerCards = (reply: (questions: Array<{ id: string; options?: Array<{ label: string }> }>) => Array<{ id: string; selected: string[]; custom?: string }>) => {
    const asked: Array<{ agent: unknown; questions: Array<{ id: string; question: string }> }> = []
    ctx.provide('userQuestions', {
      ask: async (request: { agent: unknown; questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }> }) => {
        asked.push(request)
        return { answers: reply(request.questions) }
      },
    } as never)
    return asked
  }
  return { ctx, update, run, credentials, entry, answerCards, skills, tools, dispose: () => ctx.fiber.dispose() }
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function textOf(chunks: StreamChunk[]): string {
  return chunks.flatMap(chunk => (chunk.type === 'text-delta' ? [chunk.text] : [])).join('')
}

const RULES = [
  { match: '/^gpt-/i', efforts: ['low', 'medium', 'xhigh', 'max'], defaultEffort: 'xhigh' },
  { match: 'gpt-6-luna', efforts: ['low', 'max'], defaultEffort: 'low' },
]

test('catalog, rules, per-model defaults, Fast on the wire, and live config', async () => {
  const app = await boot({
    instances: [{ id: 'home', name: '家用 CPA', baseURL, fast: ['gpt-5.5'] }],
    models: RULES,
  }, { CPA_HOME_API_KEY: KEY })
  try {
    const { ctx } = app
    await until(async () => (await ctx.llm.listModels('cpa-home')).length > 0, 'the catalog to load')
    assert.deepEqual(ctx.llm.listProviders().find(provider => provider.id === 'cpa-home'), { id: 'cpa-home', name: '家用 CPA' })
    assert.ok(seen.modelsAuth.includes(`Bearer ${KEY}`))

    const models = await ctx.llm.listModels('cpa-home')
    assert.deepEqual(models.map(model => model.id), ['gpt-5.5', 'gpt-6-luna', 'claude-sonnet-4-5'], 'hidden image model is not listed')
    assert.equal(models[0]!.name, 'GPT-5.5 · Fast')

    const luna = await ctx.llm.resolveModelInfo('cpa-home', 'gpt-6-luna')
    assert.deepEqual(luna.reasoning?.efforts.map(effort => String(effort.id)), ['low', 'max'])
    assert.equal(String(luna.reasoning?.defaultEffort), 'low')
    assert.equal(luna.context?.contextWindow, 272000)
    const gpt = await ctx.llm.resolveModelInfo('cpa-home', 'gpt-5.5')
    assert.deepEqual(gpt.reasoning?.efforts.map(effort => String(effort.id)), ['low', 'medium', 'xhigh', 'max'])
    assert.equal(String(gpt.reasoning?.defaultEffort), 'xhigh')
    const claude = await ctx.llm.resolveModelInfo('cpa-home', 'claude-sonnet-4-5')
    assert.deepEqual(claude.reasoning?.efforts.map(effort => String(effort.id)), ['off', 'low', 'medium', 'high'])
    assert.equal(String(claude.reasoning?.defaultEffort), 'medium')

    // A Fast model with no explicit effort: priority tier plus the model default.
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })]
    const fastChunks = await collect(ctx.llm.stream({ provider: 'cpa-home', model: 'gpt-5.5', messages }))
    assert.equal(textOf(fastChunks), 'hello from cpa')
    const fastRequest = seen.responses.at(-1)!
    assert.equal(fastRequest.auth, `Bearer ${KEY}`)
    assert.equal(fastRequest.body.model, 'gpt-5.5')
    assert.equal(fastRequest.body.service_tier, 'priority')
    assert.deepEqual(fastRequest.body.reasoning, { effort: 'xhigh', summary: 'auto' })
    assert.equal(fastRequest.body.max_output_tokens, undefined)

    // A model without Fast: no tier, and Luna's own default.
    await collect(ctx.llm.stream({ provider: 'cpa-home', model: 'gpt-6-luna', messages }))
    const lunaRequest = seen.responses.at(-1)!
    assert.equal(lunaRequest.body.service_tier, undefined)
    assert.deepEqual(lunaRequest.body.reasoning, { effort: 'low', summary: 'auto' })

    // Toggle Fast for the session's current model through the command.
    const toggled = await app.run('cpa-fast', '', { provider: 'cpa-home', model: 'gpt-6-luna' })
    assert.equal(toggled.kind, 'success', toggled.text)
    await until(async () => (await ctx.llm.listModels('cpa-home')).some(model => model.name === 'GPT-6-Luna · Fast'), 'Fast to apply')
    await collect(ctx.llm.stream({ provider: 'cpa-home', model: 'gpt-6-luna', messages }))
    assert.equal(seen.responses.at(-1)!.body.service_tier, 'priority')

    // Fast cannot be turned on where the catalog lists no priority tier.
    const refused = await app.run('cpa-fast', 'on cpa-home/claude-sonnet-4-5')
    assert.equal(refused.kind, 'error')
    assert.match(refused.text!, /priority/)

    // Edit the rules live: no remount, the next resolution sees them.
    await app.update({ ...app.entry.options.config as object, models: [{ match: '*', efforts: ['high'], defaultEffort: 'high', contextWindow: 64000 }] })
    await until(async () => String((await ctx.llm.resolveModelInfo('cpa-home', 'claude-sonnet-4-5')).reasoning?.defaultEffort) === 'high', 'rules to reload')
    assert.equal((await ctx.llm.resolveModelInfo('cpa-home', 'claude-sonnet-4-5')).context?.contextWindow, 64000)

    const status = await app.run('cpa', 'home')
    assert.equal(status.kind, 'success')
    assert.match(status.text!, /gpt-6-luna/)
    assert.match(status.text!, /claude-sonnet-4-5  \[high\] \/ high \/ 64k/)
    assert.match(status.text!, /gpt-image-2 .*隐藏/)
  } finally {
    await app.dispose()
  }
})

test('a missing key keeps the route empty until /cpa-key stores one', async () => {
  const app = await boot({ instances: [] }, {})
  try {
    const { ctx } = app
    const added = await app.run('cpa-add', `backup ${baseURL} 备用 CPA`)
    assert.equal(added.kind, 'success', added.text)
    assert.match(added.text!, /cpa-key backup/)
    await until(() => ctx.llm.listProviders().some(provider => provider.id === 'cpa-backup'), 'the route to register')
    assert.deepEqual(await ctx.llm.listModels('cpa-backup'), [])

    const stored = await app.run('cpa-key', `backup ${KEY}`)
    assert.equal(stored.kind, 'success', stored.text)
    assert.equal(app.credentials.values.get('CPA_BACKUP_API_KEY'), KEY)
    await until(async () => (await ctx.llm.listModels('cpa-backup')).length === 3, 'models after the key')

    const removed = await app.run('cpa-remove', 'backup')
    assert.equal(removed.kind, 'success', removed.text)
    await until(() => !ctx.llm.listProviders().some(provider => provider.id === 'cpa-backup'), 'the route to go away')
    assert.equal(app.credentials.values.has('CPA_BACKUP_API_KEY'), false)
  } finally {
    await app.dispose()
  }
})

test('commands ask through the user-questions service with the invoking agent', async () => {
  const app = await boot({ instances: [{ id: 'home', baseURL, fast: [] }] }, { CPA_HOME_API_KEY: KEY })
  try {
    await until(async () => (await app.ctx.llm.listModels('cpa-home')).length > 0, 'the catalog to load')
    const asked = app.answerCards(questions => questions.map(question => ({ id: question.id, selected: [question.options![0]!.label] })))
    const context = { provider: 'cpa-home', model: 'gpt-6-luna' }
    const result = await app.run('cpa-fast', '', context)
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text!, /^✓ Fast：已开启 cpa-home\/gpt-6-luna/, 'the current model is listed first')
    assert.equal(asked.length, 1)
    assert.deepEqual((asked[0]!.agent as { session: { requestContext: () => unknown } }).session.requestContext(), context)
    await until(async () => (await app.ctx.llm.listModels('cpa-home')).some(model => model.name === 'GPT-6-Luna · Fast'), 'Fast to apply')
  } finally {
    await app.dispose()
  }
})

test('the configuration skill and cpa_config tool are registered and use the live setup', async () => {
  const app = await boot({ instances: [{ id: 'home', name: '家用 CPA', baseURL, fast: [] }], models: RULES }, { CPA_HOME_API_KEY: KEY })
  try {
    await until(async () => (await app.ctx.llm.listModels('cpa-home')).length > 0, 'the catalog to load')
    const skill = app.skills.get('cpa-provider-config')
    assert.ok(skill, 'the skill is registered')
    assert.equal(skill.source, 'bundled')
    assert.match(skill.content, /cpa_config/)
    const tool = app.tools.get('cpa_config')
    assert.ok(tool, 'the tool is registered')
    const exec = { signal: new AbortController().signal }
    const read = String(await tool.execute({ action: 'read' }, exec))
    assert.match(read, /## cpa-home（家用 CPA）/)
    assert.match(read, /gpt-6-luna \| .* \| low\/max \(low\)/)
    assert.ok(!read.includes(KEY), 'no key in tool output')

    // Without a user-questions service nothing is written; the YAML comes back instead.
    const models = [...RULES, { match: 'claude-*', hidden: true }]
    const applied = String(await tool.execute({ action: 'apply', models }, exec))
    assert.match(applied, /^未应用：这个界面没法请用户确认/)
    assert.equal((app.entry.options.config as { models: unknown[] }).models.length, RULES.length)

    // With a card the user confirms, the change lands in the plugin's settings and takes effect.
    app.answerCards(questions => [{ id: questions[0]!.id, selected: ['应用'] }])
    assert.match(String(await tool.execute({ action: 'apply', models }, exec)), /^✓ 已应用 CPA 配置/)
    await until(async () => !(await app.ctx.llm.listModels('cpa-home')).some(model => model.id.startsWith('claude-')), 'claude to be hidden')
  } finally {
    await app.dispose()
  }
  assert.equal(app.tools.size, 0, 'disposal unregisters the tool')
  assert.equal(app.skills.size, 0, 'disposal unregisters the skill')
})
