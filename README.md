# SwarmStudio · 二维点阵编辑器

面向无人机集群表演创作系统的二维点编辑器 Demo。使用 **Vue 3 + TypeScript**，
以 **PixiJS** 完成主要点位渲染，项目数据通过 **SQLite(WASM) 存储在 OPFS**，
所有数据库读写都在独立的 **Web Worker** 中执行，主线程与 Worker 之间有一层
**任务队列** 做串行化与合并。默认测试规模为 **20,000 点**。

## 环境要求

| 项目 | 版本 |
| --- | --- |
| Node.js | v20+（开发使用 v24.8.0） |
| 包管理器 | pnpm 10（`packageManager: pnpm@10.18.2`） |
| 浏览器 | Chromium 内核 / Firefox 111+ / Safari 16.4+（需支持 OPFS 与 Worker） |

## 安装与启动

```bash
pnpm install
pnpm dev            # 开发，默认 http://localhost:5173
pnpm build          # 类型检查 + 生产构建
pnpm preview        # 预览构建产物
pnpm test           # 单元测试（vitest）
pnpm gen            # 生成 20,000 点测试数据 -> data/test-20000.json
pnpm smoke          # 无头浏览器端到端冒烟（编辑器，需要本地 Chrome）
pnpm smoke:image    # 无头浏览器端到端冒烟（图片生成点位）
pnpm smoke:select   # 无头浏览器端到端冒烟（Shift 加选 / 套索圈选）
```

> 冒烟脚本依赖本机 Chrome，可用 `CHROME_PATH=/path/to/chrome pnpm smoke` 指定。

## 技术选型

- **PixiJS 8**：每个点用一个共享圆形纹理的 `Sprite`（而非逐点 `Graphics`），
  由 GPU 合批，20,000 点接近常数个 draw call；移动 / 改色只改对应 Sprite 属性。
- **SQLite WASM（`@sqlite.org/sqlite-wasm`）**：用 SQL 封装项目数据，
  结构化查询、事务、增量写入都更直接。
- **OPFS `opfs-sahpool` VFS**：数据库文件存放在 OPFS。选择该 VFS 的原因：
  - 不需要 COOP/COEP 响应头，可直接静态托管（GitHub Pages 等）；
  - 批量写入性能最好；
  - 代价：不支持多标签同时写（单用户编辑器可接受）。
- **Web Worker + 任务队列**：OPFS 的同步访问句柄与 SQLite(WASM) 都只在 Worker 可用；
  队列负责串行化、合并（连续保存合并为一次写入）与错误传播。
- **独立 compute worker**：图片解码后的像素运算（灰度、二值化、抽稀）单独一个 Worker，
  与存储 Worker 隔离，避免大图计算卡住主线程或占用数据库事务时间。

## 目录结构

```
src/
  core/          纯领域层：类型、Operation 契约、校验、空间索引、测试数据生成
  state/         EditorStore（运行时事实源）、HistoryManager、事件总线
  render/        PixiJS 渲染、视口变换、指针交互
  data/          数据操作层（不依赖 Vue）
    protocol.ts   主线程 ↔ Worker 消息协议
    schema.ts     建表与迁移（PRAGMA user_version）
    repository.ts 全部 SQL
    worker.ts     SQLite + OPFS(opfs-sahpool) + 顺序执行队列
    queue.ts      任务队列（串行 / 合并）
    client.ts     DataClient：类型化 API + 请求调度
    service.ts    门面：项目 CRUD、自动保存、导入导出
    json.ts       JSON 导入导出
  compute/       图片 → 点阵（纯计算 + 独立 compute worker）
    imageProcessor.ts  二值化 / 抽稀 / 坐标映射（纯函数，可 Node 单测）
    worker.ts          像素运算 Worker
    client.ts          解码图片 + 调用 Worker
  ui/            Vue 组件与状态桥接
scripts/         测试数据生成、无头冒烟（编辑器 / 图片管线）
tests/           vitest 单元测试
docs/design.md   设计说明
```

分层：`core`（领域内核，无依赖）← `state`（内存事实源）← `render`（PixiJS）/
`data`（SQLite+OPFS）/ `compute`（图片计算 Worker）← `ui`（页面）。依赖方向单一，
详见 [设计说明 §2.1](docs/design.md)。

## 数据模型与版本

存储分两层：**内存层**（`EditorStore` + `HistoryManager`）是运行时权威事实源，
渲染 / 交互 / Undo-Redo 都只读它；**磁盘层**（OPFS 上的 SQLite）是持久化投影。
写路径为「内存改 → mutation → 队列 → SQL 事务」，读路径为「SQL → 物化进内存」，
磁盘始终跟随内存，不会出现两个事实源。

```ts
interface Point { id: string; x: number; y: number; z: number; r: number; g: number; b: number; groupId?: string }
```

- `x/y/z` 为有限数值，`r/g/b` 为 0~255 整数；画布只按 XY 显示，**保存/导入导出完整保留 z**。
- 业务数据与界面临时状态分离：`selected`、`hovered`、`dragging` 不写入项目数据，
  选中状态保存在 `EditorStore.selection`。

两套版本分开：

| 版本 | 位置 | 说明 |
| --- | --- | --- |
| 项目数据格式版本 | `projects.version` / `Project.version` | 随项目保存，导入时校验 |
| 数据库结构版本 | `PRAGMA user_version` | 由 `data/schema.ts` 迁移维护 |

