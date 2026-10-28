/**
 * 决策台账（`<memoryDir>/decisions.jsonl`）—— 待确认建议的 **append-only 权威历史**。
 *
 * ## 为什么需要（P0，2026-10-28）
 *
 * 旧实现的 `approve` 会把条目从 `SUGGESTIONS.jsonl` 里**直接删掉**：决定历史归零，
 * 于是"谁在什么时候批准/拒绝了什么、依据哪条策略"完全不可考。一旦出现多个
 * presenter（tab / composer chip / slash 命令 / 工具），还会叠加一个更硬的
 * 问题——仅靠**下标**寻址无法跨调用者对齐，后到的调用者会批准到别的条目。
 *
 * ## 契约
 *
 * 1. **append-only**：只追加，不改不删。`SUGGESTIONS.jsonl` 从此是**派生视图**
 *    （由 fold 出的 pending 集合决定），不是真源。
 * 2. 每条决策按 `id` 聚合。`id = sha1(target + "\0" + 归一化正文)` 前 8 位：
 *    同一条建议无论在哪个 presenter 里出现，id 都一样；正文改了就换 id（这正是
 *    "逐字节不同的事实"应有的语义）。
 * 3. **fold 必须乱序收敛**：同一组事件按任意顺序 fold 出同一结果（comparator
 *    用 `(ts, 动作等级, 原始行)` 三重键，不依赖文件顺序）。否则"读了半张台账"
 *    会得到假状态，而假状态会被当成"未决定"再问用户一次。
 * 4. **fail-open**：写台账失败绝不能回滚已经发生的记忆写入——返回 `ok:false`
 *    由调用方决定怎么呈现（与 injection-ledger 同一纪律）。
 *
 * @module dsh-memory-evolve/decisions
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Schema version of one decision row (bump when a field changes meaning). */
export const DECISIONS_SCHEMA = 1

/** Every action a decision row may carry. */
export const DECISION_ACTIONS = ['proposed', 'approved', 'rejected', 'archived', 'expired', 'auto_applied', 'reverted']

/**
 * Action rank — decides which row wins when two rows for the SAME id carry the
 * same timestamp (only reachable with hand-edited/pasted ledgers, but the fold
 * must still be deterministic). Higher rank wins.
 */
const ACTION_RANK = {
  proposed: 0,
  approved: 1,
  auto_applied: 1,
  rejected: 1,
  archived: 1,
  expired: 1,
  reverted: 2,
}

/** Map a ledger action onto the suggestion's lifecycle status. */
export function statusForAction(action) {
  switch (action) {
    case 'approved': return 'approved'
    case 'auto_applied': return 'applied'
    case 'rejected': return 'rejected'
    case 'archived': return 'archived'
    case 'expired': return 'expired'
    case 'reverted': return 'pending'
    case 'proposed': return 'pending'
    default: return 'pending'
  }
}

/** Statuses that mean "the user/policy already decided"; a decided id must not be asked again. */
export const DECIDED_STATUSES = new Set(['approved', 'applied', 'rejected', 'archived', 'expired'])

/**
 * Collapse whitespace runs so the same fact typed with different spacing keeps
 * one identity (the queue's dedup already normalizes this way).
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeSuggestionText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Stable suggestion identity: `sha1(target + NUL + normalized content)` first 8.
 * @param {string} target - suggestion target ('memory' | 'user' | 'key' | 'todo-*').
 * @param {string} content - suggested entry text.
 * @returns {string} 8 lowercase hex chars.
 */
export function suggestionId(target, content) {
  return createHash('sha1').update(`${String(target ?? '')}\u0000${normalizeSuggestionText(content)}`).digest('hex').slice(0, 8)
}

/** Absolute path of the decisions ledger for a memory dir. */
export function decisionsPath(memoryDir) {
  return join(memoryDir, 'decisions.jsonl')
}

/**
 * Normalize one raw decision row into the ledger's stable shape. Pure.
 * @param {object} event - raw fields.
 * @param {{ ts?: number }} [opts]
 * @returns {object} normalized row (throws on an unusable action/id).
 */
export function buildDecisionEvent(event = {}, { ts = Date.now() } = {}) {
  const action = String(event.action ?? '')
  if (!DECISION_ACTIONS.includes(action)) {
    throw new Error(`decisions: 未知 action "${action}"（允许：${DECISION_ACTIONS.join('/')}）`)
  }
  const id = String(event.id ?? '')
  if (!/^[0-9a-f]{8}$/.test(id)) {
    throw new Error(`decisions: id 必须是个 8 位十六进制串，收到 "${id}"`)
  }
  const content = typeof event.content === 'string' ? event.content.slice(0, 4000) : null
  return {
    ts: new Date(ts).toISOString(),
    schema: DECISIONS_SCHEMA,
    id,
    action,
    target: typeof event.target === 'string' && event.target !== '' ? event.target : null,
    content,
    // 谁做的决定：user（人）/ model（模型提议）/ policy（策略自动）。
    actor: event.actor === 'user' || event.actor === 'policy' ? event.actor : 'model',
    // 生效策略的标识（预设 + 目标类），用于回答"为什么这条被自动处理"。
    policyId: typeof event.policyId === 'string' && event.policyId !== '' ? event.policyId : null,
    // 策略预演（dry-run）：这条在自动模式下会被怎么处理、因为哪条规则。
    policyPreview: event.policyPreview && typeof event.policyPreview === 'object'
      ? { action: String(event.policyPreview.action ?? ''), reason: String(event.policyPreview.reason ?? '') }
      : null,
    // 证据链：产生/处理这条建议的会话与工作目录（可 join 回 session-index）。
    evidence: event.evidence && typeof event.evidence === 'object'
      ? { sessionId: event.evidence.sessionId ?? null, cwd: event.evidence.cwd ?? null }
      : { sessionId: null, cwd: null },
  }
}

