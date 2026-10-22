/**
 * 注入账本（M2）单测。
 *
 * 判据重点不是"能写一行"，而是：
 *  1. 形状归一 —— 缺字段/脏字段不得变成 NaN 或字符串混进数字列；
 *  2. 月度轮转 —— 跨月两条事件必须落两个文件（否则读取端会一次吃下整年）；
 *  3. **fail-open** —— 写不进去只能返回 ok:false，绝不能抛；
 *  4. 读回容错 —— 半行/坏行跳过，不影响其余事件（账本是 append-only，崩溃会留半行）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendInjectionEvent, buildInjectionEvent, injectionLedgerPath, monthKey, readInjectionEvents, MAX_RECORDED_IDS } from '../lib/inject-ledger.js'

const dir = () => mkdtempSync(join(tmpdir(), 'mem-ledger-'))

test('buildInjectionEvent 归一化：脏数字不变成 NaN，未知 mode 置 null', () => {
  const ev = buildInjectionEvent({
    sessionId: 'session-abc',
    entries: { memory: 243.4, user: 'x', key: -1 },
    chars: { total: 13091, key: 12000 },
    keyMode: 'weird',
    keyIds: ['a', '', null, 7],
  }, { ts: Date.UTC(2026, 9, 22, 12) })
  assert.equal(ev.op, 'snapshot.render')
  assert.equal(ev.entries.memory, 243)
  assert.equal(ev.entries.user, 0)   // 非数字 ⇒ 0，而不是 NaN
  assert.equal(ev.entries.key, 0)    // 负数 ⇒ 0
  assert.equal(ev.keyMode, null)
  assert.deepEqual(ev.keyIds, ['a']) // 空串/非字符串被滤掉
  assert.equal(ev.keyIdsTruncated, false)
  assert.equal(ev.ts, '2026-10-22T12:00:00.000Z')
})

test('keyIds 超过上限时截断并置 keyIdsTruncated', () => {
  const ids = Array.from({ length: MAX_RECORDED_IDS + 5 }, (_, i) => `k${i}`)
  const ev = buildInjectionEvent({ keyIds: ids })
  assert.equal(ev.keyIds.length, MAX_RECORDED_IDS)
  assert.equal(ev.keyIdsTruncated, true)
})

test('appendInjectionEvent 建目录、写一行合法 JSON', () => {
  const d = dir()
  const ev = { sessionId: 's1', entries: { memory: 1, user: 0, key: 2 }, chars: { total: 100, key: 60 }, keyMode: 'summary', keyIds: ['k1', 'k2'] }
  const res = appendInjectionEvent(d, ev, { ts: Date.UTC(2026, 9, 22) })
  assert.equal(res.ok, true)
  assert.ok(res.path.endsWith(join('events', 'injections-2026-10.jsonl')))
  const lines = readFileSync(res.path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.chars.total, 100)   // 不重算：契约是"记下调用方算出的值"
  assert.equal(parsed.keyMode, 'summary')
})

test('月度轮转：跨月两条事件落两个文件', () => {
  const d = dir()
  // monthKey 用**本地**月份（账本是给人读的）⇒ 用本地构造器，别用 Date.UTC 跨月边界
  // （UTC 10-31 23:00 在 Asia/Shanghai 其实是 11-01 07:00，会落到下一个月）
  appendInjectionEvent(d, { chars: { total: 1 } }, { ts: new Date(2026, 9, 15, 12).getTime() })
  appendInjectionEvent(d, { chars: { total: 2 } }, { ts: new Date(2026, 10, 15, 12).getTime() })
  const files = readdirSync(join(d, 'events')).sort()
  assert.deepEqual(files, ['injections-2026-10.jsonl', 'injections-2026-11.jsonl'])
  assert.equal(monthKey(new Date(2026, 10, 15, 12).getTime()), '2026-11')
})

test('fail-open：memoryDir 缺失或不可写只返回 ok:false，绝不抛', () => {
  assert.equal(appendInjectionEvent('', { chars: { total: 1 } }).ok, false)
  const d = dir()
  // 把 events 造成为一个普通文件 ⇒ 建目录/追加都会失败
  writeFileSync(join(d, 'events'), 'not a dir')
  const res = appendInjectionEvent(d, { chars: { total: 1 } })
  assert.equal(res.ok, false)
  assert.equal(typeof res.error, 'string')
  assert.ok(existsSync(d))
})

test('读回容错：坏行/半行被跳过，其余事件仍可读', () => {
  const d = dir()
  appendInjectionEvent(d, { sessionId: 'a', chars: { total: 10 } })
  const p = injectionLedgerPath(d)
  // 只追加半行（不要把原内容再前置一次——flag:'a' 已经负责追加）
  writeFileSync(p, '{"broken":\n', { flag: 'a' }) // 崩溃留下的半行
  appendInjectionEvent(d, { sessionId: 'b', chars: { total: 20 } })
  const evs = readInjectionEvents(d)
  assert.equal(evs.length, 2)
  assert.deepEqual(evs.map((e) => e.sessionId), ['a', 'b'])
})

test('读取端按时间顺序拼接多月文件', () => {
  const d = dir()
  mkdirSync(join(d, 'events'), { recursive: true })
  writeFileSync(join(d, 'events', 'injections-2026-09.jsonl'), `${JSON.stringify(buildInjectionEvent({ sessionId: 'sep' }))}\n`)
  writeFileSync(join(d, 'events', 'injections-2026-10.jsonl'), `${JSON.stringify(buildInjectionEvent({ sessionId: 'oct' }))}\n`)
  assert.deepEqual(readInjectionEvents(d).map((e) => e.sessionId), ['sep', 'oct'])
})