数据库表：`projects`、`points(project_id,id,...)`、`history(project_id,seq,label,op,...)`，
外键 `ON DELETE CASCADE`，删除项目自动清理点位与历史。

## 功能

- PixiJS 画布：加载 / 绘制、RGB 显色、平移、缩放与适配、单点选中高亮、拖动
- 点位编辑：新增、删除、移动、多点选择（Shift 加选 / 框选 / 套索）、批量改色、取消选择
- 选择工具：框选（矩形）与套索（自由圈选），套索可圈出任意形状区域，Shift 追加
- 状态显示：总点数、选中数量、FPS、渲染分辨率、存储后端
- 渲染质量：自动（按 FPS 动态分辨率）/ 高 / 均衡 / 流畅
- Undo / Redo：新增 / 删除 / 移动 / 改色，快捷键 `Cmd/Ctrl+Z`、`Shift+Cmd/Ctrl+Z`
- 项目存储：创建、保存、打开、删除、刷新恢复、导出 / 导入 JSON
- 图片生成点位：导入图片 → 阈值二值化（可反相）→ 按目标点数抽稀 → 生成点阵，
  全程在独立 compute worker，参数实时预览
- 自动保存：提交后 400ms 防抖；拖动期间的 `pointermove` 不触发持久化
- 未保存保护：新建 / 打开 / 导入 / 生成点位前，若有未保存修改会先询问是否保存

## 快捷键与操作

| 操作 | 方式 |
| --- | --- |
| 缩放 | 滚轮（以光标为中心） |
| 平移 | 中键拖动 / 空格 + 左键拖动 |
| 框选 | 左键在空白处拖拽（选择工具=框选） |
| 套索圈选 | 工具栏选择工具切到「套索」，左键自由拖拽成圈 |
| 加选 / 反选 | Shift + 左键点选；Shift + 框选/套索为追加 |
| 删除选中 | Delete / Backspace |
| 撤销 / 重做 | Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z |
| 保存 | Cmd/Ctrl+S |

## 界面预览

![界面预览](docs/screenshots/overview.png)

（20,000 点数据；左下角显示总点数、FPS、实际渲染分辨率、存储后端 `opfs-sahpool`。）

![图片生成点位](docs/screenshots/image-import.png)

（导入图片 → 二值化实时预览 → 生成点位。）

![套索圈选](docs/screenshots/lasso.png)

（套索工具自由圈选区域，落点即选中。）

## 测试与性能验证

### 性能验证环境

| 项 | 值 |
| --- | --- |
| 机器 | macOS 26.6.2 / Apple Silicon (arm64) |
| 浏览器 | Google Chrome 153.0.8010.53（`pnpm smoke` 使用无头模式） |
| 渲染 | 无头 SwiftShader **软件渲染，无 GPU**（属最不利情形） |
| Node / pnpm | v24.8.0 / 10.18.2 |
| 数据 | 20,000 点（`pnpm gen` 生成，确定性种子可复现） |

- `pnpm test`：40 个用例
  - `repository`：在 Node 内存库上验证建表、迁移、增量写入、历史裁剪(100)、级联删除
  - `queue`：任务串行、同 key 合并、错误隔离
  - `history` / `operations`：撤销重做的前后状态
  - `imageProcessor`：二值化、反相、透明像素、抽稀步长、坐标映射
  - `geometry`：套索的点在多边形内判定（射线法）
  - `validation` / `spatial`：数据校验与空间索引
- `pnpm smoke`：无头 Chrome 端到端——创建项目 → 生成 20,000 点 → 编辑 → 自动保存 →
  刷新 → 从 SQLite 重新打开 → **撤销历史仍可用**。
- `pnpm smoke:image`：注入一张图片 → 二值化预览 → 生成点位 → 作为新项目落库。
- `pnpm smoke:select`：单击选中 → **Shift 加选** → 套索圈选 → Shift 套索追加，
  逐步校验「已选中」数量。
- 性能：界面右下角实时显示 FPS 与实际渲染分辨率。工具栏提供画质档位
  （自动/高/均衡/流畅），`自动` 会按 FPS 动态升降分辨率。
  上述无头软件渲染环境下，20,000 点关闭 MSAA 后实测约 60 FPS
  （优化前约 28 FPS）；真机 GPU 下更高，draw call 接近常数。
  加载、平移、缩放、拖动均保持可交互。

复现性能测试：`pnpm gen 8000` 生成不同规模数据，用「导入 JSON」载入后观察 FPS 与操作耗时。

## 已知问题与未完成

- 无头浏览器在 `reload` 时偶发渲染进程崩溃（SwiftShader 软件渲染 + WebGL 重载），
  真机 Chrome 正常。
- `opfs-sahpool` 不支持多标签并发写；同源多开时后开的标签会初始化失败并降级为内存模式。
- 历史仅持久化 Undo 栈（最近 100 条），Redo 栈不持久化。
- 增量写入目前对移动 / 改色逐行 `UPDATE`，尚未做语句级批量优化。
- 未实现题目选做项：分组锁定；图片抖动手法（halftone）尚未加入；点数到十万级需进一步优化（见设计说明第 10 节）。

## AI 使用说明

开发过程中使用了 AI 辅助生成代码骨架与文档草稿。所有核心设计（数据模型、
Operation 契约、任务队列、SQLite 表结构与迁移、渲染方案）均经过人工审阅，
关键代码可在面试中逐行解释。

## 设计说明

详见 [`docs/design.md`](docs/design.md)。
