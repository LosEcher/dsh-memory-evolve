/**
 * 决策策略（P0 起，2026-10-28；enforce 于 2026-11-01 落地）—— "什么该自动处理、
 * 什么必须问人"只由**配置**决定，不写死在代码里；本模块是唯一的解析/校验入口
 * （纯函数，无 IO）。
 *
 * ## 为什么是预设 + 逐轨覆盖
 *
 * 直接暴露十来个旋钮会同时制造两个失败模式：没人知道该填什么，以及"填了但不生效"
 * （配置 ≠ 生效）。所以只给四个**预设**（strict / balanced / hands-off / trusted），
 * 外加按 target 的少量覆盖；判定顺序固定为：**逐轨覆盖 > 预设**。
 *
 * ## 两种模式：dry-run（预演，默认）与 enforce（真自动）
 *
 * - `dry-run`：每条建议记下"若开启自动，会被怎么处理、因为哪条规则"
 *   （见 decisions.js 的 policyPreview），**不改变任何行为**。
 * - `enforce`：`auto` 的建议**直接写入**并记 `auto_applied`（actor=policy），
 *   不再进确认队列；写失败则退回入队（fail-closed，绝不静默丢）。
 *
 * 为什么 enforce 是 opt-in 而不是默认：这是"默认问人"到"默认采纳"的方向反转，
 * 必须有可回退的证据面（`reverted / auto_applied` 比率，见 decisions.js 的
 * autoApplyStats）才敢开。2026-11-01 实测本机 85 proposed → 85 approved、0 reject：
 * 逐条确认长期零信息量——那是**可以开的依据**，不是默认值的理由。
 *
 * ## 硬约束（fail-closed，全部有负向控制测试）
 *
 * - 未知预设 / 未知 target / 未知 autoApply 键 ⇒ 抛错并**点名那个键**（R-A 纪律：
 *   拼错的键被静默忽略时，整条策略会退化成"默认值"而没人发现）。
 * - `key` 轨的 `auto` 只允许由**预设**给出（`trusted`），不允许靠
 *   `decisionByTarget.key='auto'` 单轨硬拨：dry-run 下那是"写了不生效"的配置
 *   （正是本模块要消灭的假象），enforce 下那是"绕开整套策略只把最贵的一轨全
 *   放开"（那是设置不当，不是策略）。要放开 key 就换预设。
 * - `key` 自动额外过 `keyMaxChars`（默认 600）：key 是**每回合注入**项，400 字的
 *   memory 便宜，400 字的 key 很贵。
 * - `auto` 还要过 autoApply 的闸：命中 denyPatterns / 过长 / hits 不足 ⇒ 一律
 *   降回 confirm（这些闸只看"要不要问人"，不看"要不要记"）。
 *
 * @module dsh-memory-evolve/policy
 */
import { normalizeSuggestionText } from './decisions.js'

/** Supported policy presets. */
export const DECISION_PRESETS = ['strict', 'balanced', 'hands-off', 'trusted']

/**
 * What a preset decides per target class. `todo` 汇总四条待办轨：待办是低风险
 * 且可回退的事项（`dtodo done/remove` 随时可撤），所以它有资格默认自动。
 *
 * `trusted` 是唯一放开 `key` 的预设，且只在 enforce 下真正生效（dry-run 下它是
 * 一份"如果信任会怎样"的预演）。它存在的原因是实测：本机 63/63 条 key 建议
 * 全部被采纳、0 拒绝——"逐条确认"在那条轨上从未产生过一次不同意见。
 */
const PRESET_TABLE = {
  strict: { memory: 'confirm', user: 'confirm', key: 'confirm', todo: 'confirm' },
  balanced: { memory: 'confirm', user: 'confirm', key: 'confirm', todo: 'auto' },
  'hands-off': { memory: 'auto', user: 'auto', key: 'confirm', todo: 'auto' },
  trusted: { memory: 'auto', user: 'auto', key: 'auto', todo: 'auto' },
}

/** Every legal per-target action. */
export const DECISION_ACTIONS = ['confirm', 'auto', 'archive']

/** Every target a suggestion may carry (kept in sync with review.js/validateTargets). */
export const DECISION_TARGETS = ['memory', 'user', 'key', 'todo-life', 'todo-work', 'todo-project', 'todo-daily']

/** Collapse the four todo tracks into one class (they share risk, not storage). */
export function targetClass(target) {
  const value = String(target ?? '')
  return value.startsWith('todo-') ? 'todo' : value
}

/** Allowed keys inside `decisionAutoApply` (unknown ⇒ error, naming the key). */
const AUTO_APPLY_KEYS = ['denyPatterns', 'maxChars', 'requireHits', 'keyMaxChars']

