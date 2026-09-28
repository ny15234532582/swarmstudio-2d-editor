# SwarmStudio 二维点阵编辑器 · 设计说明

## 1. 目标与范围

在 Vue 3 + TypeScript 下，用 PixiJS 渲染一个二维点阵编辑器，支持 20,000 点的
编辑与交互；项目数据以 SQLite(WASM) 存放于 OPFS，读写全部在 Web Worker 中完成，
主线程与 Worker 之间用任务队列解耦。数据保留三维坐标 `z`，画布只按 XY 编辑。

## 2. 系统结构

```
┌───────────────────────────── 主线程 ─────────────────────────────┐
│  Vue 组件 (ui/)                                                   │
│      │ 只发命令 / 读状态                                           │
│  EditorStore (state/)  ← 运行时唯一事实源（内存，纯对象）          │
│      │ ① 渲染事件 points:*/selection:*  → PixiRenderer (render/)   │
│      │ ② mutation 流（仅已提交的数据变更）                          │
│  DataService (data/service.ts)  ← 缓冲 + 防抖                       │
│      │                                                             │
│  DataClient ── TaskQueue（串行 / 合并 / 错误传播）                  │
└───────────────┬────────────────────────────────┬──────────────────┘
                │ postMessage（结构化克隆）        │ 一次性 transfer 像素
┌───────────────▼──────────────────┐  ┌──────────▼──────────────────┐
│ 数据 Worker (data/worker.ts)      │  │ 计算 Worker (compute/)      │
│  顺序队列 → Repository(SQL)       │  │  灰度/二值化/抽稀 → Point[] │
│   → SQLite(WASM) → opfs-sahpool   │  └─────────────────────────────┘
│   → OPFS /swarmstudio.sqlite3     │
└───────────────────────────────────┘
```

分层原则：`core`（领域）← `state`（运行时）← `data`/`compute`（不依赖 Vue）← `ui`。
`data`、`compute` 只单向依赖 `core`（与 `state` 的类型），UI 与 Worker 之间没有直接调用。

### 2.1 分层速览

| 目录 | 角色 | 内容 | 依赖 |
| --- | --- | --- | --- |
| `core/` | **领域内核**（叶子，谁都能用） | 类型、`Operation` 契约、校验、几何/空间索引、ID、测试数据 | 无 |
| `state/` | **内存事实源** | `EditorStore` + `HistoryManager` + 事件总线 | `core` |
| `render/` | **显示层（PixiJS）** | 渲染、视口变换、指针交互 | `core`、`state` |
| `data/` | **持久化层（SQLite/OPFS）** | Worker + 任务队列 + SQL + 迁移 | `core`（+ `state` 类型） |
| `compute/` | **计算层（独立 Worker）** | 图片→点阵的纯计算与 Worker 通信 | `core` |
| `ui/` | **页面层** | Vue 组件、状态桥接、命令转发 | 以上全部 |

说明：
- `core` 是共享内核，不是「业务逻辑大杂烩」——它只放纯数据与纯函数，不放状态与副作用。
- `compute` 与 `data` 是**平行的两个 Worker 层**，不是通用 util；通用的小工具（如点在多边形内判定）放在 `core`。
- 依赖方向单一：`ui → render/data/compute/state → core`，反向依赖为零（`data` 只引用 `state` 的类型）。

### 2.2 通信模型：两条通道 + 两层队列

`EditorStore` 对外广播**两类事件**，走两条完全不同的通道：

```
                         ┌─ 通道① 渲染事件 points:*/selection:*（同步、同线程）
EditorStore.events ──────┤        → PixiRenderer 直接调 Pixi API 改 Sprite 属性
                         │        （不同线程，不走队列，不进数据库）
                         │
                         └─ 通道② mutation / history:change（仅已提交的数据变更）
                                  → DataService 缓冲 + 400ms 防抖
                                  → TaskQueue（主线程：串行 + 同 key 合并）
                                  → postMessage（结构化克隆，跨线程）
                                  → Worker 顺序队列（incoming 循环）
                                  → Repository → db.transaction() → SQLite
```

要点：

