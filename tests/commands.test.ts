/**
 * The `/cpa*` commands driven through scripted question cards: each test
 * answers the cards the way a user would click them, then checks what was
 * written to config and the credential store, and what the result says.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { type Answer, type Ask, AskCancelled, AskUnavailable, type Question } from '../src/ask.ts'
import { type CommandHost, type CpaCommand, createCommands, type CurrentRoute, suggestInstanceId } from '../src/commands.ts'
import type { InstanceConfig, ModelRule } from '../src/config.ts'
import { CpaRuntime } from '../src/runtime.ts'
import { CPA_CATALOG } from './fixtures.ts'

/** A user answering cards: each step sees the questions and returns answers by id. */
type Step = (questions: Question[]) => Record<string, Partial<Answer>> | 'cancel'

function scripted(steps: Step[], seen: Question[][] = []): Ask {
  return async (questions) => {
    seen.push(questions)
    const step = steps.shift()
    if (!step) throw new Error(`unexpected card: ${questions.map(q => q.question).join(' / ')}`)
    const reply = step(questions)
    if (reply === 'cancel') throw new AskCancelled()
    return new Map(questions.map(q => [q.id, { id: q.id, selected: [], ...reply[q.id] }]))
  }
}

const noCards: Ask = async () => { throw new AskUnavailable() }

async function setup(options: { instances?: InstanceConfig[]; rules?: ModelRule[]; keys?: Record<string, string> } = {}) {
  let instances = options.instances ?? []
  let rules = options.rules ?? []
  const keys = new Map(Object.entries(options.keys ?? {}))
  const runtime = new CpaRuntime({
    cacheDir: mkdtempSync(join(tmpdir(), 'cpa-commands-')),
    resolveKey: async ref => keys.get(ref),
    logger: { warn: () => {} },
    fetch: (async () => new Response(JSON.stringify(CPA_CATALOG))) as unknown as typeof globalThis.fetch,
  })
  const sync = () => runtime.applySettings({ instances, rules, showHidden: false, fetchTimeoutMs: 1000 })
  sync()
  await runtime.refreshAll()
  const host: CommandHost = {
    runtime,
    readInstances: () => instances,
    writeInstances: async (next) => { instances = next; sync() },
    readRules: () => rules,
    writeRules: async (next) => { rules = next; sync() },
    setKey: async (ref, value) => {
      if (setKeyFails) throw new Error('store is read-only')
      keys.set(ref, value)
    },
    clearKey: async (ref) => { keys.delete(ref) },
    describeKey: async ref => ({ configured: keys.has(ref) }),
  }
  const commands = new Map(createCommands(host).map(command => [command.name, command]))
  let setKeyFails = false
  const run = (name: string, args: string, ask: Ask, current?: CurrentRoute, flags: { setKeyFails?: boolean } = {}) => {
    setKeyFails = flags.setKeyFails === true
    return (commands.get(name) as CpaCommand).run({ args, ask, ...current ? { current } : {} })
  }
  return { run, keys, runtime, instances: () => instances, rules: () => rules }
}

const HOME: InstanceConfig = { id: 'home', name: '家用 CPA', baseURL: 'http://127.0.0.1:8317', fast: [] }

test('every result starts with a one-line summary', async () => {
  const app = await setup({ instances: [HOME], keys: { CPA_HOME_API_KEY: 'k' } })
  const status = await app.run('cpa', 'status', noCards)
  assert.match(status.text.split('\n')[0]!, /^CPA：1 个实例 · 3 个模型/)
  const detail = await app.run('cpa', 'home', noCards)
  assert.match(detail.text.split('\n')[0]!, /^cpa-home（家用 CPA） · 3 个模型 · key 已设置/)
})

test('/cpa without arguments is a menu that hands off to the chosen command', async () => {
  const app = await setup({ instances: [HOME], keys: { CPA_HOME_API_KEY: 'k' } })
  const seen: Question[][] = []
  const result = await app.run('cpa', '', scripted([
    () => ({ action: { selected: ['开关 Fast'] } }),
    q => ({ models: { selected: [q[0]!.options![0]!.label] } }),
  ], seen))
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /^✓ Fast：已开启 cpa-home\/gpt-5.5/)
  assert.deepEqual(app.instances()[0]!.fast, ['gpt-5.5'])
  assert.deepEqual(seen[0]![0]!.options!.map(option => option.label),
    ['查看状态', '添加实例', '保存 API key', '开关 Fast', '设置模型思考强度', '刷新模型目录', '删除实例'])
  assert.match(seen[0]![0]!.options![0]!.description!, /1 个实例/)
})

test('/cpa menu accepts an instance name typed into the card', async () => {
  const app = await setup({ instances: [HOME], keys: { CPA_HOME_API_KEY: 'k' } })
  const detail = await app.run('cpa', '', scripted([() => ({ action: { custom: 'home' } })]))
  assert.match(detail.text, /^cpa-home（家用 CPA）/)
  const unknown = await app.run('cpa', '', scripted([() => ({ action: { custom: 'whatever' } })]))
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /没有「whatever」这个操作/)
})