/**
 * Defaults for the auto-apply gates (also used when the config omits the block).
 *
 * ## denyPatterns 改成「值形态」而不是「词」（2026-11-02 实证）
 *
 * 旧默认是 `['密码','passwd','password','token','secret','sk-','AKIA','身份证','手机号']`，
 * 判定用 `new RegExp(pattern,'i').test(content)` —— 于是**只要正文出现 "token" 这个词**
 * 就判 `deny-pattern:token`。台账实测：110 条排队建议里有 1 条正是这样被误伤
 * （讲「清单类资产要配生成器」的条目，只因正文提到 token）。
 *
 * 后果很具体：**任何讲鉴权/凭据机制的技术记忆都必须人工确认**，而那恰恰是本项目
 * 最常沉淀的一类知识。判据的意图是「别把真凭据自动写进记忆」，不是「别谈凭据」。
 *
 * 所以改为**值形态**：有标签且有值（`API_KEY=…`）、厂商前缀（`sk-…`/`AKIA…`/`ghp_…`/`xox…`/私钥块），
 * 或强 PII 形态（18 位身份证、11 位手机号）。
 * ⚠️ 刻意**不**收「任意 32+ 位十六进制」：本仓记忆里合法地大量出现 git 全 hash（40 位 hex），
 * 那会把每条带 hash 的结论都退回人工 —— 比误报更糟的是把误报当常态。
 */
export const AUTO_APPLY_DEFAULTS = {
  denyPatterns: [
    'sk-[A-Za-z0-9_-]{16,}',                    // OpenAI/Anthropic 风格
    'AKIA[0-9A-Z]{16}',                          // AWS access key id
    'gh[pousr]_[A-Za-z0-9]{20,}',                // GitHub token
    'xox[baprs]-[A-Za-z0-9-]{10,}',              // Slack token
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',        // 私钥块
    '(?:api[_-]?key|access[_-]?token|secret[_-]?key|passwd|password)\\s*[:=]\\s*\\S{8,}', // 有标签且有值
    '(?<!\\d)1[3-9]\\d{9}(?!\\d)',               // 手机号（强 PII）
    '(?<!\\d)\\d{17}[\\dXx](?!\\d)',             // 18 位身份证（强 PII）
  ],
  // 400 → 800（2026-11-02）：实测排队的第二大原因就是 too-long，而 400 字装不下
  // 「结论 + 判据 + 反例」这种本仓要求的写法。memory/user 不进每轮注入，成本低；
  // key 轨仍是 600（每回合注入，长度 = 每轮成本），**不放宽**。
  maxChars: 800,
  requireHits: 1,
  // key 是每回合注入项，所以它的长度闸与 memory/user 分开：800 字的 memory 便宜，
  // 800 字的 key 每轮都在付费。默认 600，不是"更大就更宽松"，而是两条轨成本不同。
  keyMaxChars: 600,
}

/** Both modes are implemented; `dry-run` is the default and never changes behaviour. */
export const SUPPORTED_MODES = ['dry-run', 'enforce']

function fail(message) {
  throw new Error(`dsh-memory-evolve: ${message}`)
}

/**
 * Validate the decision-policy config block. Throws with the offending key named.
 * @param {object} config - the resolved plugin config (flat, as in DEFAULTS).
 */
export function validateDecisionConfig(config = {}) {
  const preset = config.decisionPolicy ?? 'balanced'
  if (!DECISION_PRESETS.includes(preset)) {
    fail(`decisionPolicy 必须是 ${DECISION_PRESETS.join(' / ')}，收到 "${preset}"`)
  }
  const mode = config.decisionPolicyMode ?? 'dry-run'
  if (!SUPPORTED_MODES.includes(mode)) {
    fail(`decisionPolicyMode 必须是 ${SUPPORTED_MODES.join(' / ')}，收到 "${mode}"。`
      + ' 这条报错是刻意的——写了不生效的配置比报错更坏。')
  }
  const byTarget = config.decisionByTarget ?? {}
  if (byTarget === null || typeof byTarget !== 'object' || Array.isArray(byTarget)) {
    fail('decisionByTarget 必须是对象（target → action）')
  }
  for (const [target, action] of Object.entries(byTarget)) {
    if (!DECISION_TARGETS.includes(target)) {
      fail(`decisionByTarget 含未知 target "${target}"（允许：${DECISION_TARGETS.join(' / ')}）`)
    }
    if (!DECISION_ACTIONS.includes(action)) {
      fail(`decisionByTarget["${target}"] 必须是 ${DECISION_ACTIONS.join(' / ')}，收到 "${action}"`)
    }
    if (target === 'key' && action === 'auto') {
      fail(`decisionByTarget 不允许把 key 轨设为 auto（这是单轨硬拨，绕开了整套策略）：`
        + `要放开 key 请用预设 decisionPolicy: 'trusted'`
        + `${mode === 'enforce' ? '（当前已是 enforce）' : '，并把 decisionPolicyMode 设为 enforce，否则只是预演'}。`)
    }
  }
  const autoApply = config.decisionAutoApply ?? {}
  if (autoApply === null || typeof autoApply !== 'object' || Array.isArray(autoApply)) {
    fail('decisionAutoApply 必须是对象')
  }
  for (const key of Object.keys(autoApply)) {
    if (!AUTO_APPLY_KEYS.includes(key)) {
      fail(`decisionAutoApply 含未知配置项 "${key}"（允许：${AUTO_APPLY_KEYS.join(' / ')}）`)
    }
  }
  if (autoApply.denyPatterns !== undefined) {
    if (!Array.isArray(autoApply.denyPatterns) || autoApply.denyPatterns.some((p) => typeof p !== 'string' || p === '')) {
      fail('decisionAutoApply.denyPatterns 必须是非空字符串数组')
    }
    for (const pattern of autoApply.denyPatterns) {
      try { new RegExp(pattern) } catch { fail(`decisionAutoApply.denyPatterns 里的 "${pattern}" 不是合法正则`) }
    }
  }
  for (const key of ['maxChars', 'keyMaxChars']) {
    if (autoApply[key] !== undefined && (!Number.isInteger(autoApply[key]) || autoApply[key] < 1)) {
      fail(`decisionAutoApply.${key} 必须是正整数`)
    }
  }
  if (autoApply.requireHits !== undefined && (!Number.isInteger(autoApply.requireHits) || autoApply.requireHits < 0)) {
    fail('decisionAutoApply.requireHits 必须是非负整数')
  }
  const ttlDays = config.decisionTtlDays ?? 14
  if (!Number.isInteger(ttlDays) || ttlDays < 1) {
    fail('decisionTtlDays 必须是正整数（到期归档尚未实现；本字段只做校验）')
  }
}