- **渲染不是「发命令给渲染器」**，而是渲染层订阅事件后**直接操作 Pixi API**
  （`sprite.x/y`、`sprite.tint`、`addChild`/`destroy`），真正的绘制由 Pixi 的 ticker 驱动。
- **两条通道互不干扰**：拖动中的 `previewMove` 只发通道①，因此只有画面变化、
  没有历史、没有磁盘写入；`pointerup` 的 `commitMove` 才走通道②。
- **队列分两层，职责不同**：
  - 主线程 `TaskQueue`：调度层——串行化请求、把同 key 的待执行任务**合并**
    （连续保存合并为一次写），并统一错误传播；
  - Worker 内 `incoming` 顺序队列：执行层——保证 SQLite 单连接上的写操作
    **依次进入事务**，不出现交叉事务。
- **跨线程只传纯数据**（`Point` / `Operation` / `Mutation`），不传类实例、
  更不传 Vue 的 reactive 代理（会被结构化克隆拒绝）。

## 3. 数据模型与事实源（对应 6.1）

**唯一事实源是内存中的 `EditorStore.project`**，不是 PixiJS 显示对象，也不是数据库。

### 3.1 两层存储：内存（权威） + 磁盘（持久化）

系统明确分成两层，职责不重叠：

| 层 | 载体 | 角色 | 谁在用 |
| --- | --- | --- | --- |
| 内存层 | `EditorStore.project` + `HistoryManager` | **权威事实源**，决定一切行为 | 渲染、命中、交互、Undo/Redo 只读它 |
| 磁盘层 | OPFS 上的 SQLite（`projects/points/history`） | **持久化投影**，保证刷新/迁移不丢 | 只在加载与保存时参与 |

同步契约（单一写入方）：

- **写**：内存先改 → 广播已提交 `mutation` → 队列合并 → SQL 事务。
- **读**：SQL → `loadProject`/`replacePoints` → 物化进内存。
- 磁盘只跟随内存，**不存在两个各自为政的真相**；任何时候都可以「以内存重建磁盘」，
  也可以「以磁盘重建内存」。
- 一致性：每批写入与历史覆盖在同一事务；写失败时把 mutation 放回缓冲重试。
- 丢数据窗口：自动保存有 400ms 防抖，页面隐藏 / `pagehide` 时会立即 flush，
  尽量把窗口内的最后一笔变更落盘。

### 3.2 其它设计点

- 点位数据 / 选中状态 / Pixi 显示对象三者分离：
  - 点位数据：`EditorStore.project.points: Point[]`（普通对象，非响应式）
  - 选中状态：`EditorStore.selection: Set<string>`（界面临时状态）
  - 显示对象：`render/renderer.ts` 内 `Map<id, Sprite>`，是事实源的单向投影，可随时重建
- 为什么不用 Vue 的深度响应式持有两万个点：代理读写与依赖收集开销大，
  改用「显式事件 + revision 计数」驱动 UI，点位高频移动由 Pixi 直接增量更新。
- 点位 ID 唯一：`core/id.ts` 用「时间戳 + 自增计数 + 会话随机盐」生成；
  数据库以 `PRIMARY KEY (project_id, id)` 兜底。
- 业务数据 vs 渲染数据使用不同结构：业务是 `Point[]`，渲染是 Sprite Map，
  二者通过事件同步，不共享对象。

## 4. 模块职责（对应 6.2）

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 项目数据 | `state/store.ts` | 事实源、索引、空间网格缓存 |
| 点位编辑 | `state/store.ts` | 增删移改，构造 Operation |
| 选中状态 | `state/store.ts` | selection 集合与选择模式 |
| Undo/Redo | `state/history.ts` + `core/operations.ts` | 双栈 + 可序列化 Operation |
| PixiJS 渲染 | `render/renderer.ts` | Sprite 池、增量更新、选中高亮、FPS |
| 视口交互 | `render/viewport.ts` + `render/interaction.ts` | 平移缩放、命中、拖动、框选、套索 |
| 存储 | `data/*` | SQLite + OPFS + Worker + 队列 |
| 几何工具 | `core/geometry.ts` | 点在多边形内判定（射线法）、包围盒 |
| JSON 导入导出 | `data/json.ts` | 校验后导入 / 导出下载 |
| 图片→点阵 | `compute/*` | 解码、二值化、抽稀，独立 compute worker |
| Vue 页面与 UI | `ui/*` | 展示与命令转发 |