test('/cpa falls back to the overview where cards are unavailable', async () => {
  const app = await setup()
  const result = await app.run('cpa', '', noCards)
  assert.match(result.text, /^还没有 CPA 实例 · 输入 \/cpa-add/)
})

test('/cpa-add with no arguments asks address, then name, id, and key', async () => {
  const app = await setup()
  const seen: Question[][] = []
  const result = await app.run('cpa-add', '', scripted([
    () => ({ url: { selected: ['http://127.0.0.1:8317'] } }),
    () => ({ name: { custom: '家用 CPA' }, id: { selected: ['local'] }, key: { custom: 'sk-secret' } }),
  ], seen))
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /^✓ 已添加 cpa-local（家用 CPA），获取到 4 个模型/)
  assert.ok(!result.text.includes('sk-secret'), 'the key is never echoed')
  assert.deepEqual(app.instances(), [{ id: 'local', baseURL: 'http://127.0.0.1:8317', name: '家用 CPA', fast: [] }])
  assert.equal(app.keys.get('CPA_LOCAL_API_KEY'), 'sk-secret')
  assert.deepEqual(seen[1]!.map(q => q.id), ['name', 'id', 'key'])
})

test('/cpa-add takes the address and name as arguments, and the old id-first form still works', async () => {
  const app = await setup()
  const quick = await app.run('cpa-add', 'https://cpa.example.com 公司 CPA', noCards)
  assert.match(quick.text, /^✓ 已添加 cpa-cpa（公司 CPA） · 下一步：\/cpa-key cpa/)
  const old = await app.run('cpa-add', 'backup http://10.0.0.5:8317', noCards)
  assert.match(old.text, /^✓ 已添加 cpa-backup/)
  assert.deepEqual(app.instances().map(item => item.id), ['cpa', 'backup'])
  const duplicate = await app.run('cpa-add', 'backup http://10.0.0.6:8317', noCards)
  assert.equal(duplicate.kind, 'error')
  const nonsense = await app.run('cpa-add', 'hello', noCards)
  assert.match(nonsense.text, /不像 CPA 地址/)
})

test('/cpa-add keeps the instance and says so when storing the key fails', async () => {
  const app = await setup()
  const failing = await app.run('cpa-add', 'http://127.0.0.1:8317', scripted([
    () => ({ name: { selected: ['不设置'] }, id: { selected: ['local'] }, key: { custom: 'sk-x' } }),
  ]), undefined, { setKeyFails: true })
  assert.equal(failing.kind, 'error')
  assert.match(failing.text, /^⚠ 已添加 cpa-local（CPA local），但保存 key 失败：store is read-only · 重试：\/cpa-key local/)
  assert.deepEqual(app.instances().map(item => item.id), ['local'])
})

test('suggested ids are readable and unused', () => {
  assert.equal(suggestInstanceId('http://127.0.0.1:8317', new Set()), 'local')
  assert.equal(suggestInstanceId('localhost:8317', new Set(['local'])), 'local-2')
  assert.equal(suggestInstanceId('http://192.168.1.9:8317', new Set()), 'lan')
  assert.equal(suggestInstanceId('https://My_Proxy.example.com', new Set()), 'my_proxy')
})

test('/cpa-key asks for the key on the only instance and never logs it', async () => {
  const app = await setup({ instances: [HOME] })
  const result = await app.run('cpa-key', '', scripted([() => ({ key: { custom: 'sk-new' } })]))
  assert.match(result.text, /^✓ 已保存 cpa-home 的 key（CPA_HOME_API_KEY），获取到 4 个模型/)
  assert.ok(!result.text.includes('sk-new'))
  assert.equal(app.keys.get('CPA_HOME_API_KEY'), 'sk-new')
  const shortcut = await app.run('cpa-key', 'sk-other', noCards)
  assert.equal(shortcut.kind, 'success', shortcut.text)
  assert.equal(app.keys.get('CPA_HOME_API_KEY'), 'sk-other')
  const cleared = await app.run('cpa-key', '', scripted([() => ({ key: { selected: ['清除已保存的 key'] } })]))
  assert.match(cleared.text, /^✓ 已清除/)
  assert.equal(app.keys.has('CPA_HOME_API_KEY'), false)
})

