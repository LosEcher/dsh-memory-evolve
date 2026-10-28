/**
 * dsh-memory-evolve — in-turn memory review.
 *
 * The main LLM reviews its own session (it holds the full context — no
 * subagent, no digest, no transcript reconstruction). The plugin only
 * provides the pace-maker and the write paths:
 *
 *   pace    `agent/turn-stopping` counts completed message-triggered turns per
 *           session; when the count reaches `reviewInterval` the review is
 *           DUE. The counter is never auto-reset — only the model's
 *           `memory_review_status complete` call resets it, so a missed or
 *           interrupted review stays due on the next turn instead of being
 *           silently dropped. Subagent sessions are not counted.
 *
 *   hint    the snapshot carries a static review section (fixed text, no
 *           content) telling the model to check `memory_review_status` at the
 *           end of every turn and, when due, silently run the review: suggest
 *           global-track facts (memory_suggest) or write them directly in
 *           auto mode, optionally touch skills (skill_manage), then complete.
 *
 *   output  suggest mode appends to the SUGGESTIONS.jsonl queue (the
 *           "learned track"), confirmed by the user through the
 *           `memory_review` command or the settings panel. auto mode writes
 *           global memory directly (the main session is not gated).
 *
 * Zero runtime dependencies.
 *
 * @module dsh-memory-evolve/review
 */

import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SuggestionQueue, normalizeForMatch, todayStamp } from './store.js'
import { DECIDED_STATUSES, appendDecision, foldDecisions, readDecisions, suggestionId, autoPreviewStats, statusCounts } from './decisions.js'
import { DECISION_TARGETS, evaluateSuggestion, resolveDecisionPolicy } from './policy.js'
import { translate, getLocale, REVIEW_DICT, REVIEW_CMD_DICT, MISC_DICT } from './i18n.js'

/** Translate through the REVIEW_DICT dictionary in the active locale. */
const rt = (key, params) => translate(REVIEW_DICT, key, params)
const _t = (dict, key, params) => {
  const hit = translate(dict, key, params, getLocale())
  return hit === key ? undefined : hit
}
/** Translate through REVIEW_CMD_DICT (falling back to MISC_DICT) in the active host locale. */
const rct = (key, params) => _t(REVIEW_CMD_DICT, key, params) ?? translate(MISC_DICT, key, params, getLocale())

// ---------------------------------------------------------------------------
// 决策台账接线（P0，2026-10-28）
//
// 队列是**派生视图**：真源是 `<queue 所在目录>/decisions.jsonl`。三条纪律：
//   1. 只由本模块（host 单写者）追加，presenter 一律不得写文件；
//   2. 追加失败 **fail-open**（写台账失败不能回滚已经发生的记忆写入）；
//   3. 已决定的 id 不再问第二遍（多 presenter 并发时，第二个调用者拿到的是
//      "already decided" 而不是重复写入）。
// ---------------------------------------------------------------------------

/** The memory dir that owns a suggestion queue (`<memoryDir>/SUGGESTIONS.jsonl`). */
function memoryDirOf(queue) {
  return dirname(queue.file)
}

/** Fold the ledger into `id → decision`. Missing ledger ⇒ empty map. */
function decisionState(queue) {
  try {
    return foldDecisions(readDecisions(memoryDirOf(queue)))
  } catch {
    return new Map()
  }
}

/** Append one decision row; returns the raw append result (never throws). */
function recordDecision(queue, fields) {
  const result = appendDecision(memoryDirOf(queue), fields)
  return result
}

const PENDING_COUNT_CACHE = { mtime: -1, file: null, count: 0 }

/**
 * How many suggestions are pending — used by the snapshot hint.
 * Cheap: one `statSync`; the JSONL is only re-parsed when its mtime moves.
 * @param {string} memoryDir
 * @returns {number}
 */
export function pendingSuggestionCount(memoryDir) {
  const file = join(memoryDir, 'SUGGESTIONS.jsonl')
  try {
    const { mtimeMs } = statSync(file)
    if (file === PENDING_COUNT_CACHE.file && mtimeMs === PENDING_COUNT_CACHE.mtime) return PENDING_COUNT_CACHE.count
    const count = new SuggestionQueue(file).read().length
    PENDING_COUNT_CACHE.file = file
    PENDING_COUNT_CACHE.mtime = mtimeMs
    PENDING_COUNT_CACHE.count = count
    return count
  } catch {
    return 0
  }
}