## 5. 数据流：一次「拖动点并保存」（对应 6.3）

```
用户按下并拖动
  → InteractionController.pointerdown：命中测试(空间网格)、确定拖动集合
  → pointermove：EditorStore.previewMove()   [只改数据 + 重绘，不写历史、不产生 mutation]
  → pointerup：EditorStore.commitMove()
        ├─ 广播 mutation(move) ─────────────┐
        └─ history.push(move Operation)      │
                                             ▼
                             DataService 缓冲 mutation + 读取当前历史
                                             │ 400ms 防抖
                                             ▼
                             TaskQueue.enqueue(key=changes:<id>, merge)
                                             │ 串行 postMessage
                                             ▼
                             Worker：一个事务内 UPDATE points + 覆盖 history
```

- 拖动过程**不写盘、不写历史**；一次拖动只产生**一条** `move` Operation、
  **一次** SQL 批量 `UPDATE`。这同时回答了 4.3「连续拖动是否合并」。
- 撤销 / 重做也走同一路径：`revertOperation` / `applyOperation` 调用相同的低层写方法，
  因此会自动产生正确的反向 mutation，数据库与界面始终一致。

## 6. Operation 契约与 Undo/Redo（对应 4.3）

所有可撤销操作被归一化为纯数据 `Operation`（`core/operations.ts`）：

```ts
type Operation =
  | { kind: 'add';    label; points: Point[] }
  | { kind: 'remove'; label; points: Point[] }
  | { kind: 'move';   label; before: [id,x,y][]; after: [id,x,y][] }
  | { kind: 'color';  label; ids: string[]; after: RGB; before: [id,r,g,b][] }
```

优点：可序列化（直接写进 SQLite `history` 表）、可结构化克隆（跨 Worker）、
`apply/revert` 是确定性函数。

- **Undo 后重新编辑**：`pushUndo` 会清空 redo 栈，符合直觉。
- **历史体积**：move/color 只存增量坐标；栈深上限 `HISTORY_LIMIT = 100`，
  与 `history` 表保留条数一致（`saveHistory` 只写最近 100 条）。
- **历史持久化**：每次提交把当前 Undo 栈覆盖写入 `history` 表；重新打开项目时读回，
  刷新后仍可继续撤销（已在冒烟测试中验证）。
- 重做栈不持久化（刷新后为空），这是有意的取舍。

## 7. 渲染设计

- **共享纹理 + Sprite**：`Graphics` 画一次圆并 `generateTexture`，所有点复用它；
  20,000 个 Sprite 由 GPU 合批。
- **增量更新**：`points:move/color/add/remove` 事件只改对应 Sprite 的坐标 / tint / 存活，
  不重建场景。
- **选中高亮**：独立 `ringLayer` + 环形纹理 Sprite 池，避免与点位互相影响层级。
- **平移缩放**：只改世界容器的 `position/scale`，O(1)，不重算点位。
- **命中测试**：均匀网格 `SpatialGrid`（`core/spatial.ts`），
  点击 O(1) 取候选、框选按网格遍历，避免 20,000 次全量距离计算。
- **WebGL 优先**：`preference: 'webgl'`，稳定性与兼容性优于 WebGPU。

### 7.1 为什么渲染不放进 Worker（取舍）

PixiJS v8 是官方支持 Worker 渲染的（`DOMAdapter.set(WebWorkerAdapter)`，
`app.canvas` 变为 `OffscreenCanvas`），所以这是一个真实可选项，不是能力问题。
本题最终选择**渲染留在主线程**，理由：

1. **瓶颈不在主线程 JS**：20,000 个点用共享纹理 Sprite 合批，每帧主线程只做
   少量 transform 提交，真正的耗时在 GPU 光栅化。把渲染搬到 Worker 并不加速 GPU，
   也无助于无头环境下的软件光栅（同一个 CPU）。
