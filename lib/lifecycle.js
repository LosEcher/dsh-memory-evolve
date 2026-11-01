/**
 * 记忆生命周期（P0，2026-11-01）—— 槽位（slot）、取代边（supersedes）、失效标记（deprecated）。
 *
 * ## 为什么需要（回测定论）
 *
 * 2026-11-01 对本地记忆做历史回测，两条硬结论决定了这一层的形状：
 *
 * 1. **文本相似度不能当判据**。把 87 条历史建议按时间序与"提出当日之前的库"比对，
 *    **87/87 全部落在 novel**（3-gram Jaccard < 0.5）——整句相似度在本语料上零召回；
 *    换成"共享 ≥3 个实体"又把 275/495 对不相干的条目判成同主题（"InstantDB 分析"
 *    vs "Vercel fx 调研"）。⇒ 判据必须落在**结构**上，不能落在"句子像不像"上。
 * 2. **真实缺口是"声明取代但不落实"**。条目里自己写着 `supersedes「X」` 的有 9 处，
 *    其中 4 处的被取代方**仍在库、无任何标记、继续每轮注入**（MEMORY 4 处里 3 处）。
 *    根因：`supersedes` 只是自然语言，不产生机械后果；而唯一的更新手段
 *    `replace <match>` 要求子串唯一命中——一旦并存就 `multiMatch` 拒绝，**更新自锁**。
 *
 * ## 因此引入三个纯机器标记（都是条目头部的方括号标签）
 *
 * | 标记 | 含义 | 谁写 |
 * | --- | --- | --- |
 * | `[slot:<slug>]` | **主题槽位**：同一槽位只允许一条 active（Zep 的"边名/关系类型"轻量版） | 写入时按参数/内容带 |
 * | `[supersedes:<id8>]` | 本条取代了哪一条（机械边，可反查） | 写入时自动生成 |
 * | `[deprecated:<id8>]` | 本条已被谁取代；**不删除、不注入**，仍可按 id 读到 | 系统在取代发生时补写 |
 *
 * 「不删除」是刻意的：CALM（arXiv 2610.38573）实测"保留被取代记录支持准确的历史推理，
 * 而不损害当前答案"；Zep 的做法也是让旧事实 `invalid` 而不是删边。
 *
 * ## 本模块的纪律
 *
 * 纯函数、无 IO：所有判定都能在单测里用**构造样例 + 负向控制**验证。判据分两类，
 * 输出时必须分开标注，不许混成一个数字：
 * - **机械确定**：`sameSlotMultiActive` / `supersedesEdgeUnresolved` / `deprecated`
 * - **文本候选（需人工确认）**：`legacySupersedesCandidates` —— 靠"条目自己写着
 *   supersedes/修正/已过时"去反查，会误报，因此只作为清理入口，不进验收门槛。
 *
 * @module dsh-memory-evolve/lifecycle
 */
import { extractEntryId, stripEntryId, legacyIdFor } from './sync/entryid.js'

/** `[slot:...]` — 主题槽位（小写字母数字与 `._-`，最长 64）。 */
export const SLOT_RE = /\[slot:([a-z0-9][a-z0-9._-]{0,63})\]/

/** `[supersedes:xxxxxxxx]` — 本条取代的条目身份。 */
export const SUPERSEDES_RE = /\[supersedes:([0-9a-f]{8})\]/

/** `[deprecated:xxxxxxxx]` / `[deprecated]` — 条目已失效（括号内为取代者）。 */
export const DEPRECATED_RE = /\[deprecated(?::([0-9a-f]{8}))?\]/

/**
 * 把用户/模型给的槽位名归一化成合法 slug。
 * 非法字符折成 `-`，连续折叠，去首尾，截断 64。名字为空或归一化后为空 ⇒ 拒绝。
 * @param {unknown} raw
 * @returns {{ok: true, slug: string} | {ok: false, reason: string}}
 */
export function normalizeSlot(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === '') return { ok: false, reason: 'empty' }
  const slug = text
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64)
  if (slug === '') return { ok: false, reason: 'empty-after-normalize' }
  return { ok: true, slug }
}

/**
 * 解析一条条目的生命周期字段。**只认条目头部**（身份证之后的一小段前缀），
 * 避免正文里出现的 `[slot:x]` 字样被当成真实标记。
 * @param {string} entry - 完整条目原文。
 * @returns {{id: string|null, slot: string|null, supersedes: string|null, deprecatedBy: string|null, deprecated: boolean}}
 */
export function parseLifecycle(entry) {
  const text = String(entry ?? '')
  const id = extractEntryId(text)
  // 头部 = 剥掉身份证后的前 200 字符（三个标记都很短，200 足够且不会伸进正文中段）
  const head = stripEntryId(text).slice(0, 200)
  const slot = SLOT_RE.exec(head)
  const sup = SUPERSEDES_RE.exec(head)
  const dep = DEPRECATED_RE.exec(head)
  return {
    id,
    slot: slot === null ? null : slot[1],
    supersedes: sup === null ? null : sup[1],
    deprecatedBy: dep === null ? null : (dep[1] ?? null),
    deprecated: dep !== null,
  }
}

/** 条目是否仍有效（未被取代）。 */
export function isActive(entry) {
  return !DEPRECATED_RE.test(stripEntryId(String(entry ?? '')).slice(0, 200))
}

