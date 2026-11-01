# 记忆生命周期：槽位 / 取代边 / 失效标记

> 落点：`dsplugins/dsh-memory-evolve`（插件仓）。本文是该机制的**契约与验收基准**，
> 改动 `lib/lifecycle.js` / `store.add` / 注入面过滤 / `memory_review stale` 前先读。

## 1. 为什么需要这一层（2026-11-01 回测定论）

在真实库上做历史回测，得到两个推翻原设计的负结果：

| 测法 | 结果 | 结论 |
| --- | --- | --- |
| 87 条历史建议 × **按日期重建的"提出当时库"**，整句 3-gram Jaccard | **87/87 全落在 novel（<0.5）** | 文本相似度做重复/冲突判据在本语料上**零召回** |
| 同轨"共享 ≥3 个实体"当同主题 | 275（MEMORY）/ 495（KEY）对 | 样例大量误报（"InstantDB 分析" vs "Vercel fx 调研"）⇒ 只能当**候选召回**，不能当判据 |

再加一个精确判据（不依赖任何相似度算法）：

| 判据 | 结果 |
| --- | --- |
| 条目自己写着 `supersedes「X」`，去库里查 X 是否还在 | 9 处声明中 **4 处的被取代方仍 active、无任何标记、继续每轮注入**（MEMORY 4 处里 3 处） |

根因两条：

1. `supersedes` 只是**自然语言**，不产生任何机械后果；
2. 唯一的更新手段 `replace <match>` 要求子串**唯一命中**——一旦同一事实并存两条就
   `multiMatch` 拒绝，**更新能力自锁**（并存越多越改不动，越改不动越多）。

