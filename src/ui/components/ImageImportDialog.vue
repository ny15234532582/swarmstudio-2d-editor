<script setup lang="ts">
/**
 * 图片导入弹窗：把一张图片按二值化规则采样成点集并载入为新项目。
 *
 * 关键设计：
 * - v-model:open 契约：对外只暴露 open 布尔值，内部通过 emit('update:open')
 *   请求父组件关闭，弹窗自身不持有显隐状态，符合 Vue 受控组件约定。
 * - 解码与计算在 Web Worker（client）中完成，避免大图阻塞主线程；参数每次
 *   变更做防抖后重算预览，并用递增序号丢弃过期结果，保证预览与最新参数一致。
 */
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

// Worker 计算客户端（模块级单例，复用同一 Worker）
const client = getImageComputeClient()

const fileInput = ref<HTMLInputElement>()
// 预览用的 2D canvas：直接 putImageData 显示 worker 回传的像素
const previewCanvas = ref<HTMLCanvasElement>()
// 已解码图片的信息（尺寸/名称）；null 表示尚未选择图片
const imageInfo = ref<LoadedImageInfo | null>(null)
// 预览统计：命中像素数、采样步长、预计生成点数
const selectedCount = ref(0)
const pointCount = ref(0)
const step = ref(1)
const rendering = ref(false)
const generating = ref(false)

// 二值化参数（响应式）；展开默认值避免与常量共享引用
const params = reactive<BinarizeParams>({ ...DEFAULT_BINARIZE_PARAMS })

// 取色器的 #RRGGBB <-> RGB 双向绑定：把 params.fixedColor 适配到 input[type=color]
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

// 请求序号：仅采纳最新一次请求的结果，防止慢请求覆盖快请求
let renderSeq = 0
// 参数变更防抖计时器（150ms），避免拖动滑杆时频繁重算
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

/** 触发隐藏的文件选择框 */
async function pickFile(): Promise<void> {
  fileInput.value?.click()
}

/** 图片选择回调：解码 → 首次预览；失败时提示并清空状态 */
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

/** 用当前参数请求 worker 重算预览，并绘制到 canvas */
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

/** 防抖地安排一次预览重算（拖动滑杆时的入口） */
function scheduleRender(): void {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null
    void render()
  }, 150)
}

// 参数变化 → 防抖重算预览（colorHex 用 value 读取，确保依赖被追踪）
watch(
  () => [params.threshold, params.invert, params.targetPoints, params.colorMode, colorHex.value],
  () => scheduleRender(),
)

// 弹窗重新打开且已有图片时，立即刷新一次预览
watch(
  () => props.open,
  (open) => {
    if (open && imageInfo.value) void render()
  },
)

/** 确认生成：请求 worker 生成点集并作为新项目载入；仅在成功载入后关闭弹窗 */
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

/** 请求父组件关闭弹窗（受控：自身不直接改 open） */
function close(): void {
  emit('update:open', false)
}
</script>

<template>
  <div v-if="props.open" class="overlay" @click.self="close">
    <div class="dialog">
      <!-- 区域：标题栏 -->
      <header class="head">
        <h3>导入图片生成点位</h3>
        <button class="ghost" @click="close">✕</button>
      </header>

      <div class="body">
        <!-- 区域：左侧预览画布（未选图时显示占位提示） -->
        <div class="preview">
          <canvas v-show="imageInfo" ref="previewCanvas" class="canvas" />
          <div v-if="!imageInfo" class="placeholder">选择一张图片开始</div>
        </div>

        <!-- 区域：右侧参数控件 -->
        <div class="controls">
          <button class="primary" @click="pickFile">选择图片…</button>
          <input ref="fileInput" type="file" accept="image/*" hidden @change="onFileChange" />
          <p v-if="imageInfo" class="meta">
            {{ imageInfo.name }}<br />
            解码尺寸：{{ imageInfo.width }}×{{ imageInfo.height }}
          </p>

          <!-- 二值化阈值 -->
          <label class="field">
            <span>阈值 {{ params.threshold }}</span>
            <input v-model.number="params.threshold" type="range" min="0" max="255" step="1" />
          </label>

          <!-- 反相：改取深色图案 -->
          <label class="field row">
            <input v-model="params.invert" type="checkbox" />
            <span>反相（深色图案取点）</span>
          </label>

          <!-- 目标点数：控制采样密度 -->
          <label class="field">
            <span>目标点数 {{ params.targetPoints }}</span>
            <input v-model.number="params.targetPoints" type="range" min="500" max="50000" step="500" />
          </label>

          <!-- 取色模式：原图颜色或统一颜色 -->
          <label class="field row">
            <span>取色</span>
            <select v-model="params.colorMode">
              <option value="source">使用原图颜色</option>
              <option value="fixed">统一颜色</option>
            </select>
            <input v-if="params.colorMode === 'fixed'" v-model="colorHex" type="color" />
          </label>

          <!-- 实时统计 -->
          <div class="stat">
            <div>识别像素：<b>{{ selectedCount }}</b></div>
            <div>采样步长：<b>{{ step }}</b></div>
            <div>将生成：<b>{{ pointCount }}</b> 个点</div>
          </div>
        </div>
      </div>

      <!-- 区域：底部操作栏 -->
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