2. **状态要过两遍**：渲染进 Worker 后，渲染线程需要自己的一份点位数据，
   每次 move/color/add/remove 都要再跨线程同步一次，等于在现有「内存→磁盘」之外
   又加一条「内存→渲染」通道，复杂度和延迟都上升。
3. **交互/命中变复杂**：指针事件仍在主线程。命中测试要么在主线程复制空间索引，
   要么每次 pointermove 往 Worker 往返，拖动跟手性变差。当前设计在主线程用
   `SpatialGrid` 直接命中，O(1) 且零往返。
4. **与部署目标冲突**：与渲染 Worker 高效共享点位数据要靠 `SharedArrayBuffer`，
   而它要求 COOP/COEP 响应头——这正是我们选 `opfs-sahpool` 时特意避开的约束。

**什么时候才值得搬**：场景以 CPU 计算为主（大量滤镜、几何重建、逐帧动画），
或主线程被其它 UI 工作占据时。本项目的合理做法是把**纯计算**（如图片二值化生成点位）
放进独立的 compute worker，而不是把 Pixi 搬走。

### 7.2 GPU 侧优化（填充率优先）

这一层已经合批（points 共用一个纹理 = 常数个 draw call），所以真正的瓶颈是
**填充率 / overdraw**，优化都围绕它展开：

已实现：

1. **关闭 MSAA，用带抗锯齿的纹理代替**：点纹理用 2D canvas 径向渐变生成（柔和边缘），
   于是可以把 `antialias` 关掉，省掉一次全屏多重采样解析。
   同一无头软件渲染环境下实测 **28 FPS → 60 FPS**，是收益最大的一项。
2. **分辨率档位 + 动态分辨率**：渲染分辨率按 `min(devicePixelRatio, cap)` 封顶
   （高=2 / 均衡=1.25 / 流畅=1），避免 Retina 上 4 倍填充量；
   `auto` 档按实时 FPS 在 0.5~1.0 之间自动升降，压力大时降分辨率而不是掉帧。
3. **不透明画布**：`backgroundAlpha: 1` + `premultipliedAlpha`，省掉 alpha 合成。
4. **请求独显**：`powerPreference: 'high-performance'`，多 GPU 设备避免落到核显。
5. **只改属性、不重建几何**：移动/改色只改 Sprite 的 `x/y/tint`，不触发批次重建。
6. **选中的环单独一层**：避免与点位互相打断合批。

候选（按性价比排序，尚未实现）：

- **视口裁剪**：`CullerPlugin` + `cullable`，放大后大量点在屏外时收益明显；
  但全部可见时会增加逐对象包围盒计算的 CPU 开销，适合做成开关。
- **同屏点半径封顶**：高倍放大时限制单点在屏幕上的像素半径，直接给 overdraw 封顶。
- **实例化网格**：十万级点位改用 instanced mesh，把顶点属性压到最少。
- **纹理图集**：若未来点有多种外观（图标/形状），合并到一张图集避免断批。

### 7.3 套索选择（工具化，而非修饰键）

需求是「手动圈出任意区域选中点位」，做法：

- **交互**：工具栏切换「框选 / 套索」。套索模式下左键直接开始画自由多边形，
  移动时按最小世界距离抽点（避免顶点过密），松开后闭合多边形做命中判定；
  Shift + 套索为追加选择。
- **为什么做成独立工具而不是某个修饰键**：点云密集时画面里几乎没有「空白区域」，
  如果沿用「命中点就拖动、点空白才框选」的规则，套索几乎无法起笔。
  工具化后套索模式不参与点命中，任何位置都能起笔。
- **命中**：先用空间网格取多边形包围盒内的候选点（`polygonBounds` + `queryRect`），
  再逐点做射线法判定（`pointInPolygon`，even-odd）——把 O(n) 全量判断降为
  「包围盒候选 + 精确判断」。
- **绘制**：套索路径用一层 SVG `<polygon>` 覆盖在 Pixi 画布之上（屏幕坐标），
  与视图变换解耦；数据侧只保留世界坐标多边形。
