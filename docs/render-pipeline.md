# 过渡产物计算流水线 · 匹配 / 避让 / 安全（并发与缓存）

> 对应代码：`src/core/transition.ts`、`src/core/safety.ts`、
> `src/render/renderWorker.ts`、`src/render/renderClient.ts`、
> `src/ui/components/TransitionEditor.vue`

## 1. 一句话

过渡的**匹配、避让、安全检测**全部在 **Web Worker** 里计算；主线程只负责
**切块、分发、归约、缓存、绘制**。其中安全检测按采样帧**分块并行**到多个 worker，
结果与单线程**逐位一致**，但耗时约为 `1/K`。

## 2. 线程模型与通信

主线程与 worker 只传**纯数据**（`Point[]` / `Transition` / `RenderPayload`），
不传类实例、不传 Vue reactive 代理。

```
主线程 (UI, PixiJS)
   │  RenderClient.postMessage({ id, kind, ... })
   ▼
renderWorker × K        ← 真正的重计算在这里
   │  postMessage({ id, ok, result })
   ▼
主线程：按 id 结算 Promise → 归约 / 缓存 / buildRender / 绘制
```

| | 数据通道（持久化） | 计算通道（本条流水线） |
| --- | --- | --- |
| 触发 | 已提交的 mutation | 预览 / 应用过渡 |
| Worker | `data/worker.ts`（SQLite+OPFS） | `render/renderWorker.ts`（计算） |
| 调度 | `data/queue.ts`（串行 + 同 key 合并） | `render/renderClient.ts`（Worker 池） |
| 负载 | SQL / 事务 | 匹配 / 避让 / 安全数值计算 |

## 3. 一次「应用」的调用链

`TransitionEditor.vue` 点【应用】→ `startConfirm()`（`:498`）依次：

1. `doPreview()`（`:268`）→ `client.compute(a, b, transition, minSep)`
   算 **匹配 + 避让** → `buildRender()` 组装产物 → 存 `renderStore`。
2. `runSafety()`（`:295`）→ `client.safety(render, limits, 30)`。
3. `confirmMinDuration()`（`:442`）→ 最多 4 次 `client.safety(...)`（不同候选时长）。
4. `applyMinDuration()`（`:520`）→ 最多 6 轮（`doPreview` + `runSafety`）。

关键点：**匹配与时长无关**，安全**依赖时长** —— 这决定了缓存怎么切分（见 §6）。

## 4. Worker 池（`renderClient.ts`）

- 单例 `getRenderClient()`，首次创建 `K` 个 worker（`:52`）。
- `K = min(8, hardwareConcurrency − 1)`；核数 ≤ 2 时退回单 worker（`:37`）。
  - 例：10 核 → `min(8, 9) = 8`；4 核 → 3；2 核 → 1。
  - 留 1 核给主线程；上限 8（再多收益递减，还会和主线程抢核）。
- 所有 worker 共用一张 `pending: Map<id, {resolve, reject}>`：
  `post()` 分配自增 `id`（`:77`），返回后按 `id` 结算（`:63`）。
  worker 内部是浏览器保证的 **FIFO 串行**，同一 worker 上的多个任务会排队。
- 分派策略：
  - **匹配 `compute` → 单 worker**（`pick()` 轮询，`:85`）；
  - **安全 `safety` → 分块到多个 worker**（见 §5）。

## 5. 三类计算任务

### 5.1 匹配 `planTransition`（单 worker）

`core/transition.ts:602`。先建评分上下文 `buildCtx`，再按 `algorithm` 选求解器
（`solve`，`:583`）：

| 求解器 | 目标 | 特点 |
| --- | --- | --- |
| 匈牙利 `hungarian` | 最小化 Σ 加权得分 | 全局最优，最慢（约 ≤400 点） |
| 瓶颈 `bottleneck` | 最小化「最大」加权得分 | 压最慢点 / 最短耗时，较慢 |
| 拍卖 `auction` | 近似最小化 Σ 加权得分 | 大规模快，ε 可调 |
| 最近邻 `nearest` | 按得分贪心配对 | 非最优但快 |
| 按索引 `index` | 按序号配对 | 最快，仅点序一致时合理 |

加权评分（每项先归一到 `[0,1]`）：

```
score = wDist·(d/对角线) + wEven·min(1,|d−d*|/d*) + wAngle·(1−cos)/2
      + wGroup + wOrder·|名次差|/(n−1) + wRadial·|Δr|/对角线 + wAngular·Δθ/π
```

> 大 N 时 `matchNearest` 是 O(n·m) 的贪心（3000×3000 ≈ 900 万条候选边 + 排序），
> 是最重的匹配路径。**该路径不并行**：贪心排序是全局的，拆分（即使重排序）
> 会改变并列名次 → 用**缓存**消除重复（§6）。

### 5.2 避让 `planAvoidance`（单 worker）

`core/transition.ts:1237`。深度分层去冲突：

1. 采样若干帧（默认 400），建「任一时刻 3D 距离 < 阈值」的**并集冲突图**；
2. **DSATUR** 贪心着色（饱和度优先）；
3. 层号居中后乘平台 `bump(t)`（两端回 0，不破坏关键帧）。

