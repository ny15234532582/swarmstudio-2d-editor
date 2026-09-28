# SwarmStudio 二维点阵编辑器 · 设计说明

## 1. 目标与范围

在 Vue 3 + TypeScript 下，用 PixiJS 渲染一个二维点阵编辑器，支持 20,000 点的编辑与交互；
项目数据以 SQLite(WASM) 存放于 OPFS，读写全部在 Web Worker 中完成，主线程与 Worker 之间
用任务队列解耦。数据保留三维坐标 `z`，画布只按 XY 编辑。

## 2. 系统结构

**分层与依赖**（依赖只能向内）：

| 目录 | 角色 | 依赖 |
| --- | --- | --- |
| `core/` | 领域内核：类型、`Operation` 契约、校验、几何、空间索引、ID | 无 |
| `state/` | 内存事实源：`EditorStore` + `HistoryManager` + 事件总线 | `core` |
| `render/` | 显示层：PixiJS 渲染、视口、指针交互 | `core`、`state` |
| `data/` | 持久化层：Worker + 任务队列 + SQL + 迁移 | `core`（+ `state` 事件总线/类型） |
| `compute/` | 计算层：图片→点阵（独立 Worker） | `core` |
| `ui/` | 页面层：Vue 组件、状态桥接、命令转发 | 以上全部 |

**主链路**：

```
Vue(ui) → EditorStore(state)
  - render（PixiJS）：订阅渲染事件，直接改 Sprite
  - data（SQLite/OPFS）：mutation → TaskQueue → Worker → 事务写库
  - compute（Worker）：图片 → Point[] → 回灌 EditorStore
```

关键约定：

- 事实源只有一个：内存中的 `EditorStore.project`；渲染层与数据库都是它的投影，随时可重建。
- 跨线程只传纯数据（`Point` / `Operation` / `Mutation`），不传类实例，也不传 Vue 的 reactive 代理。

### 2.1 两条通信通道

`EditorStore` 广播两类事件，走两条完全不同的通道：

| | 通道① 渲染 | 通道② 持久化 |
| --- | --- | --- |
| 事件 | `points:add/remove/move/color`、`points:lock`、`groups:change`、`selection:change` | `mutation`、`history:change` |
| 触发 | 任何数据变化（含拖动预览） | 仅**已提交**的操作（含 Undo/Redo） |
| 处理 | 渲染层订阅后直接调 Pixi API 改 Sprite | 进队列 → Worker → SQL |
| 跨线程 | 否（同线程同步） | 是（`postMessage` 结构化克隆） |
| 落盘 | 否 | 是 |

渲染事件**不进队列**：Pixi 收到事件后直接改对象属性，真正的绘制由 ticker 驱动。

### 2.2 两层任务队列

1. **主线程 `TaskQueue`**：调度层——串行化请求，并把同 key 的待执行任务**合并**
   （连续保存合并为一次写），统一错误传播。
2. **Worker 内顺序队列**：执行层——`while` 循环依次取出请求，保证 SQLite 单连接上
   不出现交叉事务。

## 3. 数据模型与事实源（对应 6.1）

```ts
interface Point {
  id: string; x: number; y: number; z: number
  r: number; g: number; b: number
  groupId?: string; locked?: boolean
}
```

### 3.1 两层存储

| 层 | 载体 | 角色 | 谁在用 |
| --- | --- | --- | --- |
| 内存层 | `EditorStore.project` + `HistoryManager` | **权威事实源**，决定一切行为 | 渲染、命中、交互、Undo/Redo |
| 磁盘层 | OPFS 上的 SQLite（`projects`/`points`/`history`/`groups`） | 持久化投影 | 只在加载与保存时参与 |

- 写：内存先改 → 广播已提交 `mutation` → 队列合并 → SQL 事务。
- 读：SQL → 物化进内存。
- 磁盘跟随内存，不存在两个事实源；任一方都能重建另一方。

### 3.2 其它设计点