/**
 * True when the agent's most recent turn was a true user-message turn.
 *
 * 判定来源（供 review 计数与写入看门狗共享，两个计数器口径必须一致）：
 * - DSH 0.1.2 的 `turn/start` 事件 data 固定只有 `{ turn }`（官方
 *   SessionEventMap 实锚），**不存在 trigger 字段**——不能按 trigger 判；
 * - 改按「该回合第一个 user/message 事件的 `data.source.kind`」判定：
 *   `source.kind === 'user'` = 真人驱动回合；`source.kind === 'plugin'`
 *   = 注入/唤醒回合（broadcast wake 的 followup、COI wakeOnComplete、
 *   agent.inject 等）——这类回合不是用户消息，不计入轮次（2026-09-04，
 *   PR #37 评审 P1-3：followup 唤醒的回合不能算作用户回合）；
 * - ⚠ DSH 0.1.2-alpha.4+ 的 Session 不再暴露 `.events`：
 *   `ownEvents?.() ?? .events ?? []`（#38 适配）；
 * - 老日志形状（user/message 无 source）按用户回合兜底（旧语义兼容）。
 *
 * @param {object} agent - the agent whose session events are scanned.
 * @returns {boolean} whether the latest turn was a human-message turn.
 */
function lastTurnWasMessage(agent) {
  const events = agent.session.ownEvents?.() ?? agent.session.events ?? []
  // 该回合起点：最后一个 turn/start（从尾回扫，与回合结束时刻一致）。
  let startIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') { startIndex = index; break }
  }
  if (startIndex < 0) return false
  // 起点之后第一个 user/message 决定本轮来源（进入下一轮则防御性中断）。
  for (let index = startIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'turn/start') break // 防御：不应出现
    if (event?.type === 'user/message') {
      const kind = event.data?.source?.kind
      return kind === undefined || kind === 'user'
    }
  }
  return false
}

/**
 * Install the per-session review turn counter.
 * @param {object} ctx - a context with `on` (Cordis event bus).
 * @param {() => object} getRuntime - resolves live runtime config.
 * @returns {{turnsOf: (agent?: object) => number, complete: (agent?: object) => void}}
 *   the counter handle: `turnsOf` reads the count for one agent,
 *   `complete` resets it (called by the model after a finished review).
 */
export function reviewTurnCounter(ctx, getRuntime) {
  /** agentId → number of completed user turns since the last review. */
  const perSession = new Map()

  // 修复（2026-08-22，issue #24）：DSH 核心不发 `agent/settled`，回合
  // 正常结束时只发 `agent/turn-stopping`（packages/core/agent-loop/src/
  // agent.ts，payload={agent, turn, signal}）。原监听 `agent/settled`
  // 永不触发 → 轮次计数恒 0 → review 永不 due → 全局记忆轨永远无法
  // 产生。`agent/turn-stopping` 只在回合正常结束时触发（error/abort/
  // blocked 在 turn-stopping 之前 throw，到不了这里），天然过滤非正常
  // 回合，故不再需要 reason.kind==='completed' 判断（payload 也没有
  // reason 参数）。
  const onSettled = (payload) => {
    try {
      const agent = payload?.agent ?? payload
      if (!agent?.session) return
      if (agent.session.header.origin === 'subagent') return
      if (!getRuntime().reviewEnabled) return
      // Count only message-triggered turns (retries and injections are not
      // user turns). See lastTurnWasMessage for the issue #24 trigger notes
      // and the 2026-09-04 followup-wake tightening (P1-3).
      if (!lastTurnWasMessage(agent)) return
      const state = perSession.get(agent.id) ?? { turns: 0 }
      state.turns += 1
      // Never reset here: due stays sticky until the model completes the review
      // via `memory_review_status complete`, so a missed turn cannot silently
      // drop the review.
      perSession.set(agent.id, state)
    } catch (error) {
      // 事件回调抛异常会带崩回合（与 lib/prompts.js 同款防护）：审查
      // 计数只是节奏器，绝不能让插件异常污染回合结果。
      console.error('[memory-evolve review] turn-stopping 处理失败（已隔离，不影响回合）：', error)
    }
  }

  // 显式挂到 ctx 生命周期（P2-7）：ctx.on 返回的 disposer 交给 ctx.effect
  // 管理，插件卸载/热重载时自动移除监听器，避免重复注册导致重复计数
  ctx.effect(() => ctx.on('agent/turn-stopping', onSettled))

  return {
    turnsOf: (agent) => perSession.get(agent?.id)?.turns ?? 0,
    complete: (agent) => { perSession.delete(agent?.id) },
  }
}

