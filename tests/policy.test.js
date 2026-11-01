/**
 * 决策策略（P0）单测 —— 判据是"配置错了会红、预设真的决定行为、闸门真的拦"：
 *  1. 预设 + 逐轨覆盖的解析顺序（逐轨 > 预设）；
 *  2. **fail-closed**：未知预设 / 未知 target / 未知 autoApply 键 / 非法枚举 /
 *     `key=auto` / 未实现的 enforce —— 一律抛错并**点名那个键**；
 *  3. auto 的三道闸（denyPatterns / maxChars / requireHits）都真的把 auto 降回
 *     confirm，且**正例仍能 auto**（否则闸门写成"永远 confirm"也能绿）；
 *  4. `memory_review policy` 打印的是**生效值**（配置 ≠ 生效纪律的机械判据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTO_APPLY_DEFAULTS, DECISION_TARGETS, actionForTarget, evaluateSuggestion,
  resolveDecisionPolicy, targetClass, validateDecisionConfig,
} from '../lib/policy.js'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { reviewCommand } from '../lib/review.js'
import { resolveConfig } from '../lib/index.js'

import { setLocale } from '../lib/i18n.js'
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mem-policy-'))
}

test('预设解析：balanced 只自动待办，key 仅 trusted 放开；hands-off 放开 memory/user', () => {
  const strict = resolveDecisionPolicy({ decisionPolicy: 'strict' })
  const balanced = resolveDecisionPolicy({ decisionPolicy: 'balanced' })
  const handsOff = resolveDecisionPolicy({ decisionPolicy: 'hands-off' })
  // 2026-11-01 变更：`key` 不再"任何预设都不许自动"。实测 63/63 条 key 建议全部
  // 被采纳、0 拒绝 ⇒ 由 `trusted` 预设放开（且只在 enforce 下真正生效），
  // 同时禁止 `decisionByTarget.key='auto'` 这种绕开整套策略的单轨硬拨。
  for (const policy of [strict, balanced, handsOff]) {
    assert.equal(policy.actions.key, 'confirm', `${policy.preset} 不应自动写 key`)
  }
  assert.equal(resolveDecisionPolicy({ decisionPolicy: 'trusted' }).actions.key, 'auto')
  assert.equal(handsOff.actions.memory === 'auto', true)
  assert.equal(strict.actions['todo-work'], 'confirm')
  assert.equal(balanced.actions['todo-work'], 'auto')
  assert.equal(handsOff.actions['todo-work'], 'auto')
  assert.equal(handsOff.actions.user, 'auto')
  // 所有 target 都有解析结果（不允许 undefined 漏网）
  for (const target of DECISION_TARGETS) {
    assert.ok(['confirm', 'auto', 'archive'].includes(balanced.actions[target]), `${target} 必须解析出动作`)
  }
})

test('逐轨覆盖优先于预设（可按具体待办轨细分）', () => {
  const policy = resolveDecisionPolicy({
    decisionPolicy: 'balanced',
    decisionByTarget: { 'todo-daily': 'confirm', memory: 'archive' },
  })
  assert.equal(policy.actions['todo-daily'], 'confirm', '具体轨覆盖要压过 todo 类默认 auto')
  assert.equal(policy.actions['todo-work'], 'auto', '未被覆盖的同类轨仍走预设')
  assert.equal(policy.actions.memory, 'archive')
  assert.deepEqual(policy.overrides, { 'todo-daily': 'confirm', memory: 'archive' })
})

test('fail-closed：非法配置抛错并点名键（负向控制）', () => {
  assert.throws(() => validateDecisionConfig({ decisionPolicy: 'yolo' }), /decisionPolicy/)
  // enforce 现在是合法模式（2026-11-01）；非法值仍要点名
  assert.throws(() => validateDecisionConfig({ decisionPolicyMode: 'enforce-now' }), /decisionPolicyMode .*enforce-now/)
  assert.doesNotThrow(() => validateDecisionConfig({ decisionPolicy: 'trusted', decisionPolicyMode: 'enforce' }))
  assert.throws(() => validateDecisionConfig({ decisionByTarget: { memroy: 'auto' } }), /decisionByTarget.*memroy/)
  assert.throws(() => validateDecisionConfig({ decisionByTarget: { memory: 'sometimes' } }), /decisionByTarget\["memory"\]/)
  assert.throws(() => validateDecisionConfig({ decisionByTarget: { key: 'auto' } }), /key 轨设为 auto/)
  assert.throws(() => validateDecisionConfig({ decisionAutoApply: { denyPattern: ['x'] } }), /decisionAutoApply.*denyPattern/)
  assert.throws(() => validateDecisionConfig({ decisionAutoApply: { denyPatterns: ['('] } }), /不是合法正则/)
  assert.throws(() => validateDecisionConfig({ decisionAutoApply: { maxChars: 0 } }), /maxChars/)
  assert.throws(() => validateDecisionConfig({ decisionAutoApply: { keyMaxChars: 0 } }), /keyMaxChars/)
  assert.throws(() => validateDecisionConfig({ decisionAutoApply: { requireHits: -1 } }), /requireHits/)
  assert.throws(() => validateDecisionConfig({ decisionTtlDays: 0 }), /decisionTtlDays/)
  // 合法配置不得误报
  assert.doesNotThrow(() => validateDecisionConfig({ decisionPolicy: 'strict', decisionByTarget: { 'todo-work': 'auto' } }))
})

test('auto 的三道闸：命中拦截项 / 过长 / hits 不足都降回 confirm，正例仍 auto', () => {
  const policy = resolveDecisionPolicy({ decisionPolicy: 'balanced', decisionAutoApply: { requireHits: 2 } })
  const todo = (content, hits = 2) => ({ target: 'todo-work', content, hits })
  // 正例：干净、短、hits 达标 ⇒ auto（若这里写成 confirm，说明闸门写成了死路）
  assert.equal(evaluateSuggestion(policy, todo('把 dsfolder 门禁跑一遍')).action, 'auto')
  // hits 不足
  const lowHits = evaluateSuggestion(policy, todo('把 dsfolder 门禁跑一遍', 1))
  assert.equal(lowHits.action, 'confirm')
  assert.match(lowHits.reason, /^hits<2/)
  // 命中 denyPatterns（默认含 token/密码）
  const deny = evaluateSuggestion(policy, todo('数据库 token 换成新的'))
  assert.equal(deny.action, 'confirm')
  assert.match(deny.reason, /^deny-pattern:/)
  // 过长
  const long = evaluateSuggestion(policy, todo('x'.repeat(AUTO_APPLY_DEFAULTS.maxChars + 1)))
  assert.equal(long.action, 'confirm')
  assert.match(long.reason, /^too-long:/)
  // 非 auto 轨永远 confirm，且原因能说明是哪条策略（预设 + 轨）
  const memory = evaluateSuggestion(policy, { target: 'memory', content: '短事实', hits: 9 })
  assert.equal(memory.action, 'confirm')
  assert.match(memory.reason, /^policy:balanced:memory=confirm/)
})

test('targetClass：四条待办轨归一类，记忆轨各归各的', () => {
  assert.equal(targetClass('todo-life'), 'todo')
  assert.equal(targetClass('todo-project'), 'todo')
  assert.equal(targetClass('memory'), 'memory')
  assert.equal(targetClass('key'), 'key')
  const policy = resolveDecisionPolicy({ decisionPolicy: 'balanced' })
  assert.equal(actionForTarget(policy, 'todo-daily'), 'auto')
  assert.equal(actionForTarget(policy, 'user'), 'confirm')
})

test('memory_review policy：打印生效值（预设/模式/逐轨/闸门/台账/预演）', () => {
  const dir = tempDir()
  try {
    const config = resolveConfig({
      memoryDir: dir,
      commandName: 'memory_review',
      decisionPolicy: 'balanced',
      decisionByTarget: { 'todo-daily': 'confirm' },
    })
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
    const command = reviewCommand(config, store, todoStore, archive, queue)
    const result = command.handler({ rawInput: 'policy' })
    assert.equal(result.kind, 'success')
    const text = result.text
    assert.match(text, /决策策略（生效值）/)
    assert.match(text, /balanced/)
    assert.match(text, /dry-run/)
    assert.match(text, /todo-daily=confirm/)
    assert.match(text, /todo-work=auto/)
    assert.match(text, /denyPatterns \d+ 条/)
    assert.match(text, /keyMaxChars 600/, 'key 的长度闸必须出现在生效值里（否则等于没有）')
    assert.match(text, /自动采纳读数：auto_applied 0 条 · reverted 0 条 · 撤销率 —/)
    assert.match(text, /当前是 dry-run/)
    assert.match(text, /decisionPolicyMode 设为 enforce/, '要告诉人怎么真的开启')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_review policy：enforce 模式下文案与读数切换（不是同一句话糊到底）', () => {
  const dir = tempDir()
  try {
    const config = resolveConfig({
      memoryDir: dir,
      commandName: 'memory_review',
      decisionPolicy: 'trusted',
      decisionPolicyMode: 'enforce',
    })
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
    const command = reviewCommand(config, store, todoStore, archive, queue)
    const result = command.handler({ rawInput: 'policy' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /trusted · 模式 enforce/)
    assert.match(result.text, /当前是 enforce/)
    assert.match(result.text, /revert <#id>/, 'enforce 下必须告诉人怎么撤销')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置写错在 resolveConfig 就红（不是跑起来再静默）', () => {
  assert.throws(() => resolveConfig({ memoryDir: tempDir(), decisionPolicy: 'nope' }), /decisionPolicy/)
  assert.throws(() => resolveConfig({ memoryDir: tempDir(), decisionByTarget: { key: 'auto' } }), /key 轨设为 auto/)
})