- **状态分离**：`selected` / `hovered` / `dragging` 属于界面临时状态，不写入项目数据；
  选中状态保存在 `EditorStore.selection`（`Set<string>`）。Pixi 显示对象是投影，不作为数据。
- **不用 Vue 深度响应式持有 2 万个点**：代理读写开销大。改用「显式事件 + revision 计数」
  驱动 UI，点位高频移动由 Pixi 直接增量更新。
- **ID 唯一**：`core/id.ts` 用「时间戳 + 自增计数 + 会话随机盐」生成；数据库以
  `PRIMARY KEY (project_id, id)` 兜底。
- **版本两套**：

  | 版本 | 位置 | 说明 |
  | --- | --- | --- |
  | 项目数据格式 | `Project.version` | 随项目保存；v2 起含 `locked` 与分组 |
  | 数据库结构 | `PRAGMA user_version` | 由 `data/schema.ts` 迁移维护 |

### 3.3 分组与锁定

- **分组**：`Group { id, name, color }` 注册表放在 `Project.groups`，点位只存 `groupId` 引用；
  校验时丢弃指向不存在分组的 `groupId`，避免孤儿引用。
- **锁定**：只存在点位上（`Point.locked`），组不单独存锁定态；「锁定整组」= 批量锁定组内点。
  组列表的锁状态由 `isGroupLocked()` 派生（全部组员已锁），只有一个事实来源。
- **联动规则单一入口**：`selectMany()` 直接跳过锁定点 → 锁定点永远进不了选择，
  于是拖动 / 删除 / 改色 / 框选 / 套索自然全部排除；`pick()`（画布命中）也跳过；
  渲染层用 `alpha` 变暗表示锁定。
- **可撤销**：成组 / 取消分组 / 锁定都是 `Operation`，拆组时「组注册表 + 点位归属」
  在同一 Operation 的 apply/revert 内一起改，不会半途不一致。

## 4. 模块职责（对应 6.2）

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 项目数据 | `state/store.ts` | 事实源、id 索引、空间网格缓存 |
| 点位编辑 | `state/store.ts` | 增删移改、锁定、构造 Operation |
| 选中状态 | `state/store.ts` | selection 集合与选择模式 |
| Undo/Redo | `state/history.ts` + `core/operations.ts` | 双栈 + 可序列化 Operation |
| PixiJS 渲染 | `render/renderer.ts` | Sprite 池、增量更新、选中高亮、FPS |
| 视口交互 | `render/viewport.ts` + `render/interaction.ts` | 平移缩放、命中、拖动、框选、套索 |
| 几何工具 | `core/geometry.ts` | 点在多边形内判定（射线法）、包围盒 |
| 存储 | `data/*` | SQLite + OPFS + Worker + 队列 |
| JSON 导入导出 | `data/json.ts` | 校验后导入 / 导出下载 |
| 图片→点阵 | `compute/*` | 解码、二值化、抽稀（独立 Worker） |
| Vue 页面与 UI | `ui/*` | 展示与命令转发 |

## 5. 数据流：一次「拖动点并保存」（对应 6.3）

1. `pointerdown`：空间网格做命中测试，确定拖动集合。
2. `pointermove`：`EditorStore.previewMove()` —— 只改数据、只重绘，**不写历史、不落盘**。
3. `pointerup`：`commitMove()` —— 广播 `mutation(move)`，并 `history.push` **一条** move 操作。
4. `DataService` 缓冲 mutation，**400ms 防抖**后交给 `TaskQueue`（同 key 合并）。
5. `postMessage` → Worker 顺序队列 → `Repository` 在**一个事务**里 `UPDATE points` + 覆盖 `history` + `groups`。

要点：拖动过程零历史、零写盘；一次拖动 = 一条历史、一次批量 SQL。撤销 / 重做走同一路径
（`applyOperation` / `revertOperation` 调用相同低层方法），自动产生正确的反向变更。

## 6. Operation 契约与 Undo/Redo（对应 4.3）