- **可测试性**：点在多边形内的判定是纯函数（`core/geometry.ts`），
  覆盖凸多边形、凹多边形、三角形与顶点不足等边界。

## 8. 图片导入 → 二值化 → 生成点位（compute worker）

对应题目选做项「图片导入」「图片二值化并生成点位」「使用 Worker 处理数据」。

### 8.1 流程

```
选择图片
  → 主线程：createImageBitmap 解码，缩到最长边 ≤1600（控制内存 + 超采样）
  → getImageData 取像素，一次性 transfer 给 compute worker
  → Worker：灰度化(luma) → 阈值二值化(可反相, 丢弃透明像素)
            → 按目标点数算网格步长抽稀 → 映射为居中缩放的 Point[]
  → 主线程：预览图实时回显；确认后走既有 loadPointsAsProject 落 SQLite
```

### 8.2 为什么单独开 compute worker

- 一张图动辄几百萬像素，灰度化 + 阈值 + 采样是纯 CPU 循环，放主线程会卡住 UI；
- 与存储 Worker 分离，图片运算不占 SQLite 的事务时间；
- 像素只在载入时传一次，之后调参只回传小预览，避免反复搬运大图。

### 8.3 关键设计点

- **抽稀**：`step = round(sqrt(保留像素数 / 目标点数))`，让生成点数可控在几千到几万；
- **坐标映射**：以图片中心为原点，按目标世界宽度等比缩放，`z = 0`；
- **颜色**：可选原图颜色（保留素材观感）或统一主题色；
- **纯函数核心**：`src/compute/imageProcessor.ts` 不依赖 DOM/Worker，
  因此二值化、抽稀、坐标映射都能在 Node 下单测（8 个用例）。
- **踩坑记录**：Vue 的 `reactive` 代理（含嵌套 `fixedColor`）无法被 `postMessage`
  结构化克隆，直接传会抛 `DataCloneError`——必须先在主线程拍成纯对象再发。

## 9. 存储设计（SQLite + OPFS + Worker + 队列）

### 9.1 为什么 SQLite 而不是直接读写 OPFS 文件

直接用 OPFS 文件 API 时，每次保存要么整文件重写、要么自己实现增量编码；
用 SQL 封装后，项目列表是一条查询、点位是行、历史是表，增删改查与事务都由数据库保证。

### 9.2 表结构

```sql
PRAGMA foreign_keys = ON;
PRAGMA user_version;   -- 结构版本，迁移依据

projects(id PK, name, version, created_at, updated_at)
points(project_id, id, x, y, z, r, g, b, group_id,
       PK(project_id,id), FK->projects ON DELETE CASCADE)
history(project_id, seq, label, op, created_at,
       PK(project_id,seq), FK->projects ON DELETE CASCADE)
```

`op` 列存 Operation 的 JSON；`version` 与 `user_version` 分别管数据格式与结构。

### 9.3 VFS 选择

使用 `opfs-sahpool`：无需 COOP/COEP、批量性能好、可静态托管；
代价是不支持多标签并发写（单用户编辑器可接受）。初始化失败时自动降级为内存库
并在状态栏提示，保证应用仍可用。

### 9.4 任务队列（主线程）

`data/queue.ts` 的 `TaskQueue`：concurrency=1 保证串行；相同 `key` 的待执行任务
通过 `merge` 合并——所以「连续拖动 / 连续改色」在 400ms 窗口内只会合并成一次写库。
Worker 内还有一层顺序执行循环，确保请求按到达顺序进入事务。

### 9.5 写入时机

- 新增 / 删除 / 移动 / 改色：提交后防抖 400ms 增量写（`applyChanges`）。
- 载入测试数据 / 导入：`replacePoints` 全量替换（事务）。
- 拖动过程不写（见第 5 节）。
- 每批写入与历史覆盖在同一事务内，避免写一半。

## 10. 性能与可扩展性（对应 6.4）