/**
 * Append one decision row. **Never throws** — returns `{ ok, path?, error? }`.
 * @param {string} memoryDir - memory root (the queue's directory).
 * @param {object} event - see buildDecisionEvent.
 * @param {{ ts?: number }} [opts]
 */
export function appendDecision(memoryDir, event, opts = {}) {
  try {
    if (typeof memoryDir !== 'string' || memoryDir === '') return { ok: false, error: 'memoryDir missing' }
    const row = buildDecisionEvent(event, opts)
    const path = decisionsPath(memoryDir)
    appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8' })
    return { ok: true, path, row }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read back decision rows (oldest first). Best-effort: a corrupt/partial line is
 * skipped rather than failing the read (the ledger is append-only; a crash can
 * leave half a line).
 * @param {string} memoryDir
 * @param {{ limit?: number }} [opts] - keep only the newest `limit` rows.
 * @returns {object[]}
 */
export function readDecisions(memoryDir, { limit = 1000 } = {}) {
  const out = []
  try {
    const path = decisionsPath(memoryDir)
    if (!existsSync(path)) return out
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row !== null && typeof row === 'object' && typeof row.id === 'string' && typeof row.action === 'string') out.push(row)
      } catch { /* partial/corrupt line: skip */ }
    }
  } catch { return out }
  return out.slice(-limit)
}

/** Compare two rows for the same id: `(ts, rank, raw)` — total order, order-insensitive fold. */
function newerRow(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? b : a
  const rankA = ACTION_RANK[a.action] ?? 0
  const rankB = ACTION_RANK[b.action] ?? 0
  if (rankA !== rankB) return rankA > rankB ? a : b
  // Last resort: the serialized form, so two different rows with equal keys
  // still resolve deterministically (never depend on file order).
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b
}

/**
 * Fold decision rows into `id → { status, ... }`. **Order-insensitive**: the
 * map only depends on the set of rows, never on their order (see newerRow).
 * @param {object[]} rows - decision rows (any order).
 * @returns {Map<string, {id: string, status: string, action: string, target: string|null, ts: string, actor: string, policyId: string|null, policyPreview: object|null, evidence: object}>}
 */
export function foldDecisions(rows = []) {
  const byId = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue
    const best = byId.get(row.id)
    const winner = best === undefined ? row : newerRow(best, row)
    const action = String(winner.action ?? '')
    byId.set(row.id, {
      id: row.id,
      status: statusForAction(action),
      action,
      target: winner.target ?? null,
      ts: winner.ts ?? null,
      actor: winner.actor ?? 'model',
      policyId: winner.policyId ?? null,
      policyPreview: winner.policyPreview ?? null,
      evidence: winner.evidence ?? { sessionId: null, cwd: null },
    })
  }
  return byId
}

/**
 * Counts by status — what `memory_review policy` reports.
 * @param {Map<string, {status: string}>} folded
 * @returns {Record<string, number>}
 */
export function statusCounts(folded) {
  const counts = { pending: 0, approved: 0, applied: 0, rejected: 0, archived: 0, expired: 0 }
  for (const value of folded.values()) {
    counts[value.status] = (counts[value.status] ?? 0) + 1
  }
  return counts
}

/**
 * How many proposals carry a dry-run preview of `auto`, grouped by reason —
 * the data that decides whether "enforce" is worth turning on.
 * @param {Map<string, {status: string, policyPreview: object|null}>} folded
 */
export function autoPreviewStats(folded) {
  const stats = { wouldAuto: 0, wouldConfirm: 0, byReason: {} }
  for (const value of folded.values()) {
    if (value.status !== 'pending' || value.policyPreview === null) continue
    if (value.policyPreview.action === 'auto') {
      stats.wouldAuto += 1
      const reason = value.policyPreview.reason || 'unspecified'
      stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1
    } else {
      stats.wouldConfirm += 1
    }
  }
  return stats
}

/** mtime of the decisions ledger (0 when absent) — cheap freshness probe. */
export function decisionsMtime(memoryDir) {
  try { return statSync(decisionsPath(memoryDir)).mtimeMs } catch { return 0 }
}

/** Ensure the ledger's directory exists (used by tests/first append). */
export function ensureDecisionsDir(memoryDir) {
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true })
}