所有可撤销操作归一化为纯数据 `Operation`：

```ts
type Operation =
  | { kind: 'add';    label; points: Point[] }
  | { kind: 'remove'; label; points: Point[] }
  | { kind: 'move';   label; before: [id,x,y][]; after: [id,x,y][] }
  | { kind: 'color';  label; ids: string[]; after: RGB; before: [id,r,g,b][] }
  | { kind: 'group';   label; group: Group; members: string[]; before: [id,groupId|null][] }
  | { kind: 'ungroup'; label; group: Group; members: string[] }
  | { kind: 'lock';    label; locked: boolean; entries: [id,wasLocked][] }
```

- 可序列化（直接写进 `history` 表）、可结构化克隆（跨 Worker）、`apply/revert` 是确定性函数。
- **Undo 后重新编辑**：`pushUndo` 清空 redo 栈，符合直觉。
- **历史体积**：move/color 只存增量；栈深上限 `HISTORY_LIMIT = 100`，与 `history` 表保留条数一致。
- **历史持久化**：每次提交把当前 Undo 栈覆盖写入 `history` 表；重开项目时读回，
  刷新后仍可继续撤销。Redo 栈不持久化（有意取舍）。

## 7. 渲染设计

- **共享纹理 + Sprite**：圆点纹理由 2D canvas 生成一次，所有点复用，由 GPU 合批，
  20,000 点接近常数个 draw call。
- **增量更新**：`points:*` 事件只改对应 Sprite 的坐标 / tint / alpha / 存活，不重建场景。
- **选中高亮**单独一层，避免打断合批；**平移缩放**只改世界容器 `position/scale`，O(1)。
- **命中测试**：均匀网格 `SpatialGrid`，点击 O(1) 取候选，框选 / 套索按网格遍历。
- **WebGL 优先**：`Application.init({ preference: 'webgl' })`，稳定性优于 WebGPU。

### 7.1 为什么渲染不放进 Worker

PixiJS v8 支持 Worker 渲染（`WebWorkerAdapter` + `OffscreenCanvas`），但本项目保持主线程：

1. 瓶颈是 GPU 填充率，搬 Worker 不加速 GPU，也无助于软件渲染；
2. 渲染线程要再持一份点位数据，等于多一条跨线程同步通道；
3. 指针事件在主线程，命中要么复制索引、要么每次往返，拖动跟手性变差；
4. 高效共享数据需 `SharedArrayBuffer` → 需 COOP/COEP，正是选 `opfs-sahpool` 时避开的约束。

更合理的做法是把**纯计算**（图片二值化）放进独立 compute worker，而不是搬 Pixi。

### 7.2 GPU 侧优化（填充率优先）

已实现：关闭 MSAA（改用带抗锯齿的纹理）、分辨率档位 + 动态分辨率、不透明画布、
请求独显、只改属性不重建几何、选中环单独成层。

- **最大收益来自关闭 MSAA**：同环境实测 20,000 点 **28 → 60 FPS**（改 WebGL + 关 MSAA
  后，冒烟里的 reload 也稳定了）。
- **分辨率档位按「相对设备像素比」定义**：高 = 原生、均衡 = `dpr×0.75`、流畅 = `dpr×0.5`，
  再 clamp 到 `[0.5, 2]`；`auto` 按 FPS 在 `autoScale ∈ [0.5, 1]` 自适应。
  用比例而非绝对值，是因为旧写法 `min(dpr, cap)` 在 1x 屏上三档恒为 1.0x、菜单形同虚设。

  | 档位 | DPR=1 | DPR=2（Retina） |
  | --- | --- | --- |
  | 高（原生） | 1.00x / 60 FPS | 2.00x / 23 FPS |
  | 均衡（75%） | 0.75x / 60 FPS | 1.50x / 37 FPS |
  | 流畅（50%） | 0.50x / 60 FPS | 1.00x / 60 FPS |

