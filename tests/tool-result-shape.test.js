/**
 * memory 工具返回值的形状守卫（2026-11-01 真实故障回归）。
 *
 * 故障现场：key 轨写入**已成功落盘**，但返回值带了 schema 未声明的 `id`/`queued`，
 * 工具层 `additionalProperties: false` 校验失败 ⇒ 整次调用被报成错误。用户看到
 * "写入失败"，实际写进去了；后续还会看到"待确认 1 条"与真实状态不符。
 *
 * 判据：`outcomeOnly` 的输出**键集合必须是 schema 白名单的子集**，且 ok/message 必存在
 * （它们是 schema 的 required —— 剥离后丢字段会变成另一次假失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MEMORY_RESULT_KEYS, outcomeOnly } from '../lib/index.js'

const allowed = new Set(MEMORY_RESULT_KEYS)

test('白名单覆盖 schema 的 required 与可回传键；entries 必须**不**在写路径白名单里', () => {
  for (const key of ['ok', 'message', 'target', 'chars', 'multi', 'total']) {
    assert.ok(allowed.has(key), `schema 声明了 ${key}，白名单必须含它`)
  }
  // 写操作不回显整份条目列表是既有契约（tests/plugin.test.js）；list 走它自己的路径
  assert.equal(allowed.has('entries'), false, 'entries 不得进入写路径白名单')
})

test('负向控制：enqueue 风格的多余字段（id/queued/duplicate/autoApplied）必须被剥掉', () => {
  const raw = {
    ok: true,
    message: '已入队',
    target: 'key',
    id: 'deadbeef',        // 真实故障来源之一
    queued: 1,             // 真实故障来源之一
    duplicate: false,
    autoApplied: true,
    superseded: ['aaaaaaa1'],
    slot: 'forgejo-ssh-port',
  }
  const out = outcomeOnly(raw)
  for (const key of Object.keys(out)) {
    assert.ok(allowed.has(key), `输出含 schema 外键 ${key}（会让整次调用被判失败）`)
  }
  assert.equal(out.ok, true)
  assert.equal(out.message, '已入队')
  assert.equal(out.id, undefined)
  assert.equal(out.queued, undefined)
})

test('必要字段缺失时补默认（否则剥离后又变成一次假失败）', () => {
  const out = outcomeOnly({ target: 'memory', chars: 12 })
  assert.equal(typeof out.ok, 'boolean')
  assert.equal(typeof out.message, 'string')
  assert.equal(out.chars, 12, 'schema 内的字段要保留')
  assert.equal('entries' in out, false, '写路径不回显条目列表')
})

test('matches 仍剥身份证与摘要头（回归：replace 多命中的展示）', () => {
  const out = outcomeOnly({ ok: false, message: '命中 2 条', matches: ['[id:aaaaaaa1] [summary:标题] 正文一', '[id:bbbbbbb2] 正文二'] })
  assert.equal(out.matches[0].includes('[id:'), false)
  assert.equal(out.matches[1].includes('[id:'), false)
})
