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
import type { SelectTool } from '../render/interaction'

export const editor = new EditorStore(createProject('未命名项目'))

const revision = ref(0)

for (const event of [
  'points:add',
  'points:remove',
  'points:color',
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

export const currentVersion = computed(() => editor.project.version)

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

export function setRenderQuality(quality: RenderQuality): void {
  renderQuality.value = quality
  qualityController?.setQuality(quality)
}

export function updateRenderInfo(info: RenderInfo): void {
  renderInfo.value = info
  renderQuality.value = info.quality
}

// --------------------------------------------------------------- 选择工具

let toolController: { setTool(tool: SelectTool): void } | null = null

/** 由 App 注入交互控制器，让 UI 能切换框选 / 套索 */
export function setToolController(controller: { setTool(tool: SelectTool): void }): void {
  toolController = controller
}

export const selectTool = ref<SelectTool>('box')

export function setSelectTool(tool: SelectTool): void {
  selectTool.value = tool
  toolController?.setTool(tool)
}
