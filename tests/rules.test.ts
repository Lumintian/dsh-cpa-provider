import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapCatalog } from '../src/catalog.ts'
import type { ModelRule } from '../src/config.ts'
import { compileRules, parseMatch, resolveModel } from '../src/rules.ts'
import { CPA_CATALOG } from './fixtures.ts'

const catalog = mapCatalog(CPA_CATALOG.models)
const byId = (id: string) => catalog.find(model => model.id === id)!

function rule(fields: Partial<ModelRule> & { match: string }): ModelRule {
  return { efforts: [], input: [], ...fields }
}

/** The example from the requirements: all GPT models, then GPT-6-Luna. */
const USER_RULES: ModelRule[] = [
  rule({ match: '/^gpt-/i', efforts: ['low', 'medium', 'xhigh', 'max'], defaultEffort: 'xhigh' }),
  rule({ match: 'GPT-6-Luna', efforts: ['low', 'max'], defaultEffort: 'low' }),
]

test('globs are case-insensitive whole-name matches; /…/flags is a regex', () => {
  assert.ok(parseMatch('gpt-*').test('GPT-5.5'))
  assert.ok(!parseMatch('gpt-*').test('xgpt-5.5'))
  assert.ok(parseMatch('gpt-5.5').test('gpt-5.5'))
  assert.ok(!parseMatch('gpt-5.5').test('gpt-5x5'), 'dots are literal in globs')
  assert.ok(parseMatch('/luna$/').test('gpt-6-luna'))
  assert.ok(!parseMatch('/LUNA$/').test('gpt-6-luna'), 'regex without i stays case-sensitive')
})

test('stateful regex flags are dropped so repeated tests stay stable', () => {
  const regex = parseMatch('/gpt/g')
  assert.ok(regex.test('gpt-5.5'))
  assert.ok(regex.test('gpt-5.5'))
})

test('invalid patterns are reported and skipped', () => {
  const compiled = compileRules([rule({ match: '/(/' }), rule({ match: 'ok' })])
  assert.equal(compiled.rules.length, 1)
  assert.match(compiled.issues[0]!, /models\[0\]/)
})

test('later rules override earlier ones: GPT models vs GPT-6-Luna', () => {
  const { rules } = compileRules(USER_RULES)
  const gpt = resolveModel(byId('gpt-5.5'), 'cpa-home', rules)
  assert.deepEqual(gpt.levels, ['low', 'medium', 'xhigh', 'max'])
  assert.equal(gpt.defaultLevel, 'xhigh')
  assert.deepEqual(gpt.warnings, [])
  assert.deepEqual(gpt.matchedRules, [0])

  const luna = resolveModel(byId('gpt-6-luna'), 'cpa-home', rules)
  assert.deepEqual(luna.levels, ['low', 'max'])
  assert.equal(luna.defaultLevel, 'low')
  assert.deepEqual(luna.matchedRules, [0, 1])
})

test('without rules, the catalog decides; none→off and ultra is dropped', () => {
  const gpt = resolveModel(byId('gpt-5.5'), 'cpa-home', [])
  assert.deepEqual(gpt.levels, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(gpt.defaultLevel, 'low')
  assert.equal(gpt.contextWindow, 500000)
  const claude = resolveModel(byId('claude-sonnet-4-5'), 'cpa-home', [])
  assert.deepEqual(claude.levels, ['off', 'low', 'medium', 'high'])
  assert.equal(claude.defaultLevel, 'medium')
  assert.equal(claude.maxTokens, 64000)
})

test('levels only narrow; unknown ones warn instead of being invented', () => {
  const { rules } = compileRules([rule({ match: 'gpt-6-luna', efforts: ['off', 'low'], defaultEffort: 'high' })])
  const luna = resolveModel(byId('gpt-6-luna'), 'cpa-home', rules)
  assert.deepEqual(luna.levels, ['low'])
  assert.equal(luna.defaultLevel, undefined, 'catalog default medium is not selectable either')
  assert.equal(luna.warnings.length, 2)
  assert.match(luna.warnings[0]!, /off/)
  assert.match(luna.warnings[1]!, /high/)
})

test('the route-qualified name matches, so a rule can target one instance', () => {
  const { rules } = compileRules([rule({ match: 'cpa-backup/*', contextWindow: 128000 })])
  assert.equal(resolveModel(byId('gpt-5.5'), 'cpa-backup', rules).contextWindow, 128000)
  assert.equal(resolveModel(byId('gpt-5.5'), 'cpa-home', rules).contextWindow, 500000)
})

test('capacity, input, and visibility overrides', () => {
  const { rules } = compileRules([
    rule({ match: '*', maxTokens: 32000, input: ['text'] }),
    rule({ match: 'gpt-image-2', hidden: false }),
    rule({ match: 'claude-*', hidden: true }),
  ])
  const gpt = resolveModel(byId('gpt-5.5'), 'cpa-home', rules)
  assert.equal(gpt.maxTokens, 32000)
  assert.deepEqual(gpt.input, ['text'])
  assert.equal(resolveModel(byId('gpt-image-2'), 'cpa-home', rules).hidden, false)
  assert.equal(resolveModel(byId('claude-sonnet-4-5'), 'cpa-home', rules).hidden, true)
  assert.equal(resolveModel(byId('gpt-image-2'), 'cpa-home', []).hidden, true)
  assert.equal(resolveModel(byId('gpt-image-2'), 'cpa-home', [], { showHidden: true }).hidden, false)
})
