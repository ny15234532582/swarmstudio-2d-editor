<script setup lang="ts">
/**
 * 根组件：挂载渲染器与交互控制器、承载时间线布局、驱动过渡播放，
 * 并处理全局快捷键与窗口错误兜底。
 *
 * 播放使用「过渡产物」（内存缓存），不再逐帧匹配。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PixiRenderer } from './render/renderer'
import { InteractionController } from './render/interaction'
import {
  editor,
  pointRadius,
  setPointRadiusController,
  setQualityController,
  setTransitionPreviewController,
  setViewportCenterProvider,
  showTrails,
  transitions,
  updateRenderInfo,
} from './ui/editor'
import { refreshProjects, saveProject } from './ui/projects'
import { buildTimeline, sampleRenderSegment, segmentAt, trailsFromRender, type RenderPayload } from './core/transition'
import {
  getRender,
  hasAllRenders,
  renderRevision,
  selectedRenderId,
} from './render/renderStore'
import TopToolbar from './ui/components/TopToolbar.vue'
import ProjectPanel from './ui/components/ProjectPanel.vue'
import StatusBar from './ui/components/StatusBar.vue'
import ToastHost from './ui/components/ToastHost.vue'
import ImageImportDialog from './ui/components/ImageImportDialog.vue'
import Timeline from './ui/components/Timeline.vue'
import TransitionEditor from './ui/components/TransitionEditor.vue'

const canvasHost = ref<HTMLElement>()
const fps = ref(0)
const viewportScale = ref(1)
const imageDialogOpen = ref(false)
// 正在编辑的帧 id；为空表示「新增帧」模式
const editingFrameId = ref<string | null>(null)
// 过渡编辑抽屉状态：null=关闭；new=新建草稿；edit=修改已有过渡
const transitionEditor = ref<{
  mode: 'new' | 'edit'
  transitionId?: string
  fromFrameId?: string
  toFrameId?: string
} | null>(null)
const selectedTransitionId = computed(() => transitionEditor.value?.transitionId ?? null)

// 时间线播放状态
const currentTime = ref(0)
const playing = ref(false)
let playEnd = 0
let rafId = 0
let lastTs = 0
// 抽屉里「预览」的独立播放（不依赖时间线区段，草稿也能播）
let previewRaf = 0
let previewStart = 0
let previewDuration = 0

let renderer: PixiRenderer | null = null
let interaction: InteractionController | null = null
let errorTimer: number | null = null

/** 全部过渡是否都已生成产物（决定能否播放整条时间线） */
const canPlay = computed(() => {
  renderRevision.value
  const ids = transitions.value.map((t) => t.id)
  return ids.length > 0 && hasAllRenders(ids)
})

/** 取“好看”的整数（1/2/5×10ⁿ） */
function niceRound(x: number): number {
  if (x <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  const n = x / p
  const f = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10
  return f * p
}

/** 比例尺：约 100px 对应的“好看”米数（世界单位=米） */
const scaleBar = computed(() => {
  const scale = viewportScale.value
  const meters = niceRound(100 / Math.max(1e-6, scale))
  return { meters, px: meters * scale }
})

onMounted(async () => {
  const host = canvasHost.value
  if (!host) return

  renderer = new PixiRenderer(editor)
  renderer.onFps = (value) => (fps.value = value)
  renderer.onRenderInfo = (info) => updateRenderInfo(info)
  renderer.onViewport = (scale) => (viewportScale.value = scale)
  await renderer.init(host)
  setQualityController(renderer)
  setPointRadiusController((r) => renderer!.setPointRadius(r))
  renderer.setPointRadius(pointRadius.value)
  // 供过渡弹窗在画布上预览指定进度（t<0 清除）
  setTransitionPreviewController((id, t) => {
    const r = renderer
    if (!r) return
    if (t < 0) {
      r.clearPreview()
      return
    }
    const render = getRender(id)
    if (!render) {
      r.clearPreview()
      return
    }
    r.showPreview(sampleRenderSegment(render, t))
  })

  interaction = new InteractionController(
    editor,
    renderer,
    renderer.app!.canvas as unknown as HTMLCanvasElement,
    host,
  )

  setViewportCenterProvider(() => {
    const app = renderer!.app!
    const vp = renderer!.viewport
    return {
      x: (app.screen.width / 2 - vp.x) / vp.scale,
      y: (app.screen.height / 2 - vp.y) / vp.scale,
    }
  })

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('error', onWindowError)
  await refreshProjects()
  updateTrails()
})

// --------------------------------------------------------------- 飞行轨迹

/** 由当前预览/选中的**产物**画半透明轨迹 */
function updateTrails(): void {
  const r = renderer
  if (!r) return
  const render = getRender(selectedRenderId.value)
  if (!render || !showTrails.value) {
    r.clearTrails()
    return
  }
  r.showTrails(trailsFromRender(render))
}

watch([selectedRenderId, showTrails, renderRevision], () => updateTrails())

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('error', onWindowError)
  stopPlayback()
  interaction?.destroy()
  renderer?.destroy()
  interaction = null
  renderer = null
})

// --------------------------------------------------------------- 播放