/**
 * Resolve the effective policy: preset + per-target overrides, plus the
 * auto-apply gates. Throws on invalid config (same rules as validateDecisionConfig).
 * @param {object} config - resolved plugin config.
 * @returns {{preset: string, mode: string, ttlDays: number, autoApply: {denyPatterns: string[], maxChars: number, requireHits: number, keyMaxChars: number}, actions: Record<string, string>, overrides: Record<string, string>, policyId: string}}
 */
export function resolveDecisionPolicy(config = {}) {
  validateDecisionConfig(config)
  const preset = config.decisionPolicy ?? 'balanced'
  const overrides = config.decisionByTarget ?? {}
  const base = PRESET_TABLE[preset]
  const actions = {}
  for (const target of DECISION_TARGETS) {
    const cls = targetClass(target)
    actions[target] = overrides[target] ?? base[cls] ?? 'confirm'
  }
  const rawAuto = config.decisionAutoApply ?? {}
  const autoApply = {
    denyPatterns: rawAuto.denyPatterns ?? AUTO_APPLY_DEFAULTS.denyPatterns,
    maxChars: rawAuto.maxChars ?? AUTO_APPLY_DEFAULTS.maxChars,
    requireHits: rawAuto.requireHits ?? AUTO_APPLY_DEFAULTS.requireHits,
    keyMaxChars: rawAuto.keyMaxChars ?? AUTO_APPLY_DEFAULTS.keyMaxChars,
  }
  return {
    preset,
    mode: config.decisionPolicyMode ?? 'dry-run',
    ttlDays: config.decisionTtlDays ?? 14,
    autoApply,
    actions,
    overrides,
    // Recorded on every decision row so "why was this auto-handled" stays answerable
    // after the config changes.
    policyId: `${preset}/${config.decisionPolicyMode ?? 'dry-run'}`,
  }
}

/**
 * The configured action for one suggestion target.
 * @param {{actions: Record<string, string>}} policy
 * @param {string} target
 * @returns {'confirm'|'auto'|'archive'}
 */
export function actionForTarget(policy, target) {
  return policy.actions[target] ?? policy.actions[targetClass(target)] ?? 'confirm'
}

/**
 * Evaluate one pending suggestion under the policy. In `dry-run` this is only a
 * preview; in `enforce` the caller writes on `auto` and queues on `confirm`.
 * @param {object} policy - resolveDecisionPolicy() result.
 * @param {{target: string, content: string, hits?: number}} entry - queue entry.
 * @returns {{action: 'confirm'|'auto', reason: string}} the decision the policy takes,
 *   with the rule that produced it.
 */
export function evaluateSuggestion(policy, entry) {
  const target = String(entry?.target ?? '')
  const configured = actionForTarget(policy, target)
  // archive 也是"不自动写"，按 confirm 记（写不写由人决定）。
  if (configured !== 'auto') return { action: 'confirm', reason: `policy:${policy.preset}:${targetClass(target)}=${configured}` }
  const content = normalizeSuggestionText(entry?.content)
  const hits = Number.isInteger(entry?.hits) ? entry.hits : 1
  if (hits < policy.autoApply.requireHits) {
    return { action: 'confirm', reason: `hits<${policy.autoApply.requireHits}` }
  }
  // key 轨有自己的长度闸（每回合注入项），其余轨共用 maxChars。
  const limit = targetClass(target) === 'key' ? policy.autoApply.keyMaxChars : policy.autoApply.maxChars
  if (content.length > limit) {
    return { action: 'confirm', reason: `too-long:${content.length}>${limit}` }
  }
  for (const pattern of policy.autoApply.denyPatterns) {
    let matched = false
    try { matched = new RegExp(pattern, 'i').test(content) } catch { matched = content.includes(pattern) }
    if (matched) return { action: 'confirm', reason: `deny-pattern:${pattern}` }
  }
  return { action: 'auto', reason: `policy:${policy.preset}:auto` }
}
