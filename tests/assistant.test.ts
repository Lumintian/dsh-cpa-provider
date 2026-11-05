import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AskCancelled, AskUnavailable, type Ask } from '../src/ask.ts'
import { describeSetup, patchYaml, previewProposal } from '../src/assistant.ts'
import type { InstanceConfig, ModelRule } from '../src/config.ts'
import { CpaRuntime } from '../src/runtime.ts'
import { runConfigTool, type ToolHost } from '../src/tool.ts'

const fast = [{ id: 'priority' }]
const levels = (...efforts: string[]) => efforts.map(effort => ({ effort }))
const CATALOG = { models: [
  { slug: 'gpt-6-luna', display_name: 'GPT 6.0 Luna', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max'), default_reasoning_level: 'medium', service_tiers: fast, context_window: 272000 },
  { slug: 'api/gpt-6-luna', display_name: 'gpt-6-luna', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max'), default_reasoning_level: 'medium', service_tiers: fast },
  { slug: 'grok-4.3', display_name: 'Grok 4.3', supported_reasoning_levels: levels('none', 'low', 'medium', 'high') },
  { slug: 'gpt-image-2', display_name: 'GPT Image 2', visibility: 'hide' },
] }

const HOME: InstanceConfig = { id: 'home', name: '家用 CPA', baseURL: 'http://127.0.0.1:8317', fast: [] }

async function setup(options: { instances?: InstanceConfig[]; rules?: ModelRule[]; canWrite?: boolean } = {}) {
  let instances = options.instances ?? [HOME]
  let rules = options.rules ?? []
  const runtime = new CpaRuntime({
    cacheDir: mkdtempSync(join(tmpdir(), 'cpa-assistant-')),
    resolveKey: async () => 'k',
    logger: { warn: () => {} },
    fetch: (async () => new Response(JSON.stringify(CATALOG))) as unknown as typeof globalThis.fetch,
  })
  const sync = () => runtime.applySettings({ instances, rules, showHidden: false, fetchTimeoutMs: 1000 })
  sync()
  await runtime.refreshAll()
  const writes: string[] = []
  const host: ToolHost = {
    runtime,
    settingsNs: 'cpa-provider',
    canWrite: () => options.canWrite !== false,
    readInstances: () => instances,
    writeInstances: async (next) => { writes.push('instances'); instances = next; sync() },
    readRules: () => rules,
    writeRules: async (next) => { writes.push('models'); rules = next; sync() },
    setKey: async () => { throw new Error('the tool never sets keys') },
    clearKey: async () => { throw new Error('the tool never clears keys') },
    describeKey: async () => ({ configured: true }),
  }
  return { host, writes, rules: () => rules, instances: () => instances }
}

const confirm = (label: string): Ask => async questions => new Map([[questions[0]!.id, { id: questions[0]!.id, selected: [label] }]])
const noCards: Ask = async () => { throw new AskUnavailable() }

test('read lists the live catalog with offered and effective levels, keyless', async () => {
  const { host } = await setup({ rules: [{ match: 'gpt-6-luna', efforts: ['low', 'max'], defaultEffort: 'low', input: [] }] })
  const text = await describeSetup(host, 'cpa-provider')
  assert.match(text, /^CPA 插件配置（cordis.patch.yml 条目 id: cpa-provider）：1 个实例，1 条模型规则/)
  assert.match(text, /gpt-6-luna \| GPT 6.0 Luna \| low\/medium\/high\/xhigh\/max \(medium\) \| low\/max \(low\) \| 272000 \| text \| 可 Fast \| models\[0\]/)
  assert.match(text, /api\/gpt-6-luna \| api\/gpt-6-luna \| .* \| low\/max \(low\) \|/, 'the base-id rule covers the prefixed alias')
  assert.match(text, /grok-4.3 \| Grok 4.3 \| off\/low\/medium\/high/)
  assert.ok(!text.includes('gpt-image-2 |'), 'hidden models are left out by default')
  assert.match(text, /另有 1 个隐藏模型/)
  assert.ok(!/\bk\b.*key/.test(text.replace(/key (已设置|未设置)/g, '')), 'no key value appears')
})

test('preview reports per-model changes, warnings, and blocks errors', async () => {
  const { host } = await setup()
  const good = previewProposal(host, { models: [
    { match: 'gpt-6-*', efforts: ['low', 'max', 'ultra' as never], defaultEffort: 'max', input: [] },
  ] })
  assert.ok(good.errors.length > 0, 'ultra is not a dsh level, the schema refuses it')

  const ok = previewProposal(host, {
    instances: [{ ...HOME, fast: ['api/gpt-6-luna', 'grok-4.3', 'gpt-6-luna-x'] }],
    models: [
      { match: 'gpt-6-*', efforts: ['low', 'max'], defaultEffort: 'max', input: [] },
      { match: 'claude-*', efforts: ['high'], input: [] },
    ],
  })
  assert.deepEqual(ok.errors, [])
  assert.ok(ok.changes.some(line => line === '~ cpa-home/gpt-6-luna：档位 low/medium/high/xhigh/max · 默认 medium · 上下文 272000 · 输入 text → 档位 low/max · 默认 max · 上下文 272000 · 输入 text'))
  assert.ok(ok.changes.some(line => line.startsWith('~ cpa-home/api/gpt-6-luna：') && line.endsWith('默认 max · 上下文 272000 · 输入 text · Fast')))
  assert.ok(ok.warnings.some(line => line.includes('grok-4.3 的目录没有列出 priority')))
  assert.ok(ok.warnings.some(line => line.includes('gpt-6-luna-x，但目录里没有这个模型')))
  assert.ok(ok.warnings.some(line => line.includes('models[1]（match: claude-*）没有匹配到任何已知模型')))
  assert.ok(ok.instancesChanged && ok.modelsChanged)

  const bad = previewProposal(host, { instances: [
    { id: 'Home', baseURL: 'http://x', fast: [] },
    { id: 'b', baseURL: 'http://u:p@host', fast: [] },
    { id: 'c', baseURL: 'http://c', fast: [], apiKey: 'sk-secret' } as InstanceConfig,
  ] })
  assert.ok(bad.errors.some(line => line.includes('不能写 key') && line.includes('proposal.instances[2].apiKey')))
})

test('the YAML entry is complete, quoted, and omits empty lists', () => {
  const yaml = patchYaml('cpa-provider', [{ id: 'home', baseURL: 'http://h', fast: ['api/gpt-6-luna'] }], [
    { match: '*', efforts: [], input: [], hidden: false },
    { match: '/^gpt-/i', efforts: ['low', 'max'], defaultEffort: 'low', input: [] },
  ], { showHiddenModels: true })
  assert.equal(yaml, [
    '- id: cpa-provider',
    '  config:',
    '    instances:',
    '      - id: "home"',
    '        baseURL: "http://h"',
    '        fast: ["api/gpt-6-luna"]',
    '    models:',
    '      - match: "*"',
    '        hidden: false',
    '      - match: "/^gpt-/i"',
    '        efforts: ["low", "max"]',
    '        defaultEffort: "low"',
    '    showHiddenModels: true',
  ].join('\n'))
})

test('apply writes only after the user confirms on a card', async () => {
  const models: ModelRule[] = [{ match: 'gpt-6-luna', efforts: ['low', 'max'], defaultEffort: 'low', input: [] }]
  const app = await setup()

  const asked: string[] = []
  const cancelled = await runConfigTool(app.host, { action: 'apply', models }, async (questions) => {
    asked.push(questions[0]!.question)
    return new Map([['confirm', { id: 'confirm', selected: ['取消'] }]])
  })
  assert.match(cancelled, /^未应用：用户没有确认/)
  assert.match(asked[0]!, /cpa-home\/gpt-6-luna/, 'the card lists the effective changes')
  assert.deepEqual(app.writes, [])

  assert.match(await runConfigTool(app.host, { action: 'apply', models }, async () => { throw new AskCancelled() }), /关闭了确认卡片/)
  const headless = await runConfigTool(app.host, { action: 'apply', models }, noCards)
  assert.match(headless, /^未应用：这个界面没法请用户确认/)
  assert.match(headless, /```yaml\n- id: cpa-provider\n/, 'falls back to the YAML entry for manual migration')
  assert.deepEqual(app.writes, [])

  const done = await runConfigTool(app.host, { action: 'apply', models }, confirm('应用'))
  assert.match(done, /^✓ 已应用 CPA 配置/)
  assert.deepEqual(app.writes, ['models'], 'unchanged instances are not rewritten')
  assert.deepEqual(app.rules(), models)
  assert.match(await runConfigTool(app.host, { action: 'apply', models }, confirm('应用')), /^未应用：方案与当前配置相同/)
})

test('apply refuses errors and returns YAML when nothing can write', async () => {
  const app = await setup({ canWrite: false })
  assert.match(await runConfigTool(app.host, { action: 'apply', models: [{ match: '/(/' }] }, confirm('应用')), /^未应用。\n✗ 方案有 1 个错误/)
  const noSettings = await runConfigTool(app.host, { action: 'apply', models: [{ match: 'grok-*', hidden: true }] }, confirm('应用'))
  assert.match(noSettings, /^未应用：当前组合没有设置服务/)
  assert.match(noSettings, /- match: "grok-\*"\n {8}hidden: true/)
  assert.deepEqual(app.writes, [])
  assert.match(await runConfigTool(app.host, { action: 'preview' }, confirm('应用')), /需要方案/)
})
