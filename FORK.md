# FORK 说明 — dsh-memory-evolve（dsplugins fork）

- **上游**：https://github.com/csyangwen/dsh-memory-evolve （`git remote` 名为 `upstream`，未推回）
- **fork 时间**：2026-09-22
- **fork 基线**：`upstream/main` @ `c337dc1`（`fix(sync): 修复记忆正文被同步链路损坏成 U+FFFD 的根因`），版本 0.1.0
- **本地提交**：`46422bb fix(tokens): 24 个无效 --dsw-alias-* 设计令牌整改（88 处 / 9 文件）`
- **为什么 fork**：上游 `src/client` 使用了 24 个在当前 DSH 设计令牌白名单里**不存在**的
  `--dsw-alias-*` 令牌。失效令牌在渲染时静默 fallback 到硬编码 hex，导致浅色/深色主题错乱。
  按 dsplugins 治理铁律（外部插件不合标准 → fork 到 dsplugins 修，不改 `node_modules`）处理。

## 令牌映射（本次整改全表）

映射依据两件事，不是凭感觉：① 作者在 `var(--dsw-alias-X, <fallback>)` 里写的 fallback 色值；
② harness 自身 client CSS 的用法频次（例如 `border-l2` 是通用描边的最常用值，140 次）。

| 失效令牌 | 替换为 | 处数 | 依据 |
|---|---|---|---|
| `border-l` | `border-l2` | 39 | 通用描边；harness 自身最常用（140 次），fallback 为中灰 rgba(128,128,128,.3) |
| `border-subtle` | `border-l1` | 4 | “subtle” 应比通用描边更淡（light theme 0.04 / dark 0.06） |
| `bg-elevated` | `bg-layer-2` | 5 | 抬升面；dark theme 850 高于 base 950 |
| `bg-l2` | `bg-layer-2` | 1 | 同一语义的旧命名 |
| `bg-primary` | `bg-base` | 2 | fallback `#fff` = 基础底色 |
| `bg-secondary` | `bg-layer-1` | 1 | 次级面 |
| `fill-muted` | `bg-skeleton` | 1 | 弱填充（light 0.04 / dark 0.08），双主题安全 |
| `input-bg` | `bg-layer-1` | 1 | 输入框底色 |
| `interactive-fg-default` | `label-primary` | 3 | 前景/描边默认色 |
| `label-inverted` | `label-primary-inverted` | 2 | 直接对应 |
| `label-on-primary` | `label-primary-foreground` | 2 | 主按钮上的文字 |
| `scrollbar-bg-l` | `scrollbar-bg-l1` | 1 | 命名归一 |
| `scrollbar-hover-l` | `scrollbar-hover-l1` | 1 | 命名归一 |
| `state-accent-primary` | `state-business-primary` | 7 | fallback `#4c8dff` ≈ deepseek 蓝强调色 |
| `state-business-secondary` | `state-business-tertiary` | 1 | business 家族只有 primary/tertiary |
| `state-danger-border` | `state-error-secondary` | 1 | danger→error；描边取较柔的 secondary |
| `state-danger-label` | `state-error-primary` | 3 | danger→error 文本色 |
| `state-warn-border` | `state-warn-secondary` | 1 | warn 家族命名 |
| `state-warning-border` | `state-warn-secondary` | 2 | 同上 |
| `state-warning-fg` | `state-warn-label` | 2 | fg → label |
| `state-warning-primary` | `state-warn-primary` | 5 | 命名归一 |
| `state-warning-tertiary` | `state-warn-tertiary` | 1 | 命名归一 |
| `text-tertiary` | `label-tertiary` | 2 | 文本一律 `label-*` 系列 |

**未替换**：`src/client/canvas-grok/styles.css:135` 的 `--dsw-alias-on-brand` 出现在注释里
（踩坑记录），保留原文；产物 bundle 中因此仍能看到这一个字符串，属预期。

## 验收证据

```bash
cd /Users/echerlos/syncfolder/project/dsplugins/dsh-memory-evolve
export DSH_SOURCE=/Users/echerlos/syncfolder/project/deepseek-harness   # build.mjs 从这里解析 esbuild
node scripts/build.mjs                                                  # → lib/client.js built

# 1) 源码非法令牌 = 0（全文件类型；注释单独统计）
# 2) 产物非法令牌 = 0、React.createElement = 0（jsx automatic 生效）
# 3) 测试与未改动副本逐项一致
npm test     # 829 tests / 827 pass / 2 fail
```

`2 fail` 与未改动的 `upstream/main` 原始副本**完全一致**（已用 `git archive HEAD` 物化对照）：
`resolveProviders：auto 按平台排序并探测` 与 `控制器：启用注册、禁用注销、状态`，
根因是本机 `PATH` 里没有 `rg`，属环境性失败，与本次改动无关。

## 启用步骤（未执行，需重启窗口）

fork 目前**未被任何 profile 引用**，宿主仍加载 github 版本。启用 = 两步，且会触发宿主重启：

```bash
cd ~/.dsh/profiles/web
# 1) 依赖从 github: 改为本地 link:（与其它自研插件一致）
#    "dsh-memory-evolve": "link:/Users/echerlos/syncfolder/project/dsplugins/dsh-memory-evolve"
#    ⚠️ 改完必须“同一轮内”立刻 pnpm install —— daemon 监听 package.json mtime，
#       约 4s 内触发 AUTO-RELOAD，install 未完成会导致 preflight 连续失败（backoff 最长 10min）
pnpm install
# 2) 重启由 daemon 自动完成（AUTO-RELOAD: profile-plugin-manifest → 等 host drain）
#    验证：browser 刷新后，插件「设置」卡片与记忆面板在浅色主题下颜色正常
```

回滚 = 把依赖改回 `github:csyangwen/dsh-memory-evolve#main` 并 `pnpm install`。
