/**
 * 编辑器单例 + 面向 Vue 的响应式桥接。
 *
 * 为什么用「版本号」而不是把 project 变成 reactive：
 * 事实源里有大量点对象，深度响应式代理会带来明显开销。这里让 store 保持纯对象，
 * 用一个 revision 计数把「需要刷新 UI 的变更」显式通知给 Vue；点位的高频移动由
 * Pixi 直接增量更新，不经过 Vue。
 */
import { computed, ref } from 'vue'
import { EditorStore } from '../state/store'
import { createProject } from '../core/factory'
import type { RenderInfo, RenderQuality } from '../render/renderer'

export const editor = new EditorStore(createProject('未命名项目'))

const revision = ref(0)

for (const event of [
  'points:add',
  'points:remove',
  'points:color',
  'points:lock',
  'groups:change',
  'frames:change',
  'transitions:change',
  'activeFrame:change',
  'meta:change',
  'selection:change',
  'history:change',
  'project:load',
] as const) {
  editor.events.on(event, () => {
    revision.value++
  })
}

export const pointCount = computed(() => {
  revision.value
  return editor.pointCount
})

export const activePointCount = computed(() => {
  revision.value
  return editor.activePointCount
})

export const selectedCount = computed(() => {
  revision.value
  return editor.selectedCount
})

export const canUndo = computed(() => {
  revision.value
  return editor.history.canUndo
})

export const canRedo = computed(() => {
  revision.value
  return editor.history.canRedo
})

export const undoLabel = computed(() => {
  revision.value
  return editor.history.undoLabel
})

export const redoLabel = computed(() => {
  revision.value
  return editor.history.redoLabel
})

export const projectName = computed(() => {
  revision.value
  return editor.project.name
})

export const droneCount = computed(() => {
  revision.value
  return editor.project.droneCount
})

export const droneLimits = computed(() => {
  revision.value
  return editor.droneLimits
})

export const currentVersion = computed(() => editor.project.version)

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

// --------------------------------------------------------------- 时间线

export interface FrameView {
  id: string
  name: string
  thumbnail: string
  duration: number
  pointCount: number
}

export interface TransitionView {
  id: string
  fromFrameId: string
  toFrameId: string
  duration: number
  stagger: number
  algorithm: string
  path: string
  easing: string
  params: Record<string, number>
}

/** 帧片段列表快照（revision 驱动，供时间线渲染） */
export const frames = computed<FrameView[]>(() => {
  revision.value
  return editor.frames.map((f) => ({
    id: f.id,
    name: f.name,
    thumbnail: f.thumbnail,
    duration: f.duration,
    pointCount: editor.getPointCountOfFrame(f.id),
  }))
})

/** 过渡列表快照 */
export const transitions = computed<TransitionView[]>(() => {
  revision.value
  return editor.transitions.map((t) => ({
    id: t.id,
    fromFrameId: t.fromFrameId,
    toFrameId: t.toFrameId,
    duration: t.duration,
    stagger: t.stagger ?? 0,
    algorithm: t.algorithm,
    path: t.path,
    easing: t.easing,
    params: { ...t.params },
  }))
})

export const activeFrameId = computed(() => {
  revision.value
  return editor.activeFrameIdValue
})

export const activeFrameIndex = computed(() => {
  revision.value
  return editor.frames.findIndex((f) => f.id === editor.activeFrameIdValue)
})

export function selectFrame(frameId: string): void {
  editor.setActiveFrame(frameId)
}

export function setDroneCount(count: number): void {
  editor.setDroneCount(count)
}

export function setDroneLimits(limits: { maxSpeed?: number; maxAccel?: number }): void {
  editor.setDroneLimits(limits)
}

/** 读取 frameId → 点位 映射（供播放引擎复用；非响应式） */
export function getPointsByFrame() {
  return editor.getPointsByFrame()
}

// --------------------------------------------------------------- 新增点位

let viewportCenterProvider: (() => { x: number; y: number }) | null = null

/** 由 App 注入「当前视口中心的世界坐标」，供工具栏「新增点」使用 */
export function setViewportCenterProvider(fn: () => { x: number; y: number }): void {
  viewportCenterProvider = fn
}

export function addPointAtViewCenter(): void {
  const center = viewportCenterProvider ? viewportCenterProvider() : { x: 0, y: 0 }
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

let qualityController: { setQuality(quality: RenderQuality): void } | null = null

/** 由 App 注入渲染器，让 UI 能切换渲染质量档位 */
export function setQualityController(controller: { setQuality(quality: RenderQuality): void }): void {
  qualityController = controller
}

export const renderQuality = ref<RenderQuality>('auto')
export const renderInfo = ref<RenderInfo>({ quality: 'auto', resolution: 1, autoScale: 1 })
/** 是否显示过渡的飞行轨迹（UI 偏好） */
export const showTrails = ref(true)
/** 点的显示半径（世界单位/米），默认按无人机实际大小 */
export const pointRadius = ref(0.5)

let pointRadiusController: ((r: number) => void) | null = null

/** 由 App 注入渲染器，让 UI 能改点半径 */
export function setPointRadiusController(fn: (r: number) => void): void {
  pointRadiusController = fn
}

export function setPointRadius(radius: number): void {
  const v = Math.max(0.05, radius)
  pointRadius.value = v
  pointRadiusController?.(v)
}

export function setRenderQuality(quality: RenderQuality): void {
  renderQuality.value = quality
  qualityController?.setQuality(quality)
}

export function updateRenderInfo(info: RenderInfo): void {
  renderInfo.value = info
  renderQuality.value = info.quality
}
