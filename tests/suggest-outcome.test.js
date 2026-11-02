// memory_suggest 的返回值必须**只**带 output schema 允许的键。
// 2026-11-02 真实故障：enqueueSuggestion 返回的 id/deduped/autoApplied/duplicate
// 让 additionalProperties:false 校验失败，建议已入队却被报成"写入失败"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SUGGEST_RESULT_KEYS, suggestOutcomeOnly, suggestToolDefinition } from '../lib/review.js'
import { SuggestionQueue } from '../lib/store.js'

test('suggestOutcomeOnly keeps only the schema keys', () => {
  const out = suggestOutcomeOnly({
    ok: true,
    message: 'queued',
    queued: 3,
    id: 'abcd1234',
    deduped: true,
    autoApplied: true,
    duplicate: false,
    alreadyDecided: false,
  })
  assert.deepEqual(Object.keys(out).sort(), ['message', 'ok', 'queued'])
  assert.equal(out.ok, true)
  assert.equal(out.queued, 3)
})

test('suggestOutcomeOnly always yields a boolean ok and a string message', () => {
  const out = suggestOutcomeOnly({ queued: 1 })
  assert.equal(out.ok, false)
  assert.equal(out.message, '')
  assert.equal(suggestOutcomeOnly(null), null)
})

test('the tool returns exactly the schema keys, and the suggestion is really queued', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-suggest-outcome-'))
  const queue = new SuggestionQueue(join(dir, 'suggestions.jsonl'))
  const config = { suggestToolName: 'memory_suggest' }
  const tool = suggestToolDefinition(config, queue, () => true)

  const allowed = new Set(['ok', 'message', 'queued'])
  for (const key of SUGGEST_RESULT_KEYS) allowed.add(key)
  // schema 的键必须与白名单一致（两处一起改）
  const schemaKeys = Object.keys(tool.output.schema.properties)
  assert.deepEqual(schemaKeys.sort(), [...SUGGEST_RESULT_KEYS].sort())

  const first = await tool.execute(
    { target: 'memory', content: '一个值得记住的事实', reason: '测试' },
    { agent: { id: 'test', cwd: dir } },
  )
  for (const key of Object.keys(first)) {
    assert.ok(allowed.has(key), `tool 返回值出现 schema 外的键：${key}`)
  }
  assert.equal(first.ok, true)
  assert.ok(existsSync(queue.file), '建议必须已经落盘')
  assert.equal(readFileSync(queue.file, 'utf8').trim().split('\n').length, 1)

  // 同内容再来一次命中去重分支：那条分支原本会带 id/deduped
  const second = await tool.execute(
    { target: 'memory', content: '一个值得记住的事实', reason: '测试' },
    { agent: { id: 'test', cwd: dir } },
  )
  for (const key of Object.keys(second)) {
    assert.ok(allowed.has(key), `去重分支出现 schema 外的键：${key}`)
  }
  assert.equal(second.ok, true)
})
