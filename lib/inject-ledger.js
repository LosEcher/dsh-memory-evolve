/**
 * Injection ledger (M2) — one append-only JSON line per snapshot **render call**.
 *
 * ⚠️ 一条事件 = 一次 render **调用**，不是一次注入。实测（2026-10-22，单个交互
 * 会话 40 分钟窗口，三口径同批）：
 *   - 318 次 render 调用        ← 本账本记的就是这个
 *   - 164 种不同渲染文本        ← 读取端按签名折叠重复调用后
 *   - **46 次日志里真的出现注入块** ← 原始会话日志里数「长期记忆」段落标题
 * ⇒ **调用 ≠ 注入，差约 7 倍**。DSH 会反复调用快照 provider 来计算文本，
 *   只在其认为变化时才把块追加进上下文，而且**不回告哪次被接受**。
 *   所以这个字段名是 `snapshot.render`（不是 materialize、更不是 inject）：
 *   把行数当注入次数会高估一个数量级，那正是本项目反复踩的"口径错位"。
 *   需要真实注入次数时，用读取端的 `--cross-check <sessionId>` 去数日志。
 *
 * 为什么仍然值得逐次记：调用密度本身是有用信号（渲染路径变多变少立刻可见），
 * 而且 `chars.total`/`keyIds` 在每次调用都是当次真实值。
 *
 * What it answers (none of these were answerable before):
 *   1. injection cost — total chars / per-track entry counts over time;
 *   2. entry hit rate — which KEY entries appear in `keyIds` (the reverse:
 *      never rendered in 90 days ⇒ merge or archive candidate);
 *   3. "why didn't the model know X" — no event ⇒ the plugin/host never
 *      loaded; event without the id ⇒ not selected; id in `dropped` ⇒
 *      budget-trimmed (SUMMARY mode has no per-entry drop yet, so `dropped`
 *      stays empty until budget logic lands — kept for forward compat).
 *
 * Failure policy: **fail-open but loud**. A ledger write must never break
 * memory injection (the snapshot is far more important than its telemetry),
 * but the failure has to be visible — silent telemetry loss is exactly the
 * class of bug this ledger exists to expose.
 *
 * Storage: `<memoryDir>/events/injections-YYYY-MM.jsonl`, monthly rotation,
 * `O_APPEND` single-line writes (atomic for writes well under PIPE_BUF; each
 * line is < 8 KiB even with 200 key ids).
 *
 * ## 采样（schema 2）：内容没变就不必逐次落行
 *
 * 实测 2026-10-22→10-28：18,375 行 / 41 MB，但按形状签名只有 204 种 ——
 * 快照在两步之间通常**逐字相同**，逐次落行只是把同一份事实抄了 90 遍。
 * 现在 `renderHash`（渲染文本的 sha1 前 12 位）随事件传入时按下面规则落行：
 *   - **内容变了** ⇒ 立即落行（`sampled:false`）；
 *   - **内容没变** ⇒ 每 `DEFAULT_SAMPLE_EVERY` 次调用落一行（`sampled:true`），
 *     其余返回 `{ok:true, skipped:true}` 不写盘。
 * 被合并掉的调用次数没有丢：每条落行的 `callsSinceLast` 就是"这一行代表
 * 多少次渲染调用"，读取端 `Σ callsSinceLast` 即真实调用密度。
 * 不带 `renderHash` 的调用（旧调用方/测试）行为不变：逐次落行。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const INJECTION_LEDGER_SCHEMA = 2
/** Cap recorded ids so one line can never grow without bound. */
export const MAX_RECORDED_IDS = 200
/** 内容未变时每 N 次渲染落一行（密度由 `callsSinceLast` 补回）。 */
export const DEFAULT_SAMPLE_EVERY = 20

/** 每会话采样状态：sessionId → { hash, calls }。进程内，重启即重置。 */
const SAMPLER = new Map()

/** 测试/诊断用：清空采样状态（跨用例不得互相影响）。 */
export function resetInjectionSampler() {
  SAMPLER.clear()
}

/**
 * 决定这一次渲染调用是否落行。纯内存，不做 IO。
 * @param {object} meta - 传给 appendInjectionEvent 的元数据。
 * @param {{ every?: number }} [opts]
 * @returns {{ record: boolean, sampled: boolean, callsSinceLast: number }}
 */
export function decideLedgerRecord(meta = {}, opts = {}) {
  const every = Number.isInteger(opts.every) && opts.every > 0 ? opts.every : DEFAULT_SAMPLE_EVERY
  const sessionId = typeof meta.sessionId === 'string' && meta.sessionId !== '' ? meta.sessionId : '(none)'
  const hash = typeof meta.renderHash === 'string' && meta.renderHash !== '' ? meta.renderHash : null
  const state = SAMPLER.get(sessionId) ?? { hash: null, calls: 0 }
  state.calls += 1
  // 没有 hash ⇒ 无从判断"内容是否变化" ⇒ 保持旧行为（逐次落行）。
  if (hash === null) {
    SAMPLER.set(sessionId, { hash: null, calls: 0 })
    return { record: true, sampled: false, callsSinceLast: 0 }
  }
  const changed = state.hash !== hash
  if (!changed && state.calls < every) {
    SAMPLER.set(sessionId, state)
    return { record: false, sampled: false, callsSinceLast: state.calls }
  }
  const callsSinceLast = state.calls
  SAMPLER.set(sessionId, { hash, calls: 0 })
  return { record: true, sampled: !changed, callsSinceLast }
}

