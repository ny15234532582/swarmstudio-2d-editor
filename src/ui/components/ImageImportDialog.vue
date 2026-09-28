<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  DEFAULT_BINARIZE_PARAMS,
  type BinarizeParams,
} from '../../compute/imageProcessor'
import { getImageComputeClient, type LoadedImageInfo } from '../../compute/client'
import { loadPointsAsProject } from '../projects'
import { toast } from '../toast'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const client = getImageComputeClient()

const fileInput = ref<HTMLInputElement>()
const previewCanvas = ref<HTMLCanvasElement>()
const imageInfo = ref<LoadedImageInfo | null>(null)
const selectedCount = ref(0)
const pointCount = ref(0)
const step = ref(1)
const rendering = ref(false)
const generating = ref(false)

const params = reactive<BinarizeParams>({ ...DEFAULT_BINARIZE_PARAMS })

const colorHex = computed({
  get: () =>
    '#' +
    [params.fixedColor.r, params.fixedColor.g, params.fixedColor.b]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join(''),
  set: (value: string) => {
    params.fixedColor = {
      r: parseInt(value.slice(1, 3), 16),
      g: parseInt(value.slice(3, 5), 16),
      b: parseInt(value.slice(5, 7), 16),
    }
  },
})

let renderSeq = 0
let debounceTimer: number | null = null

/**
 * 传给 Worker 前必须转成纯对象：Vue 的 reactive 代理（包括嵌套的 fixedColor）
 * 无法被 postMessage 结构化克隆，直接传会抛 DataCloneError。
 */
function snapshotParams(): BinarizeParams {
  return {
    threshold: params.threshold,
    invert: params.invert,
    targetPoints: params.targetPoints,
    colorMode: params.colorMode,
    fixedColor: { ...params.fixedColor },
    worldWidth: params.worldWidth,
  }
}

async function pickFile(): Promise<void> {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    imageInfo.value = await client.load(file)
    await render()
  } catch (err) {
    toast(`图片载入失败：${(err as Error).message}`, 'error', 5000)
    imageInfo.value = null
  }
}

async function render(): Promise<void> {
  if (!imageInfo.value) return
  const seq = ++renderSeq
  rendering.value = true
  try {
    const { info, image } = await client.render(snapshotParams())
    if (seq !== renderSeq) return // 丢弃过期的预览结果
    selectedCount.value = info.selectedCount
    pointCount.value = info.pointCount
    step.value = info.step
    const canvas = previewCanvas.value
    if (canvas) {
      canvas.width = image.width
      canvas.height = image.height
      canvas.getContext('2d')?.putImageData(image, 0, 0)
    }
  } catch (err) {
    if (seq === renderSeq) toast((err as Error).message, 'error')
  } finally {
    if (seq === renderSeq) rendering.value = false
  }
}

function scheduleRender(): void {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null
    void render()
  }, 150)
}

watch(
  () => [params.threshold, params.invert, params.targetPoints, params.colorMode, colorHex.value],
  () => scheduleRender(),
)

watch(
  () => props.open,
  (open) => {
    if (open && imageInfo.value) void render()
  },
)

async function confirm(): Promise<void> {
  if (!imageInfo.value || pointCount.value === 0) return
  generating.value = true
  try {
    const points = await client.generate(snapshotParams())
    const name = `图片点位 · ${imageInfo.value.name}`.slice(0, 60)
    // 若用户在有未保存修改时放弃，则不关闭弹窗
    if (await loadPointsAsProject(points, name)) close()
  } catch (err) {
    toast((err as Error).message, 'error', 5000)
  } finally {
    generating.value = false
  }
}

function close(): void {
  emit('update:open', false)
}
</script>

<template>
  <div v-if="props.open" class="overlay" @click.self="close">
    <div class="dialog">
      <header class="head">
        <h3>导入图片生成点位</h3>
        <button class="ghost" @click="close">✕</button>
      </header>

      <div class="body">
        <div class="preview">
          <canvas v-show="imageInfo" ref="previewCanvas" class="canvas" />
          <div v-if="!imageInfo" class="placeholder">选择一张图片开始</div>
        </div>

        <div class="controls">
          <button class="primary" @click="pickFile">选择图片…</button>
          <input ref="fileInput" type="file" accept="image/*" hidden @change="onFileChange" />
          <p v-if="imageInfo" class="meta">
            {{ imageInfo.name }}<br />
            解码尺寸：{{ imageInfo.width }}×{{ imageInfo.height }}
          </p>

          <label class="field">
            <span>阈值 {{ params.threshold }}</span>
            <input v-model.number="params.threshold" type="range" min="0" max="255" step="1" />
          </label>

          <label class="field row">
            <input v-model="params.invert" type="checkbox" />
            <span>反相（深色图案取点）</span>
          </label>

          <label class="field">
            <span>目标点数 {{ params.targetPoints }}</span>
            <input v-model.number="params.targetPoints" type="range" min="500" max="50000" step="500" />
          </label>

          <label class="field row">
            <span>取色</span>
            <select v-model="params.colorMode">
              <option value="source">使用原图颜色</option>
              <option value="fixed">统一颜色</option>
            </select>
            <input v-if="params.colorMode === 'fixed'" v-model="colorHex" type="color" />
          </label>

          <div class="stat">
            <div>识别像素：<b>{{ selectedCount }}</b></div>
            <div>采样步长：<b>{{ step }}</b></div>
            <div>将生成：<b>{{ pointCount }}</b> 个点</div>
          </div>
        </div>
      </div>

      <footer class="foot">
        <span class="hint">{{ rendering ? '计算中…' : '调整参数实时预览' }}</span>
        <button @click="close">取消</button>
        <button class="primary" :disabled="!imageInfo || pointCount === 0 || generating" @click="confirm">
          {{ generating ? '生成中…' : '生成并载入' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.dialog {
  width: 760px;
  max-width: 92vw;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.head h3 {
  margin: 0;
  font-size: 15px;
}
.ghost {
  background: transparent;
  border: none;
  font-size: 15px;
}
.body {
  display: flex;
  gap: 16px;
  padding: 16px;
}
.preview {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b0e13;
  border: 1px solid var(--border);
  border-radius: 8px;
  min-height: 280px;
}
.canvas {
  max-width: 100%;
  max-height: 360px;
  image-rendering: pixelated;
}
.placeholder {
  color: var(--text-dim);
  font-size: 13px;
}
.controls {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.meta {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
  word-break: break-all;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
}
.field.row {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.field input[type='range'] {
  padding: 0;
}
.stat {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-dim);
}
.stat b {
  color: var(--accent);
}
.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.hint {
  flex: 1;
  font-size: 12px;
  color: var(--text-dim);
}
</style>