候选（未实现）：视口裁剪（`CullerPlugin`，放大后收益明显）、同屏点半径封顶、
十万级改用实例化网格、纹理图集。

### 7.3 套索：修饰键而非模态工具

**Alt/Option + 左键拖拽**进入套索：按下即画自由多边形，移动时按最小世界距离抽点，
松开后闭合做点在多边形内判定（射线法）。Shift + Alt 为追加。

为什么不做成模态工具：点云密集时画面几乎没有「空白区域」，套索必须能从任意位置起笔
（所以不先做点命中）；但一旦做成模式，左键在该模式下就失去拖拽能力，用户很容易卡住
以为「拖不动了」。修饰键同时满足两点：默认永远是拖拽/框选，需要圈选时再按 Alt。

## 8. 图片导入 → 二值化 → 生成点位（compute worker）

1. 主线程 `createImageBitmap` 解码，缩到最长边 ≤1600（控内存 + 超采样），`getImageData` 取像素；
2. 像素**一次性 transfer** 给 compute worker；
3. Worker：灰度化 → 阈值二值化（可反相、丢弃透明像素）→ 按目标点数算网格步长抽稀
   → 以图片中心为原点、按目标世界宽度等比缩放为 `Point[]`（`z = 0`）；
4. 主线程实时预览；确认后走既有 `loadPointsAsProject` 落库。

- 抽稀：`step = round(sqrt(保留像素数 / 目标点数))`，生成点数可控。
- 纯函数核心 `compute/imageProcessor.ts` 不依赖 DOM/Worker，可在 Node 单测。
- 坑：Vue 的 `reactive` 代理无法 `postMessage` 结构化克隆（`DataCloneError`），
  发送前必须拍成纯对象。

## 9. 存储设计（SQLite + OPFS + Worker + 队列）

### 9.1 为什么用 SQL 封装 OPFS

直接用 OPFS 文件 API 时，每次保存要么整文件重写、要么自己实现增量编码；用 SQL 后，
项目列表是一条查询、点位是行、历史是表，事务与增量由数据库保证，底层仍是 OPFS 存储。

### 9.2 表结构

```sql
PRAGMA foreign_keys = ON;
PRAGMA user_version;   -- 结构版本，迁移依据

projects(id PK, name, version, created_at, updated_at)
points(project_id, id, x, y, z, r, g, b, group_id, locked,
       PK(project_id,id), FK->projects ON DELETE CASCADE)
history(project_id, seq, label, op, created_at,
       PK(project_id,seq), FK->projects ON DELETE CASCADE)
groups(project_id, id, name, color_r, color_g, color_b,
       PK(project_id,id), FK->projects ON DELETE CASCADE)
```

- 写入策略：点位增删移改 / 锁定 / 归属走 mutation 增量写；**分组结构与历史**整体覆盖
  （量小、覆盖更简单且不会不一致）。
- 迁移**幂等且自愈**：不单纯信任 `PRAGMA user_version`，而是用 `PRAGMA table_info` 检查
  `points.locked` 是否存在、`groups` 表是否存在，缺则补。这样即使版本号与实际结构不一致
  （版本号已是 2 但没有 `locked` 列），下次打开也会自动补齐，不会卡在 `no such column`。

### 9.3 VFS 选择

使用 `opfs-sahpool`：无需 COOP/COEP（可直接静态托管）、批量性能最好；
代价是不支持多标签并发写（单用户可接受）。初始化失败时降级为内存库并在状态栏提示。

### 9.4 写入时机

- 增删移改 / 锁定 / 分组：提交后防抖 400ms 增量写（`applyChanges`）。
- 载入测试数据 / 导入：`replacePoints` 全量替换（事务）。
- 拖动过程不写；页面隐藏 / `pagehide` 时立即 flush。

## 10. 性能与可扩展性（对应 6.4）

- **移动一个点是否重绘全部**：不。只改该点（及选中集合）的 Sprite 属性，配合空间网格命中。
- **批量改色如何减少重复**：一次构造 id 列表 → 一次 `setColors` → 一次 tint 更新 →
  SQL 侧一条 prepared statement 同事务循环 `UPDATE`。
