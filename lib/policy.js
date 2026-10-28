/**
 * 决策策略（P0，2026-10-28）—— "什么该自动处理、什么必须问人"只由**配置**决定，
 * 不写死在代码里；本模块是唯一的解析/校验入口（纯函数，无 IO）。
 *
 * ## 为什么是预设 + 逐轨覆盖
 *
 * 直接暴露十来个旋钮会同时制造两个失败模式：没人知道该填什么，以及"填了但不生效"
 * （配置 ≠ 生效）。所以只给三个**预设**（strict / balanced / hands-off），外加按
 * target 的少量覆盖；判定顺序固定为：**逐轨覆盖 > 预设**。
 *
 * ## P0 只到 dry-run
 *
 * 本阶段不执行自动采纳：`decisionPolicyMode` 只接受 `dry-run`，每条提出的建议会
 * 记下"若开启自动，会被怎么处理、因为哪条规则"（见 decisions.js 的 policyPreview）。
 * 想开 `enforce` 会**显式报错并说明 P2 才提供**——这比"配置写了但静默无效"诚实。
 *
 * ## 硬约束（fail-closed，全部有负向控制测试）
 *
 * - 未知预设 / 未知 target / 未知 autoApply 键 ⇒ 抛错并**点名那个键**（R-A 纪律：
 *   拼错的键被静默忽略时，整条策略会退化成"默认值"而没人发现）。
 * - `key` 轨永远不允许 `auto`：关键记忆是长期注入项，自动写等于让模型替用户
 *   决定"什么算重要"。
 * - `auto` 还要过 autoApply 的三道闸：命中 denyPatterns / 过长 / hits 不足 ⇒ 一律
 *   降回 confirm（这些闸只看"要不要问人"，不看"要不要记"）。
 *
 * @module dsh-memory-evolve/policy
 */
import { normalizeSuggestionText } from './decisions.js'

/** Supported policy presets. */
export const DECISION_PRESETS = ['strict', 'balanced', 'hands-off']

/**
 * What a preset decides per target class. `todo` 汇总四条待办轨：待办是低风险
 * 且可回退的事项（`dtodo done/remove` 随时可撤），所以只有它敢默认自动。
 */
const PRESET_TABLE = {
  strict: { memory: 'confirm', user: 'confirm', key: 'confirm', todo: 'confirm' },
  balanced: { memory: 'confirm', user: 'confirm', key: 'confirm', todo: 'auto' },
  'hands-off': { memory: 'auto', user: 'auto', key: 'confirm', todo: 'auto' },
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
const AUTO_APPLY_KEYS = ['denyPatterns', 'maxChars', 'requireHits']

/** Defaults for the auto-apply gates (also used when the config omits the block). */
export const AUTO_APPLY_DEFAULTS = {
  denyPatterns: ['密码', 'passwd', 'password', 'token', 'secret', 'sk-', 'AKIA', '身份证', '手机号'],
  maxChars: 400,
  requireHits: 1,
}

/** Only dry-run is implemented in P0. */
const SUPPORTED_MODES = ['dry-run']

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
    fail(`decisionPolicyMode "${mode}" 尚未实现：P0 只支持 dry-run（自动采纳 enforce 属 P2）。`
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
      fail('decisionByTarget 不允许把 key 轨设为 auto：关键记忆自动写入等于让模型替用户判断什么算重要')
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
  if (autoApply.maxChars !== undefined && (!Number.isInteger(autoApply.maxChars) || autoApply.maxChars < 1)) {
    fail('decisionAutoApply.maxChars 必须是正整数')
  }
  if (autoApply.requireHits !== undefined && (!Number.isInteger(autoApply.requireHits) || autoApply.requireHits < 0)) {
    fail('decisionAutoApply.requireHits 必须是非负整数')
  }
  const ttlDays = config.decisionTtlDays ?? 14
  if (!Number.isInteger(ttlDays) || ttlDays < 1) {
    fail('decisionTtlDays 必须是正整数（P2 的到期归档使用；P0 只做校验）')
  }
}

/**
 * Resolve the effective policy: preset + per-target overrides, plus the
 * auto-apply gates. Throws on invalid config (same rules as validateDecisionConfig).
 * @param {object} config - resolved plugin config.
 * @returns {{preset: string, mode: string, ttlDays: number, autoApply: {denyPatterns: string[], maxChars: number, requireHits: number}, actions: Record<string, string>, overrides: Record<string, string>, policyId: string}}
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
 * Evaluate one pending suggestion under the policy (dry-run preview).
 * @param {object} policy - resolveDecisionPolicy() result.
 * @param {{target: string, content: string, hits?: number}} entry - queue entry.
 * @returns {{action: 'confirm'|'auto', reason: string}} the decision a future
 *   enforce mode WOULD take, with the rule that produced it.
 */
export function evaluateSuggestion(policy, entry) {
  const target = String(entry?.target ?? '')
  const configured = actionForTarget(policy, target)
  // archive 也是"不自动写"，在预演里按 confirm 记（写不写由人决定）。
  if (configured !== 'auto') return { action: 'confirm', reason: `policy:${policy.preset}:${targetClass(target)}=${configured}` }
  const content = normalizeSuggestionText(entry?.content)
  const hits = Number.isInteger(entry?.hits) ? entry.hits : 1
  if (hits < policy.autoApply.requireHits) {
    return { action: 'confirm', reason: `hits<${policy.autoApply.requireHits}` }
  }
  if (content.length > policy.autoApply.maxChars) {
    return { action: 'confirm', reason: `too-long:${content.length}>${policy.autoApply.maxChars}` }
  }
  for (const pattern of policy.autoApply.denyPatterns) {
    let matched = false
    try { matched = new RegExp(pattern, 'i').test(content) } catch { matched = content.includes(pattern) }
    if (matched) return { action: 'confirm', reason: `deny-pattern:${pattern}` }
  }
  return { action: 'auto', reason: `policy:${policy.preset}:auto` }
}