test('/cpa-fast lists only Fast-capable models, current model first, and toggles the checked ones', async () => {
  const app = await setup({ instances: [{ ...HOME, fast: ['gpt-5.5'] }], keys: { CPA_HOME_API_KEY: 'k' } })
  const seen: Question[][] = []
  const result = await app.run('cpa-fast', '', scripted([
    () => ({ models: { selected: ['gpt-5.5', 'gpt-6-luna'] } }),
  ], seen), { provider: 'cpa-home', model: 'gpt-6-luna' })
  const options = seen[0]![0]!.options!
  assert.deepEqual(options.map(option => option.label), ['gpt-6-luna', 'gpt-5.5'])
  assert.equal(options[0]!.description, '当前：未开启 · 当前会话的模型')
  assert.match(result.text, /^✓ Fast：已开启 cpa-home\/gpt-6-luna；已关闭 cpa-home\/gpt-5.5/)
  assert.deepEqual(app.instances()[0]!.fast, ['gpt-6-luna'])
})

test('/cpa-fast keeps its argument forms and falls back to the current model without cards', async () => {
  const app = await setup({ instances: [HOME], keys: { CPA_HOME_API_KEY: 'k' } })
  assert.match((await app.run('cpa-fast', '', noCards, { provider: 'cpa-home', model: 'gpt-5.5' })).text, /^✓ Fast：已开启/)
  assert.match((await app.run('cpa-fast', 'off gpt-5.5', noCards)).text, /^✓ Fast：已关闭/)
  const refused = await app.run('cpa-fast', 'on cpa-home/claude-sonnet-4-5', noCards)
  assert.equal(refused.kind, 'error')
})

test('/cpa-model writes an instance-specific rule that wins over pattern rules', async () => {
  const pattern: ModelRule = { match: 'gpt-*', efforts: ['low', 'medium', 'xhigh', 'max'], defaultEffort: 'xhigh', input: [] }
  const app = await setup({ instances: [HOME], rules: [pattern], keys: { CPA_HOME_API_KEY: 'k' } })
  const seen: Question[][] = []
  const result = await app.run('cpa-model', '', scripted([
    () => ({ model: { selected: ['gpt-6-luna'] } }),
    () => ({ efforts: { selected: ['low', 'max'] }, default: { selected: ['low'] } }),
  ], seen))
  assert.match(result.text, /^✓ cpa-home\/gpt-6-luna：可选 low, max · 默认 low/)
  assert.deepEqual(app.rules(), [pattern, { match: 'cpa-home/gpt-6-luna', efforts: ['low', 'max'], input: [], defaultEffort: 'low' }])
  const luna = app.runtime.views().get('cpa-home')!.models.find(model => model.id === 'gpt-6-luna')!
  assert.deepEqual(luna.levels, ['low', 'max'])
  assert.equal(luna.defaultLevel, 'low')
  // The level card offers what CPA offers and marks what is selectable now.
  const effortOptions = seen[1]![0]!.options!
  assert.deepEqual(effortOptions.map(option => option.label), ['low', 'medium', 'high', 'xhigh', 'max', '恢复默认'])
  assert.equal(effortOptions[0]!.description, '当前可选')
  assert.equal(effortOptions[2]!.description, undefined)

  const reset = await app.run('cpa-model', 'gpt-6-luna', scripted([() => ({ efforts: { selected: ['恢复默认'] } })]))
  assert.match(reset.text, /^✓ 已恢复 cpa-home\/gpt-6-luna/)
  assert.deepEqual(app.rules(), [pattern])
})

test('/cpa-model adds a default level that the chosen levels leave out', async () => {
  const app = await setup({ instances: [HOME], keys: { CPA_HOME_API_KEY: 'k' } })
  const result = await app.run('cpa-model', 'gpt-5.5', scripted([
    () => ({ efforts: { selected: ['low', 'max'] }, default: { selected: ['high'] } }),
  ]))
  assert.match(result.text, /可选 low, high, max · 默认 high/)
  assert.match(result.text, /已把它加进去/)
})

test('/cpa-remove asks which instance and for confirmation', async () => {
  const app = await setup({
    instances: [HOME, { id: 'work', baseURL: 'http://10.0.0.5:8317', fast: [] }],
    keys: { CPA_HOME_API_KEY: 'k', CPA_WORK_API_KEY: 'k2' },
  })
  const kept = await app.run('cpa-remove', '', scripted([() => ({ instance: { selected: ['work'] }, confirm: { selected: ['取消'] } })]))
  assert.match(kept.text, /已取消/)
  assert.equal(app.instances().length, 2)
  const removed = await app.run('cpa-remove', '', scripted([() => ({ instance: { selected: ['work'] }, confirm: { selected: ['删除'] } })]))
  assert.match(removed.text, /^✓ 已删除 cpa-work/)
  assert.deepEqual(app.instances().map(item => item.id), ['home'])
  assert.equal(app.keys.has('CPA_WORK_API_KEY'), false)
})

test('closing a card cancels without changes; missing UI explains the argument form', async () => {
  const app = await setup({ instances: [HOME] })
  const closed = await app.run('cpa-add', '', scripted([() => 'cancel']))
  assert.match(closed.text, /^已取消/)
  const headless = await app.run('cpa-key', '', noCards)
  assert.equal(headless.kind, 'error')
  assert.match(headless.text, /用法：\/cpa-key/)
})