/** 只保留仍有效的条目（注入面用）。 */
export function filterActive(entries = []) {
  return entries.filter((entry) => isActive(entry))
}

/**
 * 在条目最前（身份证之后）插入生命周期标记。幂等：已带同值标记则不重复插。
 * 顺序固定为 `[id] [slot] [supersedes] [deprecated] [日期] 正文`，便于机械解析与 diff。
 * @param {string} entry - 完整条目原文。
 * @param {{slot?: string|null, supersedes?: string|null, deprecatedBy?: string|null}} marks
 * @returns {string}
 */
export function withLifecycleMarks(entry, marks = {}) {
  const text = String(entry ?? '')
  const id = extractEntryId(text)
  let body = stripEntryId(text)
  const prefix = id === null ? '' : `[id:${id}] `
  if (marks.slot && !SLOT_RE.test(body.slice(0, 200))) body = `[slot:${marks.slot}] ${body}`
  if (marks.supersedes && !SUPERSEDES_RE.test(body.slice(0, 200))) body = `[supersedes:${marks.supersedes}] ${body}`
  if (marks.deprecatedBy && !DEPRECATED_RE.test(body.slice(0, 200))) body = `[deprecated:${marks.deprecatedBy}] ${body}`
  return `${prefix}${body}`
}

/**
 * 把一条标记为失效（被 `byId` 取代）。无身份证的旧条目会先按内容哈希补一个
 * 确定性身份证（`legacyIdFor`，同内容同 ID，双设备一致），否则取代边无从指向。
 * @param {string} entry
 * @param {string|undefined} byId - 取代者的 8 位 id；缺省写 `[deprecated]`。
 * @returns {{entry: string, id: string, backfilled: boolean}}
 */
export function deprecateEntry(entry, byId) {
  const text = String(entry ?? '')
  const existing = extractEntryId(text)
  const backfilled = existing === null
  const id = existing ?? legacyIdFor(text)
  let body = stripEntryId(text)
  const mark = DEPRECATED_RE.exec(body.slice(0, 200))
  if (mark === null) {
    body = `${byId ? `[deprecated:${byId}]` : '[deprecated]'} ${body}`
  } else if (mark[1] === undefined && byId) {
    // 已有一个无主的 [deprecated]，这次知道是谁取代的 ⇒ 升级一次（之后幂等）
    body = body.replace(DEPRECATED_RE, `[deprecated:${byId}]`)
  }
  return { entry: `[id:${id}] ${body}`, id, backfilled }
}

/**
 * 一条轨道的生命周期报告。**三个数字分开报**（机械确定 vs 文本候选），
 * 因为它们的可信度不同，混在一起会让"0"变得没有意义。
 * @param {string[]} entries - 该轨的全部条目（含 deprecated）。
 * @param {{legacyScan?: boolean}} [opts] - legacyScan 打开时才做文本候选反查（较贵）。
 * @returns {{total: number, active: number, deprecated: number, slots: number,
 *   sameSlotMultiActive: number, supersedesEdgeUnresolved: number,
 *   legacySupersedesCandidates: number, details: object}}
 */
export function trackLifecycle(entries = [], { legacyScan = true } = {}) {
  const parsed = entries.map((entry) => ({ entry, ...parseLifecycle(entry) }))
  const byId = new Map()
  for (const item of parsed) if (item.id !== null) byId.set(item.id, item)

  const slotCount = new Map()
  for (const item of parsed) {
    if (!item.deprecated && item.slot !== null) {
      slotCount.set(item.slot, (slotCount.get(item.slot) ?? 0) + 1)
    }
  }
  const sameSlotMultiActive = [...slotCount.values()].filter((n) => n > 1).length

  // 机械边：新条写着 supersedes:X，但 X 仍 active ⇒ 未落实
  const unresolved = []
  for (const item of parsed) {
    if (item.supersedes === null) continue
    const target = byId.get(item.supersedes)
    if (target === undefined) continue // 目标已归档/不存在：不算未落实
    if (!target.deprecated) unresolved.push({ supersedes: item.supersedes, by: item.id })
  }

  const details = {
    multiActiveSlots: [...slotCount.entries()].filter(([, n]) => n > 1).map(([slot, n]) => ({ slot, active: n })),
    unresolved,
    legacy: [],
  }

  let legacyCandidates = 0
  if (legacyScan) {
    // 文本候选：条目自己写着"supersedes/修正/已过时"，且同轨能查到一条仍 active 的
    // 更早条目包含它提到的短语。**会误报**，所以只作为清理入口。
    const CLAIM_RE = /(?:supersedes|取代|修正上一条|更正上一条|修正|更正|已过时)\s*[「“"]([^」”"]{6,60})[」”"]/
    for (const item of parsed) {
      const claim = CLAIM_RE.exec(item.entry)
      if (claim === null) continue
      const phrase = claim[1].trim()
      const alive = parsed.find((other) => other !== item && !other.deprecated && other.entry.includes(phrase))
      if (alive !== undefined) {
        legacyCandidates += 1
        details.legacy.push({ phrase, by: item.id, stillActive: alive.id })
      }
    }
  }

  return {
    total: parsed.length,
    active: parsed.filter((item) => !item.deprecated).length,
    deprecated: parsed.filter((item) => item.deprecated).length,
    slots: slotCount.size,
    sameSlotMultiActive,
    supersedesEdgeUnresolved: unresolved.length,
    legacySupersedesCandidates: legacyCandidates,
    details,
  }
}