- **点数继续扩大（十万级）**：① 保持网格索引；② 逐行 `UPDATE` 改分块/多值写入；
  ③ 跨线程改列式 TypedArray 传输；④ 引入离屏渲染 / 分块可见性裁剪。
- **图片导入是否可复用**：可以，只要能产出 `Point[]`，走 `replacePoints` 即可。
- **大量操作记录如何合并压缩**：Operation 只存增量；队列按 key 合并同批写入；
  历史栈与表都限长 100；未来可对 move 做「同一 id 多次移动只保留首尾」。

## 11. 测试与验证

- **单元测试**（`pnpm test`，55 例 / 9 个文件）：`repository`（Node 内存库上真实执行 SQL：
  建表、增量写、锁定/分组持久化、历史裁剪 100、级联删除）、`migration`（空库/重复迁移/
  v1 升级/「版本号已最新但缺列」自愈）、`queue`（串行/合并/错误隔离）、
  `history`+`operations`（撤销重做前后态）、`imageProcessor`（二值化/反相/抽稀/坐标）、
  `geometry`（点在多边形内）、`groups`（成组拆组/归属迁移/锁定不可选中不可删/撤销）、
  `validation` + `spatial`。
- **端到端**（无头 Chrome）：`pnpm smoke` 创建项目→20,000 点→编辑→自动保存→刷新→
  重新打开→撤销历史仍可用→删除当前项目后画布清空；`smoke:image` 二值化生成点位落库；
  `smoke:select` 单击/Shift 加选/Alt 套索/拖拽移动；`smoke:groups` 成组锁定后刷新恢复。
- **性能观测**：界面实时 FPS 与渲染分辨率；无头软件渲染下 20,000 点约 60 FPS。

## 12. 技术学习记录

- **阅读资料**：SQLite WASM 官方《Persistent Storage Options》与 `@sqlite.org/sqlite-wasm`
  README；PixiJS v8 的 `Application` / `Sprite` / `Environments` / `Performance Tips` 文档。
- **第一次使用**：`installOpfsSAHPoolVfs`、`OpfsSAHPoolDb`、OO1 的
  `prepare/step/transaction/selectArrays`、`Application.init({ preference, powerPreference })`、
  `renderer.resize(w,h,resolution)` 动态分辨率、`createImageBitmap` + 离屏 canvas 取像素。
- **踩过的坑**：
  - `opfs` VFS 需 COOP/COEP + SharedArrayBuffer，静态托管不便 → 改 `opfs-sahpool`；
  - Vite 会错误改写 wasm 的 `new URL(..., import.meta.url)` → `optimizeDeps.exclude` 并交给 Vite 处理资源；
  - 拖动结束只登记历史、不发 mutation → 移动未落库，改为在 `commitMove` 显式广播；
  - `setGroupIds` 漏发 mutation、`flush()` 在无点级变更时提前 return → 分组快照丢失；
  - 迁移只看 `user_version` 导致 `no such column: locked` → 改为探测结构 + 自愈；
  - Vue `reactive` 代理无法跨线程克隆（`DataCloneError`）→ 发送前拍成纯对象；
  - 关 MSAA 后点变糙 → 改用 2D canvas 径向渐变纹理；
  - 套索做成模态工具会让左键失去拖拽能力 → 改成 Alt 修饰键。
- **仍未解决**：多标签并发写、Redo 持久化、逐行 `UPDATE` 的批量优化。

## 13. 取舍与后续

- 用 SQLite 换取结构化与事务能力，代价是约 870 KB（gzip ~400 KB）的 wasm。
- 用 `opfs-sahpool` 换取免 COOP/COEP 与性能，代价是放弃多标签并发。
- 后续可扩展：图片抖动(halftone)提升观感、点位列式传输、历史压缩策略、分组可见性开关。
