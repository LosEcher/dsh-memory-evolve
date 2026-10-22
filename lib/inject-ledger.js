/**
 * Injection ledger (M2) — one append-only JSON line per snapshot **materialization**.
 *
 * Why "materialization" and not "injection per turn": DSH only appends the
 * runtime-context block when the rendered text *changes* (that is the whole
 * reason the snapshot is change-detected — see renderSnapshot's header
 * comment). Writing one line per turn would therefore be a lie: it would
 * report turns where nothing was injected because the previous block was
 * still cached. So the ledger records each time the text is actually
 * produced, and the timestamp gap between two lines is itself the signal
 * "the snapshot stayed stable for N minutes".
 *
 * What it answers (none of these were answerable before):
 *   1. injection cost — total chars / per-track entry counts over time;
 *   2. entry hit rate — which KEY entries appear in `keyIds` (the reverse:
 *      never materialized in 90 days ⇒ merge or archive candidate);
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
 * line is < 8 KiB even with 139 key ids).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const INJECTION_LEDGER_SCHEMA = 1
/** Cap recorded ids so one line can never grow without bound. */
export const MAX_RECORDED_IDS = 200

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
    op: 'snapshot.materialize',
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
    },
    keyMode: meta.keyMode === 'summary' ? 'summary' : (meta.keyMode === 'full' ? 'full' : null),
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
    const dir = join(memoryDir, 'events')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const line = `${JSON.stringify(buildInjectionEvent(meta, { ts }))}\n`
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
