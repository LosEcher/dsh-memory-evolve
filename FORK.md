# FORK 说明 — dsh-memory-evolve（dsplugins fork）

- **上游**：https://github.com/csyangwen/dsh-memory-evolve （`git remote` 名为 `upstream`）
- **本 fork 远端**：`origin` = https://github.com/LosEcher/dsh-memory-evolve （本仓的 `main` 推到这里）
- **fork 时间**：2026-09-22
- **fork 基线**：`upstream/main` @ `c337dc1`（`fix(sync): 修复记忆正文被同步链路损坏成 U+FFFD 的根因`），版本 0.1.0
- **本地提交**：`46422bb fix(tokens): 24 个无效 --dsw-alias-* 设计令牌整改（88 处 / 9 文件）`
- **2026-10-16 合并**：`d669efe` 合入 `upstream/main` @ `e6f6b84`（落后 10 个提交，0 冲突）。
  上游在这 10 个提交里做了 0.2.0-rc.1 兼容，其中 `e6f6b84` 新增
  `src/client/ui-icons.ts` 的 `resolveIcon(新名, 旧名)`：按「新名 → 旧名 → Medium 变体 →
  `MissingIcon`(渲染 null)」动态解析 `ui-primitives` 命名空间，**永不返回 undefined**，
  修掉了技能管理 / 无限画板 Tab 打开即空白（`slot entry crashed` / React #130）。
  合并后 fork **同时**具备上游的图标兼容与本地的令牌整改 —— 二者此前各缺一半：

  | 版本 | 失效设计令牌（对 harness 白名单 `comm`） | 图标兼容 |
  |---|---|---|
  | `upstream/main` @ e6f6b84 | **24 个** | ✅ shim |
  | 本 fork 合并前 | 1 个 | ❌ 产物 30 处旧名 |
  | 本 fork 合并后 | 1 个 | ✅ shim |

  产物由合并后源码重建（不是 git 对二进制产物的自动合并）：二者 md5 恰好相同
  (`15d9ba2f52adf7885e68340cd9496eb8`)，属**事后验证**而非事前假设。
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

## 启用状态（2026-10-16 已执行）

fork **已被 web profile 引用**，宿主加载的是本 fork 而非 github 版本：

```jsonc
// ~/.dsh/profiles/web/package.json
"dsh-memory-evolve": "link:/Users/echerlos/syncfolder/project/dsplugins/dsh-memory-evolve"
```

实际执行的是 `dsh plugin --profile web add <fork 目录>`（它会同时改依赖并跑 pnpm
install），**没有另外手动重启** —— 见下方 ⚠️。

启用前的实况（值得记）：宿主原本跑的是 lockfile 里钉住的 tarball
`6aa2837`（2026-08-14 快照），而不是 `#main` 的当前内容 —— specifier 写着 `#main`
并不等于跑的是最新。该快照的产物里 30 处旧图标名，正是技能 Tab 空白的根因。

验证（全部实测）：插件树 `include:dsh-memory-evolve` = active；profile 解析到的
`lib/client.js` md5 = `15d9ba2f…`（与本仓一致）；会话页「技能」Tab 与其「技能管理」
子页（用到旧名图标的 `SkillList` + `FileTree`）均正常渲染；`data-slot-error` = 0；
`dsh-telemetry` 新增事件 = 0。

```bash
# ⚠️ 关键坑：daemon 监听 profile 的 package.json mtime，约 4s 内触发 AUTO-RELOAD
#   (profile-plugin-manifest)。所以**不要再手动调 dsh-web-restart-detached.sh** ——
#   两次请求会被合并成一次 "owed restart"，60s 后再补一次，期间 3080 短暂不可达。
#   正确做法：只做 plugin add，然后等 daemon 自己 healthy。
```

回滚 = 把依赖改回 `github:csyangwen/dsh-memory-evolve#main` 并 `pnpm install`。
