/**
 * enforce（真自动采纳）单测 —— 判据是"三条分支各走对，且失败方向都安全"：
 *  1. 正例：策略判 auto ⇒ **直接写盘**、不进队列、台账记 auto_applied(actor=policy)；
 *  2. dry-run 同样配置 ⇒ 仍进队列、盘上无痕迹（模式真的是开关，不是文档说法）；
 *  3. 负负得正的对照：命中 denyPatterns / 写入失败 ⇒ **退回入队**，不静默丢；
 *  4. 幂等：同一条内容第二次提出 ⇒ alreadyDecided，不重复写第二份；
 *  5. revert：撤销自动采纳 ⇒ 主轨消失、台账 reverted、撤销率读数变化。
 *
 * 为什么这些必须测：enforce 把"默认问人"反转成"默认采纳"，一旦失败方向写错
 * （写失败被吞、dry-run 也写），症状是"记忆悄悄丢了"或"配置没生效也看不出来"，
 * 两种都不会报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { resolveConfig } from '../lib/index.js'
import { applySuggestionTarget, enqueueSuggestion, reviewCommand } from '../lib/review.js'
import { evaluateSuggestion, resolveDecisionPolicy } from '../lib/policy.js'
import { readDecisions, suggestionId } from '../lib/decisions.js'
import { setLocale } from '../lib/i18n.js'

setLocale('zh')

function rig(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mem-enforce-'))
  const config = resolveConfig({ memoryDir: dir, commandName: 'memory_review', ...overrides })
  const store = new MemoryStore(dir)
  const todoStore = new TodoStore(dir)
  const archive = new ArchiveStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const agent = { id: 'session-test', session: { header: { cwd: dir } } }
  const apply = (target, content, cwd, who) => applySuggestionTarget(store, todoStore, target, content, cwd, who)
  const memoryFile = () => store.pathOf('memory', agent)
  const memoryText = () => (existsSync(memoryFile()) ? readFileSync(memoryFile(), 'utf8') : '')
  return { dir, config, store, todoStore, archive, queue, agent, apply, memoryFile, memoryText }
}

test('enforce：策略判 auto ⇒ 直接写盘、不进队列、台账记 auto_applied', () => {
  const r = rig({ decisionPolicy: 'trusted', decisionPolicyMode: 'enforce' })
  try {
    const content = '自动采纳的正例事实：enforce 会绕过确认队列'
    const out = enqueueSuggestion(r.queue, 'memory', content, 'test', r.agent, {
      policy: resolveDecisionPolicy(r.config),
      apply: r.apply,
    })
    assert.equal(out.ok, true)
    assert.equal(out.autoApplied, true, '应标记为自动采纳')
    assert.equal(r.queue.read().length, 0, '自动采纳的条目不得留在确认队列')
    assert.match(r.memoryText(), new RegExp(content), '必须真的写进记忆轨')
    const rows = readDecisions(r.dir)
    const last = rows[rows.length - 1]
    assert.equal(last.action, 'auto_applied')
    assert.equal(last.actor, 'policy', 'actor 必须是 policy（人批的是 user）')
    assert.equal(last.policyId, 'trusted/enforce', '台账要能回答"哪套策略干的"')
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('dry-run：同样的 trusted 配置仍进队列，盘上不得有痕迹（模式是开关不是口号）', () => {
  const r = rig({ decisionPolicy: 'trusted', decisionPolicyMode: 'dry-run' })
  try {
    const content = 'dry-run 下不该被自动写入的事实'
    const out = enqueueSuggestion(r.queue, 'memory', content, 'test', r.agent, {
      policy: resolveDecisionPolicy(r.config),
      apply: r.apply,
    })
    assert.notEqual(out.autoApplied, true)
    assert.equal(r.queue.read().length, 1, 'dry-run 必须留在队列里等人')
    assert.equal(r.memoryText().includes(content), false, 'dry-run 绝不能写盘')
    const rows = readDecisions(r.dir)
    assert.equal(rows[rows.length - 1].action, 'proposed')
    assert.equal(rows[rows.length - 1].policyPreview.action, 'auto', '预演仍要记下"本该自动"')
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('enforce 的负向控制：命中 denyPatterns（值形态）⇒ 退回队列（不得自动写）', () => {
  const r = rig({ decisionPolicy: 'trusted', decisionPolicyMode: 'enforce' })
  try {
    const content = '把数据库口令换成 API_KEY=sk-live-AbCdEf0123456789 那个'
    const out = enqueueSuggestion(r.queue, 'memory', content, 'test', r.agent, {
      policy: resolveDecisionPolicy(r.config),
      apply: r.apply,
    })
    assert.notEqual(out.autoApplied, true)
    assert.equal(r.queue.read().length, 1)
    assert.equal(r.memoryText().includes(content), false, '含真凭据的条目不自动写')
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('enforce 的正向控制：只谈论 token/密码的普通技术结论 ⇒ 直接自动写入（不误伤）', () => {
  const r = rig({ decisionPolicy: 'trusted', decisionPolicyMode: 'enforce' })
  try {
    // 旧实现（词法表）会把这条拦进队列 —— 这正是 2026-11-02 要修掉的误伤
    const content = '网关的 access token 在宿主重启后会失效，需要重新取'
    const out = enqueueSuggestion(r.queue, 'memory', content, 'test', r.agent, {
      policy: resolveDecisionPolicy(r.config),
      apply: r.apply,
    })
    assert.equal(out.autoApplied, true, '讲 token 的技术结论应自动采纳')
    assert.equal(r.queue.read().length, 0, '不得进队列')
    assert.equal(r.memoryText().includes('access token'), true, '内容要真的落盘')
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('enforce 的负向控制：写入失败 ⇒ 退回入队，绝不静默丢弃', () => {
  const r = rig({ decisionPolicy: 'trusted', decisionPolicyMode: 'enforce' })
  try {
    const content = '写入器报错时这条事实不能消失'
    const out = enqueueSuggestion(r.queue, 'memory', content, 'test', r.agent, {
      policy: resolveDecisionPolicy(r.config),
      apply: () => ({ ok: false, message: 'boom' }),
    })
    assert.notEqual(out.autoApplied, true)
    assert.equal(r.queue.read().length, 1, '写失败必须回到队列（人还能看到它）')
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('幂等：同一条内容第二次提出 ⇒ alreadyDecided，不写第二份', () => {
  const r = rig({ decisionPolicy: 'trusted', decisionPolicyMode: 'enforce' })
  try {
    const content = '只应存在一次的自动采纳事实'
    const options = { policy: resolveDecisionPolicy(r.config), apply: r.apply }
    enqueueSuggestion(r.queue, 'memory', content, 'test', r.agent, options)
    const again = enqueueSuggestion(r.queue, 'memory', content, 'test', r.agent, options)
    assert.equal(again.alreadyDecided, true)
    assert.equal(r.queue.read().length, 0, '已决定的 id 不得再入队')
    const occurrences = r.memoryText().split(content).length - 1
    assert.equal(occurrences, 1, `同一条内容只能写一份，实际 ${occurrences} 份`)
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('revert：撤销自动采纳 ⇒ 主轨消失、台账 reverted、撤销率读数变 100%', () => {
  const r = rig({ decisionPolicy: 'trusted', decisionPolicyMode: 'enforce' })
  try {
    const content = '这条会被撤销掉'
    const options = { policy: resolveDecisionPolicy(r.config), apply: r.apply }
    enqueueSuggestion(r.queue, 'memory', content, 'test', r.agent, options)
    assert.match(r.memoryText(), new RegExp(content))

    const id = suggestionId('memory', content)
    const command = reviewCommand(r.config, r.store, r.todoStore, r.archive, r.queue)
    const reverted = command.handler({ rawInput: `revert #${id}`, agent: r.agent })
    assert.equal(reverted.kind, 'success', reverted.text)
    assert.match(reverted.text, /已撤销/)
    assert.equal(r.memoryText().includes(content), false, '撤销后主轨不得再有该条')

    const rows = readDecisions(r.dir)
    assert.equal(rows[rows.length - 1].action, 'reverted')

    const readout = command.handler({ rawInput: 'policy' })
    assert.match(readout.text, /auto_applied 0 条 · reverted 1 条 · 撤销率 100%/)
    assert.match(readout.text, /当前是 enforce/)
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('key 的长度闸与 memory 分开：keyMaxChars 决定 key 轨能否自动', () => {
  const policy = resolveDecisionPolicy({ decisionPolicy: 'trusted', decisionPolicyMode: 'enforce' })
  const key = (n) => ({ target: 'key', content: 'k'.repeat(n), hits: 1 })
  assert.equal(evaluateSuggestion(policy, key(500)).action, 'auto', '500 字仍在 key 闸内')
  const long = evaluateSuggestion(policy, key(601))
  assert.equal(long.action, 'confirm')
  assert.match(long.reason, /^too-long:601>600/, '要报出命中的是 key 的那条闸')
  // 同一条 500 字在 memory 轨走 maxChars=800（2026-11-02 由 400 提到 800）⇒ auto；
  // 900 字才越线。两轨成本不同这件事仍成立，只是分界移动了。
  assert.equal(evaluateSuggestion(policy, { target: 'memory', content: 'm'.repeat(500), hits: 1 }).action, 'auto')
  const memLong = evaluateSuggestion(policy, { target: 'memory', content: 'm'.repeat(801), hits: 1 })
  assert.equal(memLong.action, 'confirm')
  assert.match(memLong.reason, /^too-long:801>800/, 'memory 轨报的是 maxChars 而非 keyMaxChars')
})
