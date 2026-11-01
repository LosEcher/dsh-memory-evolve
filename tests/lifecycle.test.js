/**
 * 生命周期（槽位 / 取代边 / 失效标记）单测 —— 判据是"结构规则真的生效，且失败方向安全"。
 *
 * 为什么这些必须测（2026-11-01 回测结论）：文本相似度在本语料上零召回（87/87 全 novel），
 * 所以整套判定改成了**结构判据**。结构判据一旦写错，症状是"旧版本继续注入"或
 * "不同主题被互相取代"——两者都不会报错，只会让记忆慢慢说错话。
 *
 * 覆盖：
 *  1. 同槽位写入 ⇒ 旧条 deprecated、新条带 supersedes、active 只剩 1 条（文件里仍有 2 条）
 *  2. 负向控制：**不同槽位不得互相取代**（同轨两条都 active）
 *  3. supersedeById：按 id 取代；`[deprecated:<新id>]` 指向正确
 *  4. replaceById 修死锁：并存时 `replace <match>` 必报 multiMatch，而按 id 能改
 *  5. 无 id 的旧条被取代时**补确定性 id**（否则取代边没有落点）
 *  6. trackLifecycle 的机械三数：同槽位多 active / 取代边未落实 / deprecated
 *  7. 注入面只取 active（deprecated 仍可读）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../lib/store.js'
import {
  deprecateEntry, isActive, normalizeSlot, parseLifecycle, trackLifecycle, withLifecycleMarks,
} from '../lib/lifecycle.js'
import { extractEntryId, legacyIdFor, stripEntryId } from '../lib/sync/entryid.js'

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-lifecycle-'))
  const store = new MemoryStore(dir)
  const agent = { session: { header: { cwd: dir } } }
  const raw = (target = 'memory') => readFileSync(store.pathOf(target, agent), 'utf8')
  return { dir, store, agent, raw }
}

test('同槽位写入：旧条 deprecated、新条带 supersedes、active 只剩 1 条', () => {
  const r = rig()
  try {
    const first = r.store.add('memory', 'forgejo 的 SSH 端口是 3022', r.agent, { slot: 'forgejo-ssh-port' })
    assert.equal(first.ok, true)
    assert.equal(first.superseded.length, 0, '第一条没有旧版本可取代')
    const firstId = extractEntryId(r.store.entriesOf('memory', r.agent)[0])
    assert.match(firstId ?? '', /^[0-9a-f]{8}$/, '带槽位的条目必须有身份，否则取代边没有落点')

    const second = r.store.add('memory', 'forgejo 的 SSH 端口已改为 3222', r.agent, { slot: 'forgejo-ssh-port' })
    assert.equal(second.ok, true)
    assert.equal(second.superseded.length, 1)
    assert.deepEqual(second.superseded, [firstId])

    const all = r.store.entriesOf('memory', r.agent)
    assert.equal(all.length, 2, '旧版不许物理删除（CALM：保留以支持历史推理）')
    const oldParsed = parseLifecycle(all[0])
    const newParsed = parseLifecycle(all[1])
    assert.equal(oldParsed.deprecated, true)
    assert.equal(oldParsed.deprecatedBy, newParsed.id, '失效标记必须指向取代者')
    assert.equal(newParsed.supersedes, firstId, '新条必须写明取代了谁')

    const active = r.store.activeEntriesOf('memory', r.agent)
    assert.equal(active.length, 1, '注入面只应看到最新一条')
    assert.match(active[0], /3222/)
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('负向控制：不同槽位互不取代（否则会把无关事实吃掉）', () => {
  const r = rig()
  try {
    r.store.add('memory', 'forgejo 的 SSH 端口是 3022', r.agent, { slot: 'forgejo-ssh-port' })
    const other = r.store.add('memory', 'forgejo 的 HTTP 端口是 3022', r.agent, { slot: 'forgejo-http-port' })
    assert.equal(other.superseded.length, 0, '不同槽位不得互相取代')
    assert.equal(r.store.activeEntriesOf('memory', r.agent).length, 2)
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('没有槽位的普通写入不受影响（零变化兼容）', () => {
  const r = rig()
  try {
    const a = r.store.add('memory', '一次性事实 A', r.agent)
    const b = r.store.add('memory', '一次性事实 B', r.agent)
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(a.superseded.length + b.superseded.length, 0)
    assert.equal(r.store.activeEntriesOf('memory', r.agent).length, 2)
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('supersedeById：按 id 取代，失效标记指向新条', () => {
  const r = rig()
  try {
    r.store.add('memory', '旧口径：分批 du 累加', r.agent)
    const oldEntry = r.store.entriesOf('memory', r.agent)[0]
    // 普通写入没有 id（不需要生命周期时确实不该制造身份）
    assert.equal(extractEntryId(oldEntry), null)
    const oldId = legacyIdFor(oldEntry)

    // 无 id 时先用 replaceById 之外的方式拿到 id：supersedeById 接受确定性 id
    const out = r.store.supersedeById('memory', oldId, '新口径：用 birthtime 直方图', r.agent)
    assert.equal(out.ok, true, out.message)
    const all = r.store.entriesOf('memory', r.agent)
    assert.equal(all.length, 2)
    const oldParsed = parseLifecycle(all[0])
    assert.equal(oldParsed.deprecated, true, '旧条必须被标失效')
    assert.ok(extractEntryId(all[0]) !== null, '被取代的旧条要补上身份证（取代边才有落点）')
    assert.match(all[1], /birthtime/)
    assert.equal(r.store.activeEntriesOf('memory', r.agent).length, 1)
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('replaceById 修死锁：并存时 replace<match> 会 multiMatch，而按 id 能改', () => {
  const r = rig()
  try {
    r.store.add('memory', '门禁状态：14 项全绿', r.agent)
    r.store.add('memory', '门禁状态：14 项全绿（2026-11-01 复核）', r.agent)
    // 这一步复现死锁：子串命中两条 ⇒ 拒绝
    const viaMatch = r.store.replace('memory', '门禁状态', '门禁状态：15 项全绿', r.agent)
    assert.equal(viaMatch.ok, false)
    assert.match(viaMatch.message, /匹配到|multi|不唯一/, '要有明确的"命中多条"拒绝')

    // 按 id 寻址不受并存影响
    const entries = r.store.entriesOf('memory', r.agent)
    const id = legacyIdFor(entries[0])
    const viaId = r.store.replaceById('memory', id, '门禁状态：15 项全绿', r.agent)
    assert.equal(viaId.ok, true, viaId.message)
    const after = r.store.entriesOf('memory', r.agent)
    assert.equal(after.length, 2, '按 id 替换不改变条目数')
    assert.ok(after.some((e) => e.includes('15 项全绿')))
    assert.equal(extractEntryId(after.find((e) => e.includes('15 项全绿'))), id, '身份不变')
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})

test('trackLifecycle：机械三数各自独立（构造样例 + 零值对照）', () => {
  const clean = trackLifecycle([
    withLifecycleMarks('[2026-11-01] a', { slot: 's1' }),
    withLifecycleMarks('[2026-11-01] b', { slot: 's2' }),
  ])
  assert.equal(clean.sameSlotMultiActive, 0)
  assert.equal(clean.supersedesEdgeUnresolved, 0)
  assert.equal(clean.deprecated, 0)
  assert.equal(clean.slots, 2)

  const id = 'aaaaaaaa'
  const dirty = trackLifecycle([
    `[id:${id}] [2026-11-01] 旧版`, // 仍 active
    `[id:bbbbbbbb] [supersedes:${id}] [2026-11-01] 新版`, // 声称取代了 aaaaaaaa
    '[id:cccccccc] [slot:dup] [2026-11-01] 槽位 x',
    '[id:dddddddd] [slot:dup] [2026-11-01] 槽位 y', // 同槽位第二条 active
    `[id:eeeeeeee] [deprecated:ffffffff] [2026-11-01] 已失效`,
  ])
  assert.equal(dirty.supersedesEdgeUnresolved, 1, '取代边指向的条目仍 active ⇒ 未落实')
  assert.equal(dirty.sameSlotMultiActive, 1, '一个槽位出现 2 条 active ⇒ 计 1')
  assert.equal(dirty.deprecated, 1)
  assert.equal(dirty.active, 4)
})

test('deprecateEntry：无 id 的旧条补确定性 id，且幂等', () => {
  const plain = '[2026-11-01] 老条目'
  const once = deprecateEntry(plain, 'deadbeef')
  const twice = deprecateEntry(once.entry, 'deadbeef')
  assert.equal(once.backfilled, true)
  assert.equal(extractEntryId(once.entry), legacyIdFor(plain))
  assert.match(once.entry, /\[deprecated:deadbeef\]/)
  assert.equal(twice.entry, once.entry, '重复标记必须幂等（不能叠两个 deprecated）')
  assert.equal(isActive(once.entry), false)
  assert.equal(stripEntryId(once.entry).includes('[id:'), false, '身份证只能有一个且在头部')
})

test('normalizeSlot：归一化与拒绝（非法字符、空值）', () => {
  assert.deepEqual(normalizeSlot('Forgejo SSH Port'), { ok: true, slug: 'forgejo-ssh-port' })
  assert.deepEqual(normalizeSlot('a//b..c'), { ok: true, slug: 'a-b..c' })
  assert.equal(normalizeSlot('   ').ok, false)
  assert.equal(normalizeSlot('***').ok, false)
})

test('负向控制：正文里引用标记字面，不得被当成真标记（2026-11-01 真实误报回归）', () => {
  // 真实事故：讲解生命周期契约的 key 条目正文里写了 `[deprecated]`，被"前 200 字符"
  // 判据当成失效标记 ⇒ stale 报 deprecated=1（假红）。标记只在**头部连续块**里算数。
  const prose = '[2026-11-01] 生命周期契约：头部顺序固定 `[deprecated] [slot] [supersedes]`，此处只是举例'
  const parsed = parseLifecycle(prose)
  assert.equal(parsed.deprecated, false, '正文引用不是标记')
  assert.equal(parsed.slot, null)
  assert.equal(isActive(prose), true)

  // 日期之后（头部块已终止）出现的标记字面同样不算
  assert.equal(parseLifecycle('[2026-11-01] 正文提到 [deprecated] 这个词').deprecated, false)

  // 真正的连续头部块仍必须认出来
  const real = '[id:abababab] [slot:port] [supersedes:cdcdcdcd] [deprecated:efefefef] [2026-11-01] 正文'
  const p2 = parseLifecycle(real)
  assert.equal(p2.slot, 'port')
  assert.equal(p2.supersedes, 'cdcdcdcd')
  assert.equal(p2.deprecatedBy, 'efefefef')
  assert.equal(isActive(real), false)
})
