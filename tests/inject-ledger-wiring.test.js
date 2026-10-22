/**
 * 注入账本的接线测试（不是账本本身，而是"渲染 → 账本"这一段）。
 *
 * 三条硬判据：
 *  1. `onRender` 每次渲染**恰好**调用一次，且 `chars.total` 等于**返回文本的真实长度**
 *     （若用中间变量估算，一旦 sanitize 改变长度，账本就开始说谎）；
 *  2. KEY 全量/摘要两种模式都能被记到（`keyMode` 决定后续能否判断"预算是否在裁内容"）；
 *  3. **不传 onRender 时输出逐字不变** —— 账本不得改变它在测量的那个东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSnapshot } from '../lib/index.js'

const memoryDir = () => mkdtempSync(join(tmpdir(), 'mem-snap-'))

/** 只实现 renderSnapshot 真正用到的那一个方法（entriesOf）。 */
function fakeStore({ memory = [], user = [], key = [] } = {}) {
  return {
    entriesOf(target) {
      if (target === 'memory') return memory
      if (target === 'user') return user
      if (target === 'key') return key
      return []
    },
  }
}

const baseConfig = (dir, over = {}) => ({
  memoryDir: dir,
  injectMemory: true,
  keyProgressiveDisclosure: 'off',
  keyFullInjectThreshold: 3,
  keyFullInjectCharLimit: 1500,
  reviewEnabled: false,
  todoEnabled: true,
  perTurnDailyWrites: true,
  perTurnProjectWrites: true,
  perTurnKeyWrites: true,
  reviewInterval: 10,
  reviewMode: 'auto',
  ...over,
})

// cwd 指向一个非 git 目录 ⇒ gitBranch 返回 undefined，不触发 subprocess
const agent = (cwd) => ({ session: { id: 'session-test-0001', header: { cwd } } })

test('onRender 恰好调用一次，chars.total 等于返回文本真实长度', () => {
  const dir = memoryDir()
  const store = fakeStore({
    memory: ['[2026-10-01] 全局记忆一', '[2026-10-02] [id:abcd1234] 全局记忆二'],
    key: ['[id:ef567890] [2026-10-03] 项目关键事实'],
  })
  const seen = []
  const text = renderSnapshot(baseConfig(dir), store, agent(dir), undefined, null, null, (meta) => seen.push(meta))

  assert.equal(seen.length, 1)
  const meta = seen[0]
  assert.deepEqual(meta.entries, { memory: 2, user: 0, key: 1 })
  assert.equal(meta.chars.total, text.length)          // 关键：不是估算值
  assert.ok(meta.chars.key > 0 && meta.chars.key < meta.chars.total)
  assert.equal(meta.keyMode, 'full')
  assert.deepEqual(meta.keyIds, ['ef567890'])
  assert.equal(meta.keyIdsDerived, 0)                  // 打了身份证 ⇒ 稳定身份，不掺进派生样本          // 身份被记下来（命中率判据）
  assert.equal(meta.subagent, false)
  assert.equal(meta.sessionId, 'session-test-0001')
  assert.deepEqual(meta.tracks, { daily: true, project: true, key: true, review: false })
})

test('KEY 摘要模式被记成 summary（预算真的在裁内容时能看出来）', () => {
  const dir = memoryDir()
  const key = Array.from({ length: 5 }, (_, i) => `[2026-10-0${i + 1}] [id:${'abcdef0' + i}] 条目${i}`)
  const store = fakeStore({ key })
  const seen = []
  renderSnapshot(baseConfig(dir, { keyProgressiveDisclosure: 'auto' }), store, agent(dir), undefined, null, null,
    (meta) => seen.push(meta))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].keyMode, 'summary')
  assert.equal(seen[0].entries.key, 5)
})

test('不传 onRender 时输出逐字不变（账本不得改变被测对象）', () => {
  const dir = memoryDir()
  const store = fakeStore({ memory: ['[2026-10-01] x'], user: ['[2026-10-01] y'], key: ['[2026-10-02] [id:0123abcd] z'] })
  const cfg = baseConfig(dir)
  const without = renderSnapshot(cfg, store, agent(dir), undefined, null, null)
  const withHook = renderSnapshot(cfg, store, agent(dir), undefined, null, null, () => {})
  assert.equal(without, withHook)
})

test('钩子抛异常不得影响快照（遥测不能拖垮被测物）', () => {
  const dir = memoryDir()
  const store = fakeStore({ memory: ['[2026-10-01] x'] })
  const text = renderSnapshot(baseConfig(dir), store, agent(dir), undefined, null, null, () => {
    throw new Error('telemetry boom')
  })
  assert.ok(typeof text === 'string' && text.length > 0)
})