/**
 * Install the write watchdog turn counter: per session, counts completed
 * message-triggered turns WITHOUT any daily/project memory write from that
 * same session. Once the gap reaches the configured threshold the snapshot
 * injects a sticky warning (renderSnapshot); the gap resets to zero the
 * moment the session successfully writes daily/project memory
 * (memoryTool addOne → noteWrite).
 *
 * Motivation (long-session drift): the per-turn write duty is a fixed hint,
 * and in long conversations models gradually stop complying — missed writes
 * were silently dropped because nothing on the program side ever noticed.
 * This counter closes that hole exactly the way the review counter closes
 * the 'never checks' hole: the program tracks compliance, and the snapshot
 * itself escalates until the model writes. The warning text is deliberately
 * static (no live count baked in) so an open gap costs at most two snapshot
 * tails (appear + disappear), the same cache price as the review due warning.
 *
 * Subagent sessions are not counted (their duty is per-achievement, not
 * per-turn). In-memory only: a host restart clears gaps — the watchdog
 * guards drift within a running process, not across restarts.
 *
 * @param {object} ctx - a context with `on` (Cordis event bus).
 * @param {() => boolean} isEnabled - live switch (false = stop counting;
 *   the snapshot warning independently re-checks config, so both halves
 *   degrade safely on their own).
 * @returns {{gapOf: (agent?: object) => number, noteWrite: (agent?: object) => void}}
 *   the counter handle: `gapOf` reads one agent's write-less turn count,
 *   `noteWrite` resets it after a successful daily/project write.
 */
export function writeGapCounter(ctx, isEnabled) {
  /** agentId → { gap, wroteThisTurn }：连续未写轮数 + 本回合已写标记。 */
  const gaps = new Map()

  const onTurnStopping = (payload) => {
    try {
      const agent = payload?.agent ?? payload
      if (!agent?.session) return
      if (agent.session.header.origin === 'subagent') return
      if (!isEnabled || !isEnabled()) return
      if (!lastTurnWasMessage(agent)) return
      const state = gaps.get(agent.id) ?? { gap: 0, wroteThisTurn: false }
      if (state.wroteThisTurn) {
        // 本回合已成功写入 daily/project（memory 工具 noteWrite 标记）：
        // 连续未写清零；标记已消费。
        // ⚠️ 时序修复（PR #37 评审 P1-2）：noteWrite **只打标记、不清零**——
        // 回合内写入先于 turn-stopping 触发，若当场清零，本回合结束时
        // turn-stopping 又把"已写回合"计成 +1（阈值 1 时每个正常回合都
        // 触发提醒、阈值 2 时漏 1 轮即误报）。
        state.gap = 0
        state.wroteThisTurn = false
      } else {
        state.gap += 1
      }
      gaps.set(agent.id, state)
    } catch (error) {
      // 与 reviewTurnCounter 同款防护：看门狗计数绝不能污染回合结果。
      console.error('[memory-evolve write-gap] turn-stopping 处理失败（已隔离，不影响回合）：', error)
    }
  }

  // 同款生命周期挂载（P2-7）：disposer 交给 ctx.effect，热重载不残留。
  ctx.effect(() => ctx.on('agent/turn-stopping', onTurnStopping))

  return {
    gapOf: (agent) => gaps.get(agent?.id)?.gap ?? 0,
    noteWrite: (agent) => {
      // 本回合已写标记（不清零，见上时序说明）；exec.agent 缺失时安全跳过。
      if (!agent?.id) return
      const state = gaps.get(agent.id) ?? { gap: 0, wroteThisTurn: false }
      state.wroteThisTurn = true
      gaps.set(agent.id, state)
    },
  }
}

/**
 * Build the `memory_review_status` tool definition. The model queries it at
 * the end of every turn; the returned `due` flag is authoritative (the
 * interval is configurable, so the snapshot hint deliberately never embeds
 * the number).
 * @param {() => object} getRuntime - resolves live runtime config.
 * @param {{turnsOf: (agent?: object) => number, complete: (agent?: object) => void}} counter
 *   the review turn counter.
 * @returns {object} a ToolDefinition-shaped object for ctx.tools.register.
 */
export function reviewStatusTool(getRuntime, counter) {
  return {
    name: 'memory_review_status',
    get description() { return rt('reviewStatus.desc') },
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'complete'],
          get description() { return rt('reviewStatus.action') },
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          due: { type: 'boolean' },
          turnsSinceReview: { type: 'integer' },
          interval: { type: 'integer' },
          mode: { type: 'string' },
          skillReviewEnabled: { type: 'boolean' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute(args, exec) {
      if (args.action === 'complete') {
        const runtime = getRuntime()
        const turns = counter.turnsOf(exec?.agent)
        if (turns < runtime.reviewInterval) {
          return { ok: true, message: rt('reviewStatus.notDue', { turns, interval: runtime.reviewInterval }) }
        }
        counter.complete(exec?.agent)
        return { ok: true, message: rt('reviewStatus.reset') }
      }
      const runtime = getRuntime()
      const turns = counter.turnsOf(exec?.agent)
      const due = turns >= runtime.reviewInterval
      const message = due
        ? rt('reviewStatus.due', { turns, interval: runtime.reviewInterval })
        : rt('reviewStatus.notDueYet', { turns, interval: runtime.reviewInterval })
      return {
        ok: true,
        message,
        due,
        turnsSinceReview: turns,
        interval: runtime.reviewInterval,
        mode: runtime.reviewMode,
        skillReviewEnabled: !!runtime.skillReviewEnabled,
      }
    },
  }
}