function renderAt(time: number): void {
  if (!renderer) return
  const seg = segmentAt(buildTimeline(editor.track).segments, time)
  if (!seg) {
    renderer.clearPreview()
    return
  }
  if (seg.kind === 'hold') {
    const pts = editor.getFramePoints(seg.frameId)
    renderer.showPreview(pts.map((p) => ({ x: p.x, y: p.y, r: p.r, g: p.g, b: p.b, alpha: 1 })))
    return
  }
  const render = getRender(seg.transitionId)
  if (!render) {
    renderer.clearPreview()
    return
  }
  const t = seg.end > seg.start ? (time - seg.start) / (seg.end - seg.start) : 1
  renderer.showPreview(sampleRenderSegment(render, t))
}

function tick(ts: number): void {
  if (!playing.value) return
  const dt = (ts - lastTs) / 1000
  lastTs = ts
  let t = currentTime.value + dt
  if (t >= playEnd) {
    t = playEnd
    currentTime.value = t
    renderAt(t)
    stopPlayback()
    return
  }
  currentTime.value = t
  renderAt(t)
  rafId = requestAnimationFrame(tick)
}

function stopPlayback(): void {
  playing.value = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  if (previewRaf) cancelAnimationFrame(previewRaf)
  previewRaf = 0
  renderer?.clearPreview()
}

/** 独立播放一份产物（不移动播放头；草稿态也能播） */
function playRenderPreview(render: RenderPayload): void {
  stopPlayback()
  previewDuration = Math.max(0.1, render.duration + render.stagger)
  previewStart = performance.now()
  const step = (ts: number) => {
    const t = Math.min(1, (ts - previewStart) / (previewDuration * 1000))
    renderer?.showPreview(sampleRenderSegment(render, t))
    if (t < 1) previewRaf = requestAnimationFrame(step)
    else {
      previewRaf = 0
      renderer?.clearPreview()
    }
  }
  previewRaf = requestAnimationFrame(step)
}

function onTogglePlay(): void {
  if (playing.value) {
    stopPlayback()
    return
  }
  if (!canPlay.value) return
  const total = buildTimeline(editor.track).duration
  if (total <= 0) return
  if (currentTime.value >= total) currentTime.value = 0
  playEnd = total
  playing.value = true
  lastTs = performance.now()
  rafId = requestAnimationFrame(tick)
}

/** 预览并播放某个过渡的产物（草稿态也可） */
function onPreviewTransition(transitionId: string): void {
  const render = getRender(transitionId)
  if (!render) return
  playRenderPreview(render)
}

/** 拖动/点击播放头：停留段切到该帧并退出预览，过渡段显示插值 */
function onSeek(time: number): void {
  currentTime.value = time
  if (playing.value) {
    renderAt(time)
    return
  }
  const seg = segmentAt(buildTimeline(editor.track).segments, time)
  if (seg?.kind === 'hold') {
    renderer?.clearPreview()
    if (seg.frameId !== editor.activeFrameIdValue) editor.setActiveFrame(seg.frameId)
  } else {
    renderAt(time)
  }
}

// --------------------------------------------------------------- 快捷键

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

function onKeyDown(e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return
  const mod = e.metaKey || e.ctrlKey

  // 空格：播放 / 暂停（再次按下暂停）
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault()
    onTogglePlay()
    return
  }

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
  if (errorTimer !== null) window.clearTimeout(errorTimer)
  errorTimer = window.setTimeout(() => (errorTimer = null), 300)
}

function onFit(): void {
  renderer?.fitView()
}

/** 时间线「＋ 新增帧」：打开图片导入弹窗（新增模式） */
function onAddFrame(): void {
  editingFrameId.value = null
  imageDialogOpen.value = true
}

/** 点击帧块：打开帧编辑弹窗 */
function onEditFrame(frameId: string): void {
  editingFrameId.value = frameId
  imageDialogOpen.value = true
}

/** 两帧之间点「+」：打开过渡配置（草稿） */
function onNewTransition(payload: { fromFrameId: string; toFrameId: string }): void {
  transitionEditor.value = { mode: 'new', ...payload }
}

/** 点击过渡段：修改已有过渡 */
function onSelectTransition(transitionId: string): void {
  transitionEditor.value = { mode: 'edit', transitionId }
}
</script>

<template>
  <div class="app">
    <TopToolbar @fit="onFit" />
    <div class="body">
      <ProjectPanel />
      <div class="workspace">
        <main ref="canvasHost" class="canvas-host">
          <div class="scalebar">
            <div class="bar" :style="{ width: scaleBar.px + 'px' }" />
            <span>{{ scaleBar.meters }} m</span>
          </div>
        </main>
        <Timeline
          :current-time="currentTime"
          :playing="playing"
          :selected-transition-id="selectedTransitionId"
          :can-play="canPlay"
          @seek="onSeek"
          @toggle-play="onTogglePlay"
          @add-frame="onAddFrame"
          @edit-frame="onEditFrame"
          @select-transition="onSelectTransition"
          @new-transition="onNewTransition"
        />
      </div>
      <TransitionEditor
        :state="transitionEditor"
        @close="transitionEditor = null"
        @preview="onPreviewTransition"
      />
    </div>
    <StatusBar :fps="fps" />
    <ToastHost />
    <ImageImportDialog v-model:open="imageDialogOpen" :frame-id="editingFrameId" />
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
.workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
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
.scalebar {
  position: absolute;
  left: 12px;
  bottom: 10px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  pointer-events: none;
  color: rgba(220, 230, 245, 0.85);
  font-size: 11px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
.scalebar .bar {
  height: 7px;
  border: 1px solid rgba(220, 230, 245, 0.85);
  border-top: none;
  background: rgba(220, 230, 245, 0.12);
  box-sizing: border-box;
}
</style>
