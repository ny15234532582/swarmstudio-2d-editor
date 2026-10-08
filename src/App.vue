<script setup lang="ts">
/**
 * 应用根组件：编辑器页面外壳与生命周期编排。
 *
 * 职责：
 * - 在挂载时创建 PixiJS 渲染器与交互控制器，并绑定到画布宿主元素；
 * - 把「视口中心」「画质控制器」等能力注入 UI 桥接层（ui/editor），
 *   使工具栏/状态栏等纯 UI 组件无需直接依赖渲染器；
 * - 注册全局键盘快捷键（撤销/重做、保存、删除、取消选择）；
 * - 注册 window error 兜底与卸载时清理监听，避免内存泄漏。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { PixiRenderer } from './render/renderer'
import { InteractionController } from './render/interaction'
import { editor, setQualityController, setViewportCenterProvider, updateRenderInfo } from './ui/editor'
import { loadPointsAsProject, refreshProjects, saveProject } from './ui/projects'
import { generatePoints } from './core/testdata'
import TopToolbar from './ui/components/TopToolbar.vue'
import ProjectPanel from './ui/components/ProjectPanel.vue'
import StatusBar from './ui/components/StatusBar.vue'
import ToastHost from './ui/components/ToastHost.vue'
import ImageImportDialog from './ui/components/ImageImportDialog.vue'

// 渲染器挂载的画布宿主（模板 ref）
const canvasHost = ref<HTMLElement>()
// 渲染器上报的实时帧率，透传给状态栏
const fps = ref(0)
// 图片导入弹窗的显隐（v-model:open）
const imageDialogOpen = ref(false)

// 渲染器/交互控制器实例；非响应式，仅做生命周期持有
let renderer: PixiRenderer | null = null
let interaction: InteractionController | null = null
// window error 的事件节流计时器，避免同一异常风暴反复触发
let errorTimer: number | null = null

onMounted(async () => {
  const host = canvasHost.value
  if (!host) return

  // 1) 初始化渲染器并接管 FPS / 分辨率回调
  renderer = new PixiRenderer(editor)
  renderer.onFps = (value) => (fps.value = value)
  renderer.onRenderInfo = (info) => updateRenderInfo(info)
  await renderer.init(host)
  setQualityController(renderer)

  // 2) 创建交互控制器（滚轮缩放、平移、框选、拖动等）
  interaction = new InteractionController(
    editor,
    renderer,
    renderer.app!.canvas as unknown as HTMLCanvasElement,
    host,
  )

  // 3) 注入视口中心换算：屏幕坐标 → 世界坐标
  setViewportCenterProvider(() => {
    const app = renderer!.app!
    const vp = renderer!.viewport
    return {
      x: (app.screen.width / 2 - vp.x) / vp.scale,
      y: (app.screen.height / 2 - vp.y) / vp.scale,
    }
  })

  // 4) 全局监听与项目列表加载
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('error', onWindowError)
  await refreshProjects()
})

onBeforeUnmount(() => {
  // 对称清理：先解绑全局监听，再销毁交互与渲染资源
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('error', onWindowError)
  interaction?.destroy()
  renderer?.destroy()
  interaction = null
  renderer = null
})

/** 判断事件目标是否为文本输入控件：这些控件内不应劫持键盘快捷键 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

/** 全局快捷键分发：输入框中直接放行；mod = Cmd(mac)/Ctrl(win) */
function onKeyDown(e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return
  const mod = e.metaKey || e.ctrlKey

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) editor.redo()
    else editor.undo()
    return
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void saveProject()
    return
  }
  // Delete / Backspace 仅在确有选中时拦截，避免影响浏览器默认行为
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (editor.selectedCount > 0) {
      e.preventDefault()
      editor.deleteSelected()
    }
    return
  }
  if (e.key === 'Escape') {
    editor.clearSelection()
  }
}

/** window error 全局兜底：用 300ms 窗口节流，防止级联错误刷屏 */
function onWindowError(): void {
  // 兜底：避免未捕获异常静默失败，给出可见提示
  if (errorTimer !== null) window.clearTimeout(errorTimer)
  errorTimer = window.setTimeout(() => (errorTimer = null), 300)
}

/** 工具栏「适配视图」：把全部点位缩放到可视区域内 */
function onFit(): void {
  renderer?.fitView()
}

/** 工具栏「生成测试数据」：生成指定数量的随机点并作为新项目载入 */
function onGenerate(count: number): void {
  const points = generatePoints({ count })
  loadPointsAsProject(points, `${count} 点测试项目`)
}

/** 工具栏「导入图片」：打开图片导入弹窗 */
function onImportImage(): void {
  imageDialogOpen.value = true
}
</script>

<template>
  <div class="app">
    <!-- 顶部工具栏：点/组/锁定/撤销/画质等操作入口 -->
    <TopToolbar @fit="onFit" @generate="onGenerate" @import-image="onImportImage" />
    <div class="body">
      <!-- 左侧项目面板 -->
      <ProjectPanel />
      <!-- 中间主画布：Pixi 渲染器挂载于此 -->
      <main ref="canvasHost" class="canvas-host" />
    </div>
    <!-- 底部状态栏：点数/选中/FPS/保存状态 -->
    <StatusBar :fps="fps" />
    <!-- 全局 Toast 出口 -->
    <ToastHost />
    <!-- 图片导入弹窗（v-model:open 双向绑定显隐） -->
    <ImageImportDialog v-model:open="imageDialogOpen" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.canvas-host {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: #11151c;
}
.canvas-host :deep(canvas) {
  display: block;
}
</style>
