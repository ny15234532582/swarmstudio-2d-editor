/**
 * 编辑器单例 + 面向 Vue 的响应式桥接。
 *
 * 为什么用「版本号」而不是把 project 变成 reactive：
 * 事实源里有数千个点对象，深度响应式代理会带来明显的读取/写入开销。
 * 这里让 store 保持纯对象，用一个 revision 计数把「需要刷新 UI 的变更」
 * 显式通知给 Vue；点位的高频移动由 Pixi 直接增量更新，不经过 Vue。
 */
import { computed, ref } from 'vue'
import { EditorStore } from '../state/store'
import { createProject } from '../core/factory'
import type { RenderInfo, RenderQuality } from '../render/renderer'

/** 全局唯一的编辑器实例；各模块共享同一份事实源 */
export const editor = new EditorStore(createProject('未命名项目'))

/**
 * 响应式桥接：revision 只是一个「变更脉冲」。
 * store 每次广播下列结构性/汇总性事件时自增，computed 读取它即建立依赖，
 * 从而在数据变化后重新求值；点位的连续移动不在此列（由 Pixi 直接重绘）。
 */
const revision = ref(0)

for (const event of [
  'points:add',
  'points:remove',
  'points:color',
  'points:lock',
  'groups:change',
  'selection:change',
  'history:change',
  'project:load',
] as const) {
  editor.events.on(event, () => {
    revision.value++
  })
}

// 以下 computed 均以“先读 revision 再读取 store”的方式声明依赖，
// 使纯对象 store 的变更也能驱动 Vue 更新。

/** 项目总点数（含被锁定点） */
export const pointCount = computed(() => {
  revision.value
  return editor.pointCount
})

/** 当前选中点数（锁定点不计入选择） */
export const selectedCount = computed(() => {
  revision.value
  return editor.selectedCount
})

/** 是否可撤销（用于工具栏按钮禁用态） */
export const canUndo = computed(() => {
  revision.value
  return editor.history.canUndo
})

/** 是否可重做 */
export const canRedo = computed(() => {
  revision.value
  return editor.history.canRedo
})

/** 下一步撤销的操作名，供按钮 tooltip 展示 */
export const undoLabel = computed(() => {
  revision.value
  return editor.history.undoLabel
})

/** 下一步重做的操作名 */
export const redoLabel = computed(() => {
  revision.value
  return editor.history.redoLabel
})

/** 当前项目名（可在面板中编辑） */
export const projectName = computed(() => {
  revision.value
  return editor.project.name
})

/** 分组列表快照（revision 驱动，供分组面板渲染） */
export const groups = computed(() => {
  revision.value
  return editor.groups.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    count: editor.getGroupMemberCount(g.id),
    locked: editor.isGroupLocked(g.id),
  }))
})

/** 项目数据版本号；仅在成功保存到 OPFS 后自增，用于判断列表快照是否过期 */
export const currentVersion = computed(() => editor.project.version)

// --------------------------------------------------------------- 新增点位

// 视口中心由 App 在初始化后注入；解耦 UI 与渲染器（editor 不依赖 Pixi）
let viewportCenterProvider: (() => { x: number; y: number }) | null = null

/** 由 App 注入「当前视口中心的世界坐标」，供工具栏「新增点」使用 */
export function setViewportCenterProvider(fn: () => { x: number; y: number }): void {
  viewportCenterProvider = fn
}

/** 在视口中心附近随机偏移新增一个白点：默认未注入时落到原点，保证调用安全 */
export function addPointAtViewCenter(): void {
  const center = viewportCenterProvider ? viewportCenterProvider() : { x: 0, y: 0 }
  // ±10 的抖动避免连续新增时多个点完全重叠，便于用户逐个处理
  const offset = () => (Math.random() - 0.5) * 20
  editor.addPoint({
    x: center.x + offset(),
    y: center.y + offset(),
    z: 0,
    r: 255,
    g: 255,
    b: 255,
  })
}

// --------------------------------------------------------------- 渲染质量

// 渲染器在挂载后才会就绪，因此通过 setter 注入能力，而非在模块加载期直接引用
let qualityController: { setQuality(quality: RenderQuality): void } | null = null

/** 由 App 注入渲染器，让 UI 能切换渲染质量档位 */
export function setQualityController(controller: { setQuality(quality: RenderQuality): void }): void {
  qualityController = controller
}

/** 当前画质档位（响应式，绑定到工具栏下拉框） */
export const renderQuality = ref<RenderQuality>('auto')
/** 渲染器上报的实际分辨率信息（含自适应系数），供状态栏展示 */
export const renderInfo = ref<RenderInfo>({ quality: 'auto', resolution: 1, autoScale: 1 })

/** 用户切换画质：先更新响应式状态，再转发给已注入的渲染器（未就绪时静默忽略） */
export function setRenderQuality(quality: RenderQuality): void {
  renderQuality.value = quality
  qualityController?.setQuality(quality)
}

/** 渲染器回调：同步生效信息，并以其为准回写档位（如自动档可能被内部调整） */
export function updateRenderInfo(info: RenderInfo): void {
  renderInfo.value = info
  renderQuality.value = info.quality
}

