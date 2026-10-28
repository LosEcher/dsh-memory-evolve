/**
 * 决策台账（P0）单测 —— 判据不是"能写一行"，而是：
 *  1. **id 稳定**：同目标 + 同正文（含空白差异）⇒ 同 id；改正文 ⇒ 换 id。
 *  2. **fold 乱序收敛**：同一组事件按任意顺序 fold 出同一状态（否则"读了半张
 *     台账"会得到假状态，并被当成"未决定"再问用户一次）。
 *  3. **幂等**：同一 id 被批准两次，存储只写一次，第二次明确报"已有决定"。
 *  4. **fail-open**：台账写不进去只返回 ok:false，绝不抛；也不能回滚已发生的
 *     记忆写入。
 *  5. 快照只在队列非空时提示，且提示随条数变化（缓存友好）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendDecision, buildDecisionEvent, decisionsPath, foldDecisions, readDecisions,
  statusCounts, statusForAction, suggestionId, autoPreviewStats,
} from '../lib/decisions.js'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { enqueueSuggestion, approveSuggestions, rejectSuggestions } from '../lib/review.js'
import { renderSnapshot, resolveConfig } from '../lib/index.js'

import { setLocale } from '../lib/i18n.js'
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mem-decisions-'))
}

function queueOf(dir) {
  return new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
}

test('suggestionId：同正文（含空白差异）同 id，改正文换 id，跨目标不同 id', () => {
  const a = suggestionId('memory', '事实 A  有   多空格')
  const b = suggestionId('memory', '事实 A 有 多空格')
  const c = suggestionId('memory', '事实 A 有 多空格（已修）')
  const d = suggestionId('key', '事实 A 有 多空格')
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.equal(a, b, '空白差异必须归一到同一个 id')
  assert.notEqual(a, c, '正文变了就是另一条事实')
  assert.notEqual(a, d, '不同目标轨是不同建议')
})

test('buildDecisionEvent：非法 action / 非法 id 一律抛错（fail-closed）', () => {
  assert.throws(() => buildDecisionEvent({ id: 'abcd1234', action: 'whatever' }), /未知 action/)
  assert.throws(() => buildDecisionEvent({ id: 'not-hex', action: 'approved' }), /8 位十六进制/)
  const row = buildDecisionEvent({ id: 'abcd1234', action: 'approved', target: 'memory', actor: 'user' })
  assert.equal(row.schema, 1)
  assert.equal(row.actor, 'user')
  assert.equal(row.action, 'approved')
})

test('appendDecision：写不进去只返回 ok:false，绝不抛', () => {
  // 把 decisions.jsonl 变成目录 ⇒ 追加必然失败
  const dir = tempDir()
  try {
    mkdirSync(decisionsPath(dir), { recursive: true })
    const res = appendDecision(dir, { id: 'abcd1234', action: 'approved', target: 'memory' })
    assert.equal(res.ok, false)
    assert.equal(typeof res.error, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foldDecisions：乱序收敛 + 后发生的决定压过提议 + 状态映射', () => {
  const dir = tempDir()
  try {
    const id = 'aaaabbbb'
    const t0 = Date.UTC(2026, 9, 28, 1)
    appendDecision(dir, { id, action: 'proposed', target: 'memory', content: 'x' }, { ts: t0 })
    appendDecision(dir, { id, action: 'rejected', target: 'memory', content: 'x', actor: 'user' }, { ts: t0 + 1000 })
    const rows = readDecisions(dir)
    assert.equal(rows.length, 2)
    const forward = foldDecisions(rows)
    const reversed = foldDecisions([...rows].reverse())
    assert.deepEqual(forward.get(id), reversed.get(id), 'fold 结果不得依赖行顺序')
    assert.equal(forward.get(id).status, 'rejected')
    assert.equal(forward.get(id).actor, 'user')
    // 同 ts 的不同动作也要确定性（rank: reverted > 决定 > proposed）
    const tie = foldDecisions([
      { id, action: 'approved', ts: '2026-10-28T01:00:00.000Z' },
      { id, action: 'reverted', ts: '2026-10-28T01:00:00.000Z' },
    ])
    assert.equal(tie.get(id).status, 'pending', 'reverted 把条目打回待确认')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('statusForAction：proposed/reverted = pending，其余是已决定', () => {
  assert.equal(statusForAction('proposed'), 'pending')
  assert.equal(statusForAction('reverted'), 'pending')
  for (const action of ['approved', 'auto_applied', 'rejected', 'archived', 'expired']) {
    assert.notEqual(statusForAction(action), 'pending', `${action} 必须是已决定状态`)
  }
})

test('approve 按 id：幂等 —— 第二次报"已有决定"，存储只写一次', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const queue = queueOf(dir)
    const first = enqueueSuggestion(queue, 'memory', '幂等事实：只应写入一次', '测试')
    assert.equal(first.ok, true)
    assert.match(first.id, /^[0-9a-f]{8}$/)

    const r1 = approveSuggestions(store, todoStore, queue, [], undefined, undefined, undefined, { ids: [first.id] })
    assert.equal(r1.decided.length, 1)
    assert.equal(r1.remaining, 0)
    assert.equal(store.entriesOf('memory').filter((e) => e.includes('幂等事实')).length, 1)

    // 同一条建议再次被提议（例如另一个 presenter 重放/模型再次提议）：
    // 已决定的 id 不再入队，队列保持空，存储不重复写。
    const again = enqueueSuggestion(queue, 'memory', '幂等事实：只应写入一次', '测试')
    assert.equal(again.id, first.id)
    assert.equal(again.alreadyDecided, true, '已决定的建议不得复活')
    assert.equal(queue.read().length, 0, '被拒绝/批准过的建议不应重新出现在队列')
    const r2 = approveSuggestions(store, todoStore, queue, [], undefined, undefined, undefined, { ids: [first.id] })
    assert.equal(r2.decided.length, 0, '已决定的 id 不得再写一次')
    assert.equal(store.entriesOf('memory').filter((e) => e.includes('幂等事实')).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reject 按 id 记录 rejected，且不写存储', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const queue = queueOf(dir)
    const { id } = enqueueSuggestion(queue, 'memory', '要拒绝的事实', '测试')
    const report = rejectSuggestions(queue, [], { ids: [id] })
    assert.equal(report.removed, 1)
    assert.equal(store.entriesOf('memory').length, 0)
    const folded = foldDecisions(readDecisions(dir))
    assert.equal(folded.get(id).status, 'rejected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('statusCounts / autoPreviewStats：只统计 pending 的预演', () => {
  const folded = foldDecisions([
    { id: '11112222', action: 'proposed', ts: '2026-10-28T00:00:00.000Z', policyPreview: { action: 'auto', reason: 'policy:balanced:auto' } },
    { id: '33334444', action: 'proposed', ts: '2026-10-28T00:00:00.000Z', policyPreview: { action: 'confirm', reason: 'hits<2' } },
    { id: '55556666', action: 'proposed', ts: '2026-10-28T00:00:00.000Z', policyPreview: { action: 'auto', reason: 'policy:balanced:auto' } },
    { id: '55556666', action: 'approved', ts: '2026-10-28T01:00:00.000Z' },
  ])
  const counts = statusCounts(folded)
  assert.equal(counts.pending, 2)
  assert.equal(counts.approved, 1)
  const preview = autoPreviewStats(folded)
  assert.equal(preview.wouldAuto, 1, '已决定的那条不再计入预演')
  assert.equal(preview.wouldConfirm, 1)
  assert.equal(preview.byReason['policy:balanced:auto'], 1)
})

test('快照提示：队列非空才出现，措辞带"不需要开 tab"的路径', () => {
  const dir = tempDir()
  try {
    const config = resolveConfig({ memoryDir: dir })
    const agent = { session: { id: 'session-hint', header: { cwd: '/proj/hint' } } }
    const store = new MemoryStore(dir)
    const empty = renderSnapshot(config, store, agent)
    assert.ok(!empty.includes('待确认记忆建议'), '空队列不得出现提示')

    writeFileSync(join(dir, 'SUGGESTIONS.jsonl'), `${JSON.stringify({
      id: 'abcd1234', time: new Date().toISOString(), target: 'memory', content: '一条待确认事实', reason: 'r', hits: 1,
    })}\n`)
    const hinted = renderSnapshot(config, store, agent)
    assert.ok(hinted.includes('待确认记忆建议 1 条'), hinted.slice(0, 400))
    assert.ok(hinted.includes('/memory_review'), '提示必须给出可直接执行的路径')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