/** `YYYY-MM` for a given epoch ms (local time — the ledger is read by humans). */
export function monthKey(ts = Date.now()) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function injectionLedgerPath(memoryDir, ts = Date.now()) {
  return join(memoryDir, 'events', `injections-${monthKey(ts)}.jsonl`)
}

/**
 * Normalize a raw meta object into the ledger's stable shape.
 * Pure: no IO, so it is directly unit-testable.
 */
export function buildInjectionEvent(meta = {}, { ts = Date.now() } = {}) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0)
  const entries = meta.entries ?? {}
  const chars = meta.chars ?? {}
  const ids = Array.isArray(meta.keyIds) ? meta.keyIds.filter((x) => typeof x === 'string' && x !== '') : []
  return {
    ts: new Date(ts).toISOString(),
    op: 'snapshot.render',
    schema: INJECTION_LEDGER_SCHEMA,
    sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    branch: typeof meta.branch === 'string' ? meta.branch : null,
    subagent: meta.subagent === true,
    entries: {
      memory: num(entries.memory),
      user: num(entries.user),
      key: num(entries.key),
    },
    chars: {
      total: num(chars.total),
      key: num(chars.key),
      // 全局记忆/用户档案块的字符数（schema 2）：没有它就无法回答
      // "注入体积是记忆涨了还是 KEY 涨了"。
      memory: num(chars.memory),
      user: num(chars.user),
    },
    keyMode: meta.keyMode === 'summary' ? 'summary' : (meta.keyMode === 'full' ? 'full' : null),
    // 全局轨的注入模式（schema 2）：与 keyMode 同义，但两条轨独立配置。
    memoryMode: meta.memoryMode === 'summary' ? 'summary' : (meta.memoryMode === 'full' ? 'full' : null),
    userMode: meta.userMode === 'summary' ? 'summary' : (meta.userMode === 'full' ? 'full' : null),
    // 渲染文本的内容指纹（sha1 前 12 位）：读取端用它把"同文重复调用"折叠掉。
    renderHash: typeof meta.renderHash === 'string' && /^[0-9a-f]{8,40}$/.test(meta.renderHash) ? meta.renderHash : null,
    // 这一行代表多少次渲染调用（采样合并掉的调用数）；sampled=内容未变时的采样行。
    callsSinceLast: num(meta.callsSinceLast),
    sampled: meta.sampled === true,
    tracks: {
      daily: meta.tracks?.daily !== false,
      project: meta.tracks?.project !== false,
      key: meta.tracks?.key !== false,
      review: meta.tracks?.review === true,
    },
    // Budget-trimmed entries: empty today (summary mode has no per-entry drop);
    // recorded so the field's meaning cannot drift later.
    dropped: Array.isArray(meta.dropped) ? meta.dropped.slice(0, MAX_RECORDED_IDS) : [],
    keyIds: ids.slice(0, MAX_RECORDED_IDS),
    keyIdsTruncated: ids.length > MAX_RECORDED_IDS,
    // 无前置身份证、id 由内容派生的条目数（id 不稳定，命中率统计要能剔除它们）
    keyIdsDerived: num(meta.keyIdsDerived),
  }
}

/**
 * Append one event. **Never throws**: returns `{ ok, path?, bytes?, error? }`.
 * The caller decides whether/how to surface `ok:false` (it must — see the
 * failure policy above).
 */
export function appendInjectionEvent(memoryDir, meta, opts = {}) {
  try {
    if (typeof memoryDir !== 'string' || memoryDir === '') return { ok: false, error: 'memoryDir missing' }
    const ts = opts.ts ?? Date.now()
    // 采样判定在任何 IO 之前：被合并的调用连目录都不碰。
    const decision = decideLedgerRecord(meta, opts)
    if (!decision.record) {
      return { ok: true, skipped: true, callsSinceLast: decision.callsSinceLast }
    }
    const dir = join(memoryDir, 'events')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const event = buildInjectionEvent({
      ...meta,
      callsSinceLast: decision.callsSinceLast,
      sampled: decision.sampled,
    }, { ts })
    const line = `${JSON.stringify(event)}\n`
    const path = injectionLedgerPath(memoryDir, ts)
    appendFileSync(path, line, { encoding: 'utf8' })
    let bytes = null
    try { bytes = statSync(path).size } catch { /* size is best-effort */ }
    return { ok: true, path, bytes }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read back recent events (newest last). Best-effort: a corrupt line is
 * skipped rather than failing the whole read — the ledger is append-only and
 * must stay readable after a partial write (crash mid-append).
 */
export function readInjectionEvents(memoryDir, { limit = 200 } = {}) {
  const out = []
  try {
    const dir = join(memoryDir, 'events')
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir).sort()) {
      if (!name.startsWith('injections-') || !name.endsWith('.jsonl')) continue
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* partial/corrupt line: skip */ }
      }
    }
  } catch { return out }
  return out.slice(-limit)
}
