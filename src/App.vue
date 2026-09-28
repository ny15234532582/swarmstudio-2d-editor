<script setup lang="ts">
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

const canvasHost = ref<HTMLElement>()
const fps = ref(0)
const imageDialogOpen = ref(false)

let renderer: PixiRenderer | null = null
let interaction: InteractionController | null = null
let errorTimer: number | null = null

onMounted(async () => {
  const host = canvasHost.value
  if (!host) return

  renderer = new PixiRenderer(editor)
  renderer.onFps = (value) => (fps.value = value)
  renderer.onRenderInfo = (info) => updateRenderInfo(info)
  await renderer.init(host)
  setQualityController(renderer)

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
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('error', onWindowError)
  interaction?.destroy()
  renderer?.destroy()
  interaction = null
  renderer = null
})

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

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

function onWindowError(): void {
  // 兜底：避免未捕获异常静默失败，给出可见提示
  if (errorTimer !== null) window.clearTimeout(errorTimer)
  errorTimer = window.setTimeout(() => (errorTimer = null), 300)
}

function onFit(): void {
  renderer?.fitView()
}

function onGenerate(count: number): void {
  const points = generatePoints({ count })
  loadPointsAsProject(points, `${count} 点测试项目`)
}

function onImportImage(): void {
  imageDialogOpen.value = true
}
</script>

<template>
  <div class="app">
    <TopToolbar @fit="onFit" @generate="onGenerate" @import-image="onImportImage" />
    <div class="body">
      <ProjectPanel />
      <main ref="canvasHost" class="canvas-host" />
    </div>
    <StatusBar :fps="fps" />
    <ToastHost />
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
