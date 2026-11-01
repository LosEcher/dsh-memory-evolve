#!/usr/bin/env node
/**
 * 记忆生命周期探针（每日 launchd 作业的入口）。
 *
 * ## 为什么是独立脚本而不是 dsh-scheduler 作业
 *
 * 它只读 `~/.dsh/memories` 并追加一行指标，不需要模型、不需要沙箱、不花额度；
 * 放进调度器会每周白烧一次模型往返（`disk-cleanup` 迁 launchd 时是同一个理由，
 * 见 dsfolder/.scheduler 的登记）。
 *
 * ## 退出码（三态纪律，`2` 不是通过）
 *
 * - `0` 全部门槛成立：`sameSlotMultiActive == 0` ∧ `supersedesEdgeUnresolved == 0` ∧ `slots > 0`
 * - `1` 有门槛不成立（真实需要关注）
 * - `2` **判不了**：读不到记忆目录 / 跑不起来 —— 绝不能折成 1 或 0
 *
 * `slots > 0` 是门槛的一部分：槽位数为 0 时那两个 0 是**空分母的 0**，
 * 只说明机制没被用起来（见 docs/lifecycle.md §4「局限①」）。
 *
 * ## 证据面（判活只认它，不认 launchd 的 out/err）
 *
 * - 日志：`~/.dsh/logs/memory-lifecycle/probe-YYYYMMDD.log`（每次运行追加一行 JSON）
 * - 状态：`~/.dsh/state/memory-lifecycle.json`（最近一次的 verdict/计数/时刻）
 *
 * 用法：
 *   node scripts/lifecycle-probe.mjs            # 体检并落一行指标
 *   node scripts/lifecycle-probe.mjs --dry-run  # 只打印，不写指标/状态
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.HOME ?? homedir()
const MEMORY_DIR = process.env.DSH_MEMORY_DIR ?? join(HOME, '.dsh', 'memories')
const LOG_DIR = join(HOME, '.dsh', 'logs', 'memory-lifecycle')
const STATE_FILE = join(HOME, '.dsh', 'state', 'memory-lifecycle.json')
const DRY_RUN = process.argv.includes('--dry-run')
// 探针要扫 key 轨（需要 cwd）；用 dsfolder 作为稳定的项目上下文，读不到就只扫 memory/user。
const PROBE_CWD = process.env.DSH_MEMORY_PROBE_CWD ?? join(HOME, 'syncfolder', 'project', 'dsfolder')

function localDate(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
}

async function main() {
  let deps
  try {
    deps = {
      index: await import('../lib/index.js'),
      store: await import('../lib/store.js'),
      review: await import('../lib/review.js'),
      todo: await import('../lib/todo.js'),
    }
  } catch (error) {
    // 判不了：插件树缺失/被改名 —— 这**不是**记忆有问题
    process.stderr.write(`memory-lifecycle-probe: 无法加载插件模块：${error instanceof Error ? error.message : error}\n`)
    return 2
  }
  const { resolveConfig } = deps.index
  const { MemoryStore, ArchiveStore, SuggestionQueue } = deps.store
  const { reviewCommand } = deps.review
  const { TodoStore } = deps.todo

  let config
  let command
  try {
    config = resolveConfig({ memoryDir: MEMORY_DIR, commandName: 'memory_review' })
    command = reviewCommand(
      config,
      new MemoryStore(MEMORY_DIR),
      new TodoStore(MEMORY_DIR),
      new ArchiveStore(MEMORY_DIR),
      new SuggestionQueue(config.suggestionsFile),
    )
  } catch (error) {
    process.stderr.write(`memory-lifecycle-probe: 初始化失败（记忆目录 ${MEMORY_DIR}）：${error instanceof Error ? error.message : error}\n`)
    return 2
  }

  const agent = { id: 'lifecycle-probe', session: { header: { cwd: PROBE_CWD } } }
  let text
  let recorded = false
  try {
    // --record 让 review 子命令自己追加 memory-metrics.jsonl（单写者就是它）
    const out = command.handler({ rawInput: DRY_RUN ? 'stale' : 'stale --record', agent })
    if (out?.kind !== 'success') {
      process.stderr.write(`memory-lifecycle-probe: 体检未成功：${out?.text ?? '(无输出)'}\n`)
      return 2
    }
    text = out.text
    recorded = !DRY_RUN
  } catch (error) {
    process.stderr.write(`memory-lifecycle-probe: 执行异常：${error instanceof Error ? error.message : error}\n`)
    return 2
  }

  // 从文本里取回结构化数字有风险；这里重新用 lifecycle 纯函数算一遍（同源，但不是同一次调用）
  const { trackLifecycle } = await import('../lib/lifecycle.js')
  const store = new MemoryStore(MEMORY_DIR)
  const tracks = {}
  for (const [track, keyAgent] of [['memory', undefined], ['user', undefined], ['key', agent]]) {
    let entries = []
    try { entries = store.entriesOf(track, keyAgent) } catch { entries = [] }
    tracks[track] = trackLifecycle(entries)
  }
  const totals = {
    entries: 0,
    active: 0,
    deprecated: 0,
    slots: 0,
    sameSlotMultiActive: 0,
    supersedesEdgeUnresolved: 0,
  }
  for (const r of Object.values(tracks)) {
    totals.entries += r.total
    totals.active += r.active
    totals.deprecated += r.deprecated
    totals.slots += r.slots
    totals.sameSlotMultiActive += r.sameSlotMultiActive
    totals.supersedesEdgeUnresolved += r.supersedesEdgeUnresolved
  }

  const problems = []
  if (totals.supersedesEdgeUnresolved > 0) problems.push(`supersedesEdgeUnresolved=${totals.supersedesEdgeUnresolved}`)
  if (totals.sameSlotMultiActive > 0) problems.push(`sameSlotMultiActive=${totals.sameSlotMultiActive}`)
  if (totals.slots === 0) problems.push('slots=0（空分母：门槛值没有意义）')
  const verdict = problems.length === 0 ? 'ok' : 'warn'
  const code = problems.length === 0 ? 0 : 1

  const row = {
    ts: new Date().toISOString(),
    verdict,
    code,
    recorded,
    totals,
    problems,
  }
  if (!DRY_RUN) {
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      appendFileSync(join(LOG_DIR, `probe-${localDate()}.log`), `${JSON.stringify(row)}\n`, 'utf8')
      mkdirSync(dirname(STATE_FILE), { recursive: true })
      writeFileSync(STATE_FILE, `${JSON.stringify(row, null, 2)}\n`, 'utf8')
    } catch (error) {
      // 证据面写不进去 = 判不了（不能因为"指标没落盘"就报成功）
      process.stderr.write(`memory-lifecycle-probe: 证据面写入失败：${error instanceof Error ? error.message : error}\n`)
      return 2
    }
  }
  process.stdout.write(`${text}\n`)
  process.stdout.write(`verdict=${verdict} code=${code}${problems.length > 0 ? ` problems=${problems.join(',')}` : ''}\n`)
  return code
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  process.stderr.write(`memory-lifecycle-probe: 未捕获异常：${error?.stack ?? error}\n`)
  process.exitCode = 2
})