/**
 * Build the `memory_suggest` tool definition (suggest mode write path).
 * Repeated suggestions of the same content are deduplicated: the queue keeps
 * ONE pending entry per (target, content) and bumps its `hits` counter, so a
 * fact that keeps resurfacing in reviews accumulates a visible frequency the
 * user can weigh when confirming.
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {() => boolean} [isTodoEnabled] - live todo-capability switch
 *   (default always enabled); todo-* suggestions are refused while off.
 * @returns {object} a ToolDefinition-shaped object for ctx.tools.register.
 */
export function suggestToolDefinition(config, queue, isTodoEnabled = () => true) {
  return {
    name: config.suggestToolName,
    get description() { return rt('suggest.desc') },
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['memory', 'user', 'todo-life', 'todo-work', 'todo-project', 'todo-daily'],
          get description() { return rt('suggest.target') },
        },
        content: {
          type: 'string',
          get description() { return rt('suggest.content') },
        },
        reason: {
          type: 'string',
          get description() { return rt('suggest.reason') },
        },
      },
      required: ['target', 'content', 'reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          queued: { type: 'integer' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute(args, exec) {
      const target = args.target
      const content = String(args.content ?? '').trim()
      const reason = String(args.reason ?? '').trim()
      const validTargets = ['memory', 'user', 'todo-life', 'todo-work', 'todo-project', 'todo-daily']
      if (!validTargets.includes(target)) {
        return { ok: false, message: rt('suggest.invalidTarget', { target, valid: validTargets.join('/') }) }
      }
      // 待办能力关闭时拒绝 todo-* 目标（执行期守卫，schema 可能在开关前已生成）
      if (target.startsWith('todo-') && !isTodoEnabled()) {
        return { ok: false, code: 'TODO_DISABLED', message: '待办功能未启用' }
      }
      if (!content) return { ok: false, message: rt('suggest.emptyContent') }
      if (!reason) return { ok: false, message: rt('suggest.emptyReason') }
      // policy 只用于记录 dry-run 预演（P0 不改变行为）：让"若开启自动会怎样"
      // 从第一条建议起就有数据，而不是等打开 enforce 再猜。
      return enqueueSuggestion(queue, target, content, reason, exec?.agent, { policy: resolveDecisionPolicy(config) })
    },
  }
}

/** Collapse internal whitespace runs for suggestion dedup matching. */
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Enqueue one pending suggestion with dedup: same target + overlapping text
 * bump the existing entry's `hits` instead of stacking duplicates. Shared by
 * `memory_suggest` (review) and the memory tool's key-track writes (every
 * key write now requires user confirmation).
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {string} target - 'memory' | 'user' | 'key'.
 * @param {string} content - the suggested entry text.
 * @param {string | undefined} reason - why it is worth remembering.
 * @param {object | undefined} agent - the calling agent (id + cwd recorded).
 * @param {{policy?: object}} [options] - resolved decision policy (dry-run preview
 *   is recorded on the `proposed` row so "what would auto do" is measurable
 *   before anyone turns enforcement on).
 * @returns {{ok: boolean, message: string, queued: number, id?: string}} the outcome.
 */
export function enqueueSuggestion(queue, target, content, reason, agent, options = {}) {
  const now = new Date().toISOString()
  const id = suggestionId(target, content)
  const policy = options.policy ?? null
  const policyPreview = policy === null
    ? null
    : evaluateSuggestion(policy, { target, content, hits: 1 })
  // 已决定的 id 不再入队（2026-10-28）：否则"批准过的"会被模型的再次提议复活，
  // 而"拒绝过的"会被反复塞回来——那正是确认队列最招人烦的形态。撤销用
  // `reverted` 决策（fold 后回到 pending），此时允许重新入队。
  const known = decisionState(queue).get(id)
  if (known !== undefined && DECIDED_STATUSES.has(known.status)) {
    return {
      ok: true,
      deduped: true,
      alreadyDecided: true,
      id,
      queued: queue.read().length,
      message: rct('reviewcmd.alreadyDecidedShort', { status: known.status }),
    }
  }
  const result = queue.mutate((entries) => {
    const normalized = normalizeWhitespace(content)
    const existing = entries.find((entry) => entry.target === target
      && (normalizeWhitespace(entry.content) === normalized
        || normalizeWhitespace(entry.content).includes(normalized)
        || normalized.includes(normalizeWhitespace(entry.content))))
    if (existing) {
      existing.id = existing.id ?? suggestionId(existing.target, existing.content)
      existing.hits = (existing.hits ?? 1) + 1
      existing.lastSeen = now
      if (reason) existing.reason = reason
      return {
        ok: true,
        deduped: true,
        message: rct('reviewcmd.dedup', { hits: existing.hits }),
        queued: entries.length,
        id: existing.id,
      }
    }
    entries.push({
      id,
      time: now,
      sessionId: agent?.id ?? null,
      cwd: agent?.session?.header?.cwd ?? null,
      target,
      content,
      reason: reason ?? null,
      hits: 1,
      firstSeen: now,
      lastSeen: now,
    })
    return { ok: true, queued: entries.length, id }
  })
  // 只有"首次提出"才进台账；重复出现只 bump hits（那是一次提及，不是一次决定）。
  if (result.deduped !== true) {
    recordDecision(queue, {
      id: result.id ?? id,
      action: 'proposed',
      target,
      content,
      actor: 'model',
      policyId: policy?.policyId ?? null,
      policyPreview,
      evidence: { sessionId: agent?.id ?? null, cwd: agent?.session?.header?.cwd ?? null },
    })
  }
  return result
}