深度偏移只沿 **z 轴**（正交于正面），只增大距离、绝不制造新冲突，单调安全。
结果烘进产物的 `RenderPayload.avoid`。

### 5.3 安全检测 `safetyCheck`（多 worker 分块）

`core/safety.ts`。对产物按 fps 采样（点数多时按 `MAX_SAMPLES=3_000_000` 自适应降采样），
逐架数值微分求速度 / 加速度分量，网格求全 3D 最小间距，与 **7 项限值**比较：

| 指标 | 类型 |
| --- | --- |
| 最小间距 `minSeparation` | 下限 |
| 水平速度 `hSpeed` | 上限 |
| 上升 / 下降速度 `upSpeed` / `downSpeed` | 上限 |
| 水平 / 上升 / 下降加速度 `hAccel` / `upAccel` / `downAccel` | 上限 |

**不通过禁止保存**（硬约束）。

## 6. 安全检测：分块并行且结果不变

### 6.1 采样口径

`safetySampling(render, fps)` 给出唯一口径：`steps`（步数）、`dt`、
`duration`、`n`（点数）。帧数 `frames = steps + 1`，第 i 帧进度 `t = i / steps`。

### 6.2 分块

把帧区间 `[0, steps]` 切成 K 段（无缝、无重叠）：

```
lo_c = ⌊ c · frames / K ⌋
hi_c = ⌊ (c+1) · frames / K ⌋ − 1        c = 0 … K−1
```

第 c 段发给第 c 个 worker，消息 `{ kind: 'safetyPart', render, limits, fps, lo, hi }`。

### 6.3 halo（边界多取 2 帧）

第 i 帧的**速度**用一阶差分（需要 i−1），**加速度**用二阶差分（需要 i−1、i−2）。
因此 worker `safetyCheckRange` 从 `start = max(0, lo−2)` 开始采样，
但**只统计 [lo, hi] 内的项**。

### 6.4 归约

`mergeSafety(parts, limits, steps)`：`minSeparation` 取 **min**，其余 6 项取 **max**，
`frames = steps + 1`。

### 6.5 为什么逐位一致

- 每个分块算出的「第 i 帧数值」与整段单线程在同一 i 上完全相同（同 `steps`、同 `dt`、同公式）；
- 所有分块的 i 区间**恰好拼成** `[0, steps]`；
- 全局峰值 = 各分块峰值的 min / max 之并。

⇒ 归约结果与单线程**浮点逐位相同**（min/max 无舍入误差）。

### 6.6 单 worker 兜底

`workers.length ≤ 1` 时走整段 `{ kind: 'safety' }`（`safetyCheck`）；
`safetyCheck` 本身也复用 `safetyCheckRange(0, steps)`，保证单源逻辑。

## 7. 缓存（同输入直接复用）

`renderClient.ts:24`，两张表都是简单 LRU（超 64 条丢最旧）。

| 缓存 | key | 收益 |
| --- | --- | --- |
| `matchCache` | `renderSignature(from,to,a,b,{algorithm,params})` + `\|sep{minSep}` | `applyMinDuration` 反复改时长时，**匹配/避让只算一次** |
| `safetyCache` | `safetySignature(render,limits,fps)` | 同一产物/限值/帧率的重复检测直接复用 |

- `renderSignature` **刻意不含 duration**（匹配与时长无关）。
- `safetySignature` 覆盖：帧 id、点位哈希、全部采样参数、时长/错峰、
  避让层（`layer` 哈希）、7 项限值、帧率。

## 8. 结果一致性验证

- 单测：`tests/safety.test.ts` 新增「分块并行 == 单次全量」用例，
  在含避让的 8 机场景对 `K = 1,2,3,4,7,16,64` 断言 `metrics/pass/failures/frames` 完全相等。
- 全量：`pnpm test`（99 例）；真实 3000 机数据上对 `K = 1,2,3,4,8`
  比对 `metrics / failures` —— **逐位一致**。

## 9. 实测性能（Apple M1 Max，真实 3000 机数据）

| 项 | 数值 |
| --- | --- |
| 单次安全扫描（单线程） | ≈ 2163 ms |
| 避让建图（一次 compute） | ≈ 827 ms |
| `render` 结构化克隆 | ≈ 5.8 ms / 次 |

安全扫描分块后的**墙钟**（≈ 最慢单块）：

| K | 4 | 6 | 8 | 10 |
| --- | --- | --- | --- | --- |
| 估计总耗时 | ≈ 572 ms | ≈ 405 ms | ≈ 320 ms | ≈ 279 ms |

选 `K = min(8, 核数−1)`：收益接近线性，且不与主线程抢核。

## 10. 设计取舍与后续

- **匹配不并行**：贪心是全局排序，拆分改变并列名次 → 用缓存消除重复。
- **避让不并行**：一次 compute 只算一次（被匹配缓存覆盖），收益有限。
- **未做「render 常驻 worker」**：目前每次分块仍把整份 `render` 克隆给参与的 worker
  （5.8 ms，可忽略）。若未来点数/帧数增大，可改为 worker 按签名缓存 render，
  只传 `sig + duration + 分块`。
- **后续可做**：把避让建图的帧采样也分块并行（并集冲突图天然可并行）。