⇒ 所以判据改到**结构**上：槽位 + 取代边 + 失效标记。这也与公开实现一致：
[Zep Facts](https://help.getzep.com/facts.md) 的冲突判据落在**边名（关系类型）**而不是句子上，
更新 = 让旧事实 `invalid` 而非删边；[CALM](https://export.arxiv.org/abs/2610.38573) 实测
"保留被取代记录支持准确的历史推理，而不损害当前答案"。

## 2. 三个标记（都写在条目头部，机械可解析）

| 标记 | 含义 | 谁写 |
| --- | --- | --- |
| `[slot:<slug>]` | **主题槽位**：同一槽位只允许一条 active | 写入时给 `slot` 参数，或内容头自带 |
| `[supersedes:<id8>]` | 本条取代了哪一条（可反查，双向可查） | 写入时自动生成 |
| `[deprecated:<id8>]` | 本条已被谁取代；**不删除、不注入**，仍可按 id 读到 | 系统在取代发生时补写 |

头部顺序固定：`[id] [slot] [supersedes] [deprecated] [日期] 正文`。

**不删除是刻意的**：被取代的条目是"为什么改成这样"的唯一证据；删掉就只剩结论。

## 3. 行为变化（对调用方）

| 操作 | 变化 |
| --- | --- |
| `memory add`（带 `slot`） | 同槽位仍 active 的旧条自动 `[deprecated:<新id>]`；新条自动 `[supersedes:<旧id>]` |
| `memory add`（不带 `slot`） | **零变化**（旧行为逐字不变） |
| `memory supersede id=<id8> content=…` | 按 id 取代（只对 memory/user 两轨开放；key 请用 `add` + `slot` 走确认队列/enforce） |
| `memory replace id=<id8> content=…` | 按 id 定位替换（修 multiMatch 死锁），身份与槽位保持不变 |
| 注入面（快照） | **只注入 active**；deprecated 仍可 `list`/`expand` 读到 |
| `memory_review stale [--record]` | 生命周期体检；`--record` 追加一行到 `~/.dsh/memories/memory-metrics.jsonl` |

**身份生成规则**：只要这一条参与生命周期（带槽位 / 要取代别人），即使所在轨未启用同步，
也会强制生成 `[id:…]`——否则取代边没有落点（回测里那 4 处"声称取代但无落点"正是这个形态）。
被取代的旧条若原本无 id，会补一个**确定性** id（`sha1(归一化内容)` 前 8 位），双设备一致。

## 4. 指标定义（每个数都有分母）

`memory_review stale --record` 每跑一次追加一行；单行结构见 `~/.dsh/memories/memory-metrics.jsonl`。

| 指标 | 定义 | 分母 | 目标 | 说明 |
| --- | --- | --- | --- | --- |
| `sameSlotMultiActive` | 同槽位出现 >1 条 active 的**槽位个数** | `slots` | **0** | 只在 `slots > 0` 时有意义（见局限①） |
| `supersedesEdgeUnresolved` | 带 `[supersedes:X]` 但 X 仍 active 的条目数 | 取代边数 | **0** | 机械确定，不依赖文本 |
| `deprecated` | 已失效条目数 | `total` | 无上限 | 增长本身不是问题（历史被保留） |
| `slots` | 有槽位标记的 active 条目所属槽位数 | — | 增长 | 这是"更新面覆盖率"，太小说明机制没被用起来 |
| `legacySupersedesCandidates` | "文本声称取代"且能查到目标仍 active 的条数 | — | **下降** | **会误报**，只作存量清理线索，**不进验收门槛** |
| `entries/active` | 条目总数 / 其中有效数 | — | — | 注入成本的粗略代理 |

### 局限（必须一起读，否则数字会骗人）

1. **空分母的 0**：`slots = 0` 时 `sameSlotMultiActive = 0` 只是"还没人用槽位"，**不是"没问题"**。
   因此验收必须同时看 `slots` 是否在增长。
2. **`legacySupersedesCandidates` 会误报**：它按"条目自己写的短语 + 同轨 substring"匹配，
   短语歧义（如"边界基线"）会命中无关条目。它只回答"哪些地方值得人工看一眼"。
3. **槽位靠写入方自觉**：模型不写 `slot` 就不会有取代语义。这一层不猜测意图——
   2026-11-01 的回测证明猜测（相似度）零召回，比不猜更坏。

## 5. 验收清单（全部可机械复跑）

```bash
# 单元判据（含负向控制：不同槽位不得互相取代；并存时 replace 必须 multiMatch 而 replaceById 必须成功）
node --test tests/lifecycle.test.js

# 全量回归（预期：仅 search-docs 两例因本机缺 rg 而红，属既有的环境依赖问题）
npm test

# 真实库体检（只读）+ 落一行指标
node -e "…执行 memory_review stale --record…"
```

**绿的标准**（三条同时成立）：

| # | 判据 | 命令/位置 |
| --- | --- | --- |
| 1 | `supersedesEdgeUnresolved == 0` | `memory_review stale` 的输出 |
| 2 | `sameSlotMultiActive == 0` **且** `slots > 0`（有分母） | 同上 |
| 3 | 注入面不含 deprecated（构造一条再查快照） | `tests/lifecycle.test.js` 第 1 例 |

**负向控制**（缺了这两条，"0"就没有意义）：

- 不同槽位**不得**互相取代：`tests/lifecycle.test.js` 第 2 例；
- 并存时 `replace <match>` 必须**失败**（证明死锁真实存在，而不是被静默修成"随便改一条"）：
  `tests/lifecycle.test.js` 第 5 例。

## 6. 基线（2026-11-01 首次读数）

```
memory 278 条（active 278 / deprecated 0）· slots 0 · 同槽位多 active 0 · 取代边未落实 0 · 文本候选 3
user     1 条（active 1）                     · slots 0 · …                      · 文本候选 0
key    302 条（active 302 / deprecated 0）    · slots 0 · …                      · 文本候选 1
合计   581 条 · 同槽位多 active 0 · 取代边未落实 0
```

读法：两个门槛值现在是 **0 但分母为 0**（还没有任何槽位/结构边）。真实存量问题是
**4 处文本候选**（条目自己声称取代、被取代方仍在），它们是第一批需要人工/模型用
`add + slot` 或 `supersede` 收敛的对象；收敛后 `legacySupersedesCandidates` 应下降到 0。

## 7. 明确不做（及理由）

| 不做 | 理由 |
| --- | --- |
| 文本相似度阈值判 dup/conflict | 回测 87/87 novel，零召回；实体共现误报 |
| 自动物理删除被取代条目 | CALM 反证：保留历史才支持"当时为什么这么定" |
| 四时戳 / 点时间查询（Zep 式 `valid_at/invalid_at`） | 当前没有"按时间点回看"的消费者，改存储格式收益不落地 |
| 级联失效（PACMI 式依赖图） | 我们没有图结构 |
| 用 LLM 判语义冲突（Mem0 路线） | 成本高且不可测；等结构层跑出数据再说 |