/**
 * Approve suggestions by 1-based index: write each into its memory track and
 * drop it from the queue. Project-track entries are written with the cwd they
 * were suggested under (falling back to `agent` when the entry has none).
 * A per-index `targets` map overrides the suggested target — the user can
 * re-classify a fact into a more fitting memory track (e.g. memory → key)
 * without the AI re-suggesting it; absent entries keep the recommended
 * target. Todo suggestions can NEVER be re-classified: a todo stays a todo
 * (overrides are ignored for todo-* entries); memory suggestions can only
 * move between the three memory tracks (the API rejects todo-* picks).
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {import('./todo.js').TodoStore} todoStore - the todo store (for todo-* targets).
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {number[]} indices - 1-based indices into the current queue.
 * @param {object | undefined} agent - fallback agent for cwd-less entries.
 * @param {Map<number, string> | undefined} edits - optional per-index edited
 *   content (1-based), used instead of the suggested content when present.
 * @param {Map<number, string> | undefined} targets - optional per-index target
 *   override (1-based; 'memory' | 'user' | 'key' — todo-* entries ignore it).
 * @param {{isTodoEnabled?: () => boolean, ids?: string[], editsById?: Map<string, string>,
 *   targetsById?: Map<string, string>, policyId?: string}} [options] - todo-capability
 *   switch, plus the **id-addressed** mode (2026-10-28): when `ids` is given,
 *   selection is by stable suggestion id instead of index, and ids already
 *   decided in the ledger are reported as such and dropped from the queue
 *   (idempotency across presenters — an index computed by one presenter is
 *   meaningless to another).
 * @returns {{lines: string[], remaining: number, decided: string[]}} a report for callers.
 */