- **移动一个点是否重绘全部**：不。只改该点（及选中集合）的 Sprite 属性，配合空间网格命中。
- **批量改色如何减少重复计算**：一次构造 id 列表 → 一次 `setColors` → 一次 tint 更新 →
  SQL 侧一条 prepared statement 循环 `UPDATE`（同一事务）。
- **点数继续扩大（如十万级）优先改什么**：
  1. 命中与框选保持网格索引（已具备），必要时换更高维索引；
  2. 存储侧把逐行 `UPDATE` 改为分块/多值写入，减少语句调用；
  3. 跨线程用列式 TypedArray 传输点位，减少结构化克隆；
  4. 引入离屏渲染 / 分块可见性裁剪，控制同屏 Sprite 数量。
- **图片导入与点位生成是否可复用**：可以。只要能产出 `Point[]`，
  走 `replacePoints` 即可；`core/testdata.ts` 已示范。
- **大量操作记录如何合并压缩**：Operation 本身只存增量；队列按 key 合并同批写入；
  历史栈与表都限长 100；未来可对 move 做「同一 id 多次移动只保留首尾」。

## 11. 测试与验证

- 单元测试（`pnpm test`，40 例）：仓储层在 Node 内存 SQLite 上真实执行 SQL，
  覆盖迁移、增量写入、历史裁剪、级联删除；队列覆盖串行 / 合并 / 错误隔离；
  `imageProcessor` 覆盖二值化、反相、透明像素、抽稀步长与坐标映射；
  `geometry` 覆盖套索的点在多边形内判定。
- 端到端：
  - `pnpm smoke`：无头 Chrome 验证 OPFS(opfs-sahpool) 落盘、20,000 点加载、编辑、
    自动保存、刷新后从 SQLite 重新打开、撤销历史恢复。
  - `pnpm smoke:image`：注入一张图片 → 二值化预览 → 生成点位 → 作为新项目落库。
  - `pnpm smoke:select`：单击选中 → Shift 加选 → 套索圈选 → Shift 套索追加。
- 性能观测：界面实时 FPS；无头软件渲染下 20,000 点约 60 FPS
  （关闭 MSAA 前约 28 FPS），真机 GPU 下更高。

## 12. 技术学习记录（对应第 7 节）

- 阅读资料：SQLite WASM 官方文档《Persistent Storage Options》与 `@sqlite.org/sqlite-wasm`
  仓库 README；PixiJS v8 的 `Application` / `Sprite` / `Environments` / `Performance Tips` 文档。
- 首次使用的 API：`installOpfsSAHPoolVfs`、`OpfsSAHPoolDb`、SQLite OO1 的
  `prepare/step/transaction/selectArrays`、`Application.init({ preference, powerPreference })`、
  `renderer.resize(w,h,resolution)` 动态分辨率、`createImageBitmap` + 离屏 canvas 取像素。
- 遇到的问题：
  - OPFS `opfs` VFS 需要 COOP/COEP 与 SharedArrayBuffer，静态托管不便 → 改用 `opfs-sahpool`。
  - Vite 会把 wasm 的 `new URL(..., import.meta.url)` 处理错 → `optimizeDeps.exclude`
    并让 Vite 直接处理资源，构建产物正确输出 `sqlite3-*.wasm`。
  - 拖动结束只登记历史、不发 mutation，导致移动未落库 → 在 `commitMove` 显式广播 mutation。
  - 打开项目时 `history.load` 会触发 dirty → 用 `suppress` 标志避免误标脏。
  - Vue 的 `reactive` 代理无法 `postMessage` 克隆（`DataCloneError`）→ 发送前先拍成纯对象。
  - 关闭 MSAA 后点变粗糙 → 改用 2D canvas 径向渐变生成纹理，兼顾画质与性能。
- 仍未解决：多标签并发写、Redo 持久化、逐行 UPDATE 的批量优化。

## 13. 取舍与后续

- 选择 SQLite 换取了结构化与事务能力，代价是引入约 870KB（gzip ~400KB）的 wasm。
- 选择 `opfs-sahpool` 换取了免 COOP/COEP 与性能，代价是放弃多标签并发。
- 后续可扩展：分组 / 锁定、图片抖动(halftone)提升观感、点位列式传输、历史压缩策略。