export function approveSuggestions(store, todoStore, queue, indices, agent, edits, targets, options = {}) {
  const isTodoEnabled = options.isTodoEnabled ?? (() => true)
  const byId = Array.isArray(options.ids) ? options.ids : null
  const state = decisionState(queue)
  const decided = []
  const report = queue.mutate((entries) => {
    const kept = []
    const lines = []
    entries.forEach((entry, index) => {
      const number = index + 1
      const selected = byId === null ? indices.includes(number) : byId.includes(entry.id)
      if (!selected) {
        kept.push(entry)
        return
      }
      const known = state.get(entry.id)
      if (byId !== null && known !== undefined && known.status !== 'pending') {
        // 台账已决定：队列里的残余只是没来得及回收的副本，丢掉并说明原因，
        // 绝不重复写入（多 presenter 并发时正是靠这一条保证幂等）。
        lines.push(rct('reviewcmd.alreadyDecided', { n: number, id: entry.id, status: known.status }))
        return
      }
      // 待办建议只能留在待办轨（待办不能变成记忆）；记忆建议才可改分类
      const override = targets?.get(number) ?? options.targetsById?.get(entry.id)
      const target = entry.target.startsWith('todo-')
        ? entry.target
        : (override ?? entry.target)
      const writeAgent = entry.cwd
        ? { session: { header: { cwd: entry.cwd } } }
        : agent
      // An edit that is empty (or whitespace) means "no edit": fall back to the
      // suggested content instead of attempting to write an empty entry.
      const edited = (edits?.get(number) ?? options.editsById?.get(entry.id))?.trim()
      const content = edited ? edited : entry.content
      const isTodo = target.startsWith('todo-')
      if (isTodo && !isTodoEnabled()) {
        lines.push(`✗ #${number} [${target}] TODO_DISABLED：待办功能未启用`)
        kept.push(entry)
        return
      }
      let outcome
      if (isTodo) {
        outcome = todoStore.addTodo(target.slice(5), content, {}, entry.cwd ?? agent?.session?.header?.cwd)
      } else {
        try {
          // key 轨无 cwd 时 resolveTarget 会抛错——兜住并保留建议
          outcome = store.add(target, content, writeAgent)
        } catch (error) {
          outcome = { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      }
      if (outcome.duplicate === true || (!outcome.ok && (outcome.message.includes('已存在') || outcome.message.includes('already exists')))) {
        // Duplicate detection is locale-neutral: store.add returns
        // ok:true + duplicate:true for a dup, so the duplicate check must
        // come FIRST; the message-substring fallbacks cover older flows
        // that only carry localized text.
        lines.push(rct('reviewcmd.existsSkip', { n: number, target }))
        decided.push({ id: entry.id, target, content, sessionId: entry.sessionId ?? null, cwd: entry.cwd ?? null })
      } else if (outcome.ok) {
        lines.push(rct(isTodo ? 'reviewcmd.writtenTodo' : 'reviewcmd.writtenMemory', { n: number, target }))
        decided.push({ id: entry.id, target, content, sessionId: entry.sessionId ?? null, cwd: entry.cwd ?? null })
      } else {
        lines.push(rct('reviewcmd.failed', { n: number, target, detail: outcome.message }))
        kept.push(entry)
      }
    })
    entries.length = 0
    entries.push(...kept)
    return { lines, remaining: kept.length }
  })
  // 台账在锁外追加：写台账失败不能回滚已经发生的记忆写入（fail-open）。
  for (const item of decided) {
    recordDecision(queue, {
      id: item.id,
      action: 'approved',
      target: item.target,
      content: item.content,
      actor: 'user',
      policyId: options.policyId ?? null,
      evidence: { sessionId: item.sessionId, cwd: item.cwd },
    })
  }
  return { ...report, decided: decided.map((item) => item.id) }
}

/**
 * Reject suggestions: drop them from the queue and record the rejection.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {number[]} indices - 1-based indices into the current queue (ignored when `options.ids` is set).
 * @param {{ids?: string[], policyId?: string, reason?: string}} [options] - id-addressed mode.
 * @returns {{removed: number, remaining: number, rejected: string[]}} a report for callers.
 */
export function rejectSuggestions(queue, indices, options = {}) {
  const byId = Array.isArray(options.ids) ? options.ids : null
  const rejected = []
  const report = queue.mutate((entries) => {
    const kept = []
    let removed = 0
    entries.forEach((entry, index) => {
      const selected = byId === null ? indices.includes(index + 1) : byId.includes(entry.id)
      if (selected) {
        removed += 1
        rejected.push({ id: entry.id, target: entry.target, content: entry.content, sessionId: entry.sessionId ?? null, cwd: entry.cwd ?? null })
      } else kept.push(entry)
    })
    entries.length = 0
    entries.push(...kept)
    return { removed, remaining: kept.length }
  })
  for (const item of rejected) {
    recordDecision(queue, {
      id: item.id,
      action: 'rejected',
      target: item.target,
      content: item.content,
      actor: 'user',
      policyId: options.policyId ?? null,
      evidence: { sessionId: item.sessionId, cwd: item.cwd },
    })
  }
  return { ...report, rejected: rejected.map((item) => item.id) }
}


/**
 * Archive suggestions by 1-based index: keep the content (with its reason)
 * in the low-priority archive files instead of writing it into the injected
 * tracks or dropping it. The suggestion leaves the queue; the archived entry
 * can later be promoted back into a main track or deleted from the panel.
 * @param {import('./store.js').ArchiveStore} archive - the archive store.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {number[]} indices - 1-based indices into the current queue.
 * @returns {{lines: string[], remaining: number}} a report for callers.
 */
export function archiveSuggestions(archive, queue, indices, options = {}) {
  const byId = Array.isArray(options.ids) ? options.ids : null
  const archived = []
  const report = queue.mutate((entries) => {
    const kept = []
    const lines = []
    entries.forEach((entry, index) => {
      const number = index + 1
      const selected = byId === null ? indices.includes(number) : byId.includes(entry.id)
      if (!selected) {
        kept.push(entry)
        return
      }
      // todo-* 建议统一归档到 TODO-archive.md；条目内记录原轨，转正时写回
      // 对应待办轨（归档文件不按轨分文件，必须自描述）。
      const originTag = entry.target.startsWith('todo-') ? `\n（原轨：${entry.target}）` : ''
      const stamped = `[${todayStamp()}] ${entry.content}${originTag}${entry.reason ? `\n（归档理由：${entry.reason}）` : ''}`
      // key 建议归档到该项目的 KEY-archive.md（随项目走）
      const outcome = archive.append(entry.target, stamped, entry.cwd ?? undefined)
      if (outcome.ok) {
        lines.push(`📦 #${number} [${entry.target}] 已归档（不注入，可随时移回主记忆）`)
        archived.push({ id: entry.id, target: entry.target, content: entry.content, sessionId: entry.sessionId ?? null, cwd: entry.cwd ?? null })
      } else {
        lines.push(`✗ #${number} [${entry.target}] ${outcome.message}`)
        kept.push(entry)
      }
    })
    entries.length = 0
    entries.push(...kept)
    return { lines, remaining: kept.length }
  })
  for (const item of archived) {
    recordDecision(queue, {
      id: item.id,
      action: 'archived',
      target: item.target,
      content: item.content,
      actor: 'user',
      policyId: options.policyId ?? null,
      evidence: { sessionId: item.sessionId, cwd: item.cwd },
    })
  }
  return { ...report, archived: archived.map((item) => item.id) }
}

/**
 * Promote one archived entry back into its main track: strip the program
 * stamp and the archive reason, then add the plain content (the store
 * re-stamps it with the current date). Branch-scope tags ([branch:…]) on key
 * entries survive the round-trip. The archived entry is removed on success.
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {import('./todo.js').TodoStore} todoStore - the todo store (for todo-* targets).
 * @param {import('./store.js').ArchiveStore} archive - the archive store.
 * @param {string} target - 'memory' | 'user' | 'key' | 'todo-*'.
 * @param {string} match - a substring uniquely identifying one archived entry.
 * @param {string | undefined} cwd - project cwd (required for 'key' / 'todo-project').
 * @returns {{ok: boolean, message: string}} the outcome.
 */
export function promoteArchived(store, todoStore, archive, target, match, cwd) {
  const entries = archive.entriesOf(target, cwd)
  // 两侧归一化（issue #59）：归档页回传的是**展示文本**（已剥 `[id:…]` /
  // `[summary:…]`），而归档文件里存的是含元数据的原文。直接在原文上
  // `includes(展示文本)` 会因为 `[日期] [summary:…] 正文` 中间插了元数据
  // 而断链，表现为「归档中没有条目包含片段 …」。保持既有子串语义（0 条 /
  // 多条都拒绝），只把比较基准对齐。
  const needle = normalizeForMatch(match)
  const hits = entries.filter((entry) => normalizeForMatch(entry).includes(needle))
  if (hits.length === 0) return { ok: false, message: rct('misc.archiveNoMatch', { match }) }
  if (hits.length > 1) {
    return { ok: false, message: rct('misc.archiveMultiMatch', { match, count: hits.length }) }
  }
  const raw = hits[0]
  // todo 归档条目带（原轨：todo-*）标记，转正写回对应待办轨
  const origin = /（原轨：([a-z-]+)）/.exec(raw)
  const writeTarget = target.startsWith('todo-') && origin ? origin[1] : target
  const content = raw
    .replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '')
    // 理由行在最后、原轨行在理由前：先剥理由，原轨行随后也落到行尾
    .replace(/\n（归档理由：[\s\S]*?）\s*$/, '')
    .replace(/\n（原轨：[^\n]*）\s*$/, '')
    .trim()
  if (!content) return { ok: false, message: rct('misc.promoteEmpty') }
  const writeAgent = cwd ? { session: { header: { cwd } } } : undefined
  const outcome = writeTarget.startsWith('todo-')
    ? todoStore.addTodo(writeTarget.slice(5), content, {}, cwd)
    : store.add(writeTarget, content, writeAgent)
  if (!outcome.ok) return outcome
  // 清理归档文件走 ArchiveStore.remove（同样两侧归一化）。**必须与上面的
  // hits 用同一套基准**：只修 hits 不修这里的话，转正是成功的，但归档里
  // 那条删不掉 → 同一内容同时留在主轨与归档；而下面不看返回值，不会有任何
  // 报错提示（issue #59 明确点名的半吊子修复）。
  archive.remove(target, match, cwd)
  return { ok: true, message: rct('misc.promoted', { target: writeTarget, chars: content.length }) }
}

/**
 * Build the `memory_review` slash-command definition.
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {import('./store.js').ArchiveStore} archive - the archive store.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @returns {object} a CommandDefinition-shaped object for ctx.commands.register.
 */
export function reviewCommand(config, store, todoStore, archive, queue) {
  const formatEntry = (entry, index) => rct('reviewcmd.entryLine', {
    i: index + 1,
    id: entry.id ?? '',
    target: entry.target,
    content: entry.content,
    reason: entry.reason ?? rct('reviewcmd.noReason'),
  })
  const effectivePolicy = () => resolveDecisionPolicy(config)

  /**
   * 选择集：`1 2` = 下标；`#a1b2c3d4` = 稳定 id。两种混用一律拒绝——混着写
   * 时"第 2 条"和"某条 id"到底指哪个是不确定的，宁可报错也不要批错条目。
   * @returns {{ids: string[], indices: number[]}|null}
   */
  const splitSelection = (tokens) => {
    const ids = []
    const indices = []
    for (const token of tokens) {
      if (token.startsWith('#')) {
        const id = token.slice(1)
        if (!/^[0-9a-f]{8}$/.test(id)) return null
        ids.push(id)
      } else if (/^\d+$/.test(token)) {
        const n = Number(token)
        if (!Number.isInteger(n) || n < 1) return null
        indices.push(n)
      } else return null
    }
    if (ids.length > 0 && indices.length > 0) return null
    return { ids, indices }
  }

  const reportText = (report) => `${report.lines.join('\n')}\n${rct('reviewcmd.remaining', { count: report.remaining })}`

  return {
    name: config.commandName,
    description: '查看和管理记忆审查产生的建议：list 列出（带稳定 id），approve <序号|#id> 采纳，archive <序号|#id> 归档（保留备查，可移回主记忆），reject <序号|#id> 拒绝，approve-all / reject-all 批量处理，policy 查看生效的决策策略与 dry-run 预演',
    input: {
      syntax: 'list | approve <n|#id>… | archive <n|#id>… | reject <n|#id>… | approve-all | reject-all | policy',
      hint: '不填参数时默认 list',
    },
    handler(invocation) {
      const tokens = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const op = (tokens[0] ?? 'list').toLowerCase()
      const selection = splitSelection(tokens.slice(1))

      switch (op) {
        case 'list': {
          const entries = queue.read()
          if (entries.length === 0) return { kind: 'success', text: rct('reviewcmd.emptyQueue') }
          const lines = entries.map(formatEntry)
          return { kind: 'success', text: rct('reviewcmd.listHead', { count: entries.length }) + '\n' + lines.join('\n') }
        }
        case 'policy': {
          // 生效值就是这份报告的判据：配置里写的 ≠ 实际生效的（配置≠生效纪律）。
          const active = effectivePolicy()
          const targets = DECISION_TARGETS.map((target) => `${target}=${active.actions[target]}`).join(', ')
          const overrides = Object.entries(active.overrides).map(([key, value]) => `${key}=${value}`).join(', ')
          const folded = foldDecisions(readDecisions(memoryDirOf(queue)))
          const counts = statusCounts(folded)
          const preview = autoPreviewStats(folded)
          const reasons = Object.entries(preview.byReason).map(([reason, n]) => `${reason}×${n}`).join(', ')
          const lines = [
            rct('reviewcmd.policyHead'),
            `- ${rct('reviewcmd.policySummary', { preset: active.preset, mode: active.mode, ttl: active.ttlDays })}`,
            `- ${rct('reviewcmd.policyTargets', { list: targets })}`,
            `- ${rct('reviewcmd.policyOverrides', { list: overrides === '' ? '—' : overrides })}`,
            `- ${rct('reviewcmd.policyGates', { patterns: active.autoApply.denyPatterns.length, max: active.autoApply.maxChars, hits: active.autoApply.requireHits })}`,
            `- ${rct('reviewcmd.policyLedger', { counts: Object.entries(counts).map(([status, n]) => `${status}=${n}`).join(' ') })}`,
            `- ${rct('reviewcmd.policyPreview', { auto: preview.wouldAuto, confirm: preview.wouldConfirm, reasons: reasons === '' ? '' : `（${reasons}）` })}`,
            rct('reviewcmd.policyEnforceNote'),
          ]
          return { kind: 'success', text: lines.join('\n') }
        }
        case 'approve': {
          if (selection === null || (selection.ids.length === 0 && selection.indices.length === 0)) {
            return { kind: 'error', text: rct('reviewcmd.usageApprove') }
          }
          const report = approveSuggestions(store, todoStore, queue, selection.indices, invocation.agent, undefined, undefined, {
            ids: selection.ids.length > 0 ? selection.ids : undefined,
            policyId: effectivePolicy().policyId,
          })
          return { kind: 'success', text: reportText(report) }
        }
        case 'archive': {
          if (selection === null || (selection.ids.length === 0 && selection.indices.length === 0)) {
            return { kind: 'error', text: rct('reviewcmd.usageArchive') }
          }
          const report = archiveSuggestions(archive, queue, selection.indices, {
            ids: selection.ids.length > 0 ? selection.ids : undefined,
            policyId: effectivePolicy().policyId,
          })
          return { kind: 'success', text: reportText(report) }
        }
        case 'reject': {
          if (selection === null || (selection.ids.length === 0 && selection.indices.length === 0)) {
            return { kind: 'error', text: rct('reviewcmd.usageReject') }
          }
          const report = rejectSuggestions(queue, selection.indices, {
            ids: selection.ids.length > 0 ? selection.ids : undefined,
            policyId: effectivePolicy().policyId,
          })
          return {
            kind: 'success',
            text: rct('reviewcmd.rejectedSome', { count: report.removed, remaining: report.remaining }),
          }
        }
        case 'approve-all': {
          const all = Array.from({ length: queue.read().length }, (_, i) => i + 1)
          const report = approveSuggestions(store, todoStore, queue, all, invocation.agent, undefined, undefined, {
            policyId: effectivePolicy().policyId,
          })
          return { kind: 'success', text: reportText(report) }
        }
        case 'reject-all': {
          const report = rejectSuggestions(queue, Array.from({ length: queue.read().length }, (_, i) => i + 1), {
            policyId: effectivePolicy().policyId,
          })
          return { kind: 'success', text: rct('reviewcmd.rejectedAll', { count: report.removed }) }
        }
        default:
          return { kind: 'error', text: rct('misc.unknownOp', { op }) }
      }
    },
  }
}
