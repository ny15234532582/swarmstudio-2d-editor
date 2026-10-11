<script setup lang="ts">
/**
 * 图片导入 / 帧编辑弹窗。
 *
 * - 新增模式（frameId 为空）：导入一张图片，按二值化规则采样成点集，作为新帧追加到时间线。
 * - 编辑模式（传入 frameId）：用帧里保存的源图回填参数与预览，可改名称/时长/采样参数，
 *   点「应用」重新生成该帧点位（帧 id 不变，过渡引用不失效）。
 *
 * 解码与计算在 compute worker 完成；参数变更做防抖后重算预览，并用递增序号丢弃过期结果。
 */
import { computed, reactive, ref, watch } from 'vue'
import { DEFAULT_BINARIZE_PARAMS, type BinarizeParams } from '../../compute/imageProcessor'
import {
  createSourceImage,
  createThumbnail,
  getImageComputeClient,
  type LoadedImageInfo,
} from '../../compute/client'
import { createFrame } from '../../core/factory'
import type { FrameParams } from '../../core/types'
import { droneCount, editor } from '../editor'
import { appendImage } from '../projects'
import { toast } from '../toast'
import Modal from './Modal.vue'

const props = defineProps<{ open: boolean; frameId?: string | null }>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const client = getImageComputeClient()
const isEdit = computed(() => !!props.frameId)

const fileInput = ref<HTMLInputElement>()
const previewCanvas = ref<HTMLCanvasElement>()
const imageInfo = ref<LoadedImageInfo | null>(null)
const selectedFile = ref<File | null>(null)
const selectedCount = ref(0)
const pointCount = ref(0)
const step = ref(1)
const rendering = ref(false)
const generating = ref(false)
const name = ref('')
const duration = ref(3)

const params = reactive<BinarizeParams>({ ...DEFAULT_BINARIZE_PARAMS })

/** 取色器的 #RRGGBB <-> RGB 双向绑定 */
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

/** 传给 Worker 前必须转成纯对象（Vue reactive 代理无法结构化克隆） */
function snapshotParams(): BinarizeParams {
  return {
    threshold: params.threshold,
    invert: params.invert,
    minSpacing: params.minSpacing,
    maxPoints: params.maxPoints,
    colorMode: params.colorMode,
    fixedColor: { ...params.fixedColor },
    worldWidth: params.worldWidth,
  }
}

function applyFrameParams(fp: FrameParams): void {
  params.threshold = fp.threshold
  params.invert = fp.invert
  params.minSpacing = fp.minSpacing
  params.colorMode = fp.colorMode
  params.fixedColor = { ...fp.fixedColor }
  params.worldWidth = fp.worldWidth
}

function pickFile(): void {
  fileInput.value?.click()
}

/** 把 data URL 源图重新装进 worker（编辑模式回填） */
async function loadSource(source: string, baseName: string): Promise<void> {
  const res = await fetch(source)
  const blob = await res.blob()
  const file = new File([blob], baseName || 'frame.jpg', { type: blob.type || 'image/jpeg' })
  selectedFile.value = file
  imageInfo.value = await client.load(file)
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    selectedFile.value = file
    imageInfo.value = await client.load(file)
    if (!isEdit.value) name.value = file.name
    params.maxPoints = droneCount.value
    await render()
  } catch (err) {
    toast(`图片载入失败：${(err as Error).message}`, 'error', 5000)
    imageInfo.value = null
    selectedFile.value = null
  }
}

/** 用当前参数请求 worker 重算预览，并绘制到 canvas */
async function render(): Promise<void> {
  if (!imageInfo.value) return
  const seq = ++renderSeq
  rendering.value = true
  try {
    const { info, image } = await client.render(snapshotParams())
    if (seq !== renderSeq) return
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

// 参数变化 → 防抖重算预览
watch(
  () => [params.threshold, params.invert, params.minSpacing, params.colorMode, colorHex.value],
  () => scheduleRender(),
)

/** 打开时：编辑模式回填帧（含源图与参数），新增模式跟随当前无人机上限 */
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    params.maxPoints = droneCount.value
    if (props.frameId) {
      const frame = editor.getFrame(props.frameId)
      if (!frame) return
      name.value = frame.name
      duration.value = frame.duration
      if (frame.params) applyFrameParams(frame.params)
      if (frame.source) {
        try {
          await loadSource(frame.source, frame.name)
          await render()
        } catch (err) {
          toast(`源图载入失败：${(err as Error).message}`, 'error', 5000)
        }
      } else if (imageInfo.value) {
        await render()
      }
      return
    }
    if (imageInfo.value) await render()
  },
)

/** 确认：生成点位；编辑模式替换该帧，新增模式追加新帧 */
async function confirm(): Promise<void> {
  if (!imageInfo.value || !selectedFile.value || pointCount.value === 0) return
  generating.value = true
  try {
    const points = await client.generate(snapshotParams())
    const thumb = await createThumbnail(selectedFile.value)
    const source = await createSourceImage(selectedFile.value)
    const paramsSnapshot: FrameParams = {
      threshold: params.threshold,
      invert: params.invert,
      minSpacing: params.minSpacing,
      colorMode: params.colorMode,
      fixedColor: { ...params.fixedColor },
      worldWidth: params.worldWidth,
    }
    const frameName = (name.value.trim() || imageInfo.value.name).slice(0, 60)
    const frameDuration = Math.max(0.1, Number(duration.value) || 3)
    if (props.frameId) {
      editor.updateFrameContent(props.frameId, {
        name: frameName,
        duration: frameDuration,
        thumbnail: thumb,
        source,
        params: paramsSnapshot,
        points,
      })
      close()
    } else {
      const frame = createFrame(
        frameName,
        thumb,
        imageInfo.value.width,
        imageInfo.value.height,
        frameDuration,
        source,
        paramsSnapshot,
      )
      if (await appendImage(frame, points)) close()
    }
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
  <Modal
    :open="props.open"
    :title="isEdit ? '编辑帧' : '导入图片生成点位'"
    width="760px"
    @close="close"
  >
    <div class="body">
      <!-- 左侧预览 -->
      <div class="preview">
        <canvas v-show="imageInfo" ref="previewCanvas" class="canvas" />
        <div v-if="!imageInfo" class="placeholder">选择一张图片开始</div>
      </div>

      <!-- 右侧参数 -->
      <div class="controls">
        <button class="primary" @click="pickFile">
          {{ isEdit ? '重新选择图片…' : '选择图片…' }}
        </button>
        <input ref="fileInput" type="file" accept="image/*" hidden @change="onFileChange" />
        <p v-if="imageInfo" class="meta">
          {{ imageInfo.name }}<br />
          解码尺寸：{{ imageInfo.width }}×{{ imageInfo.height }}
        </p>

        <label class="field">
          <span>帧名称</span>
          <input v-model="name" type="text" placeholder="帧名称" />
        </label>

        <label class="field">
          <span>停留时长（秒）</span>
          <input v-model.number="duration" type="number" min="0.1" step="0.5" />
        </label>

        <label class="field">
          <span>阈值 {{ params.threshold }}</span>
          <input v-model.number="params.threshold" type="range" min="0" max="255" step="1" />
        </label>

        <label class="field row">
          <input v-model="params.invert" type="checkbox" />
          <span>反相（深色图案取点）</span>
        </label>

        <label class="field">
          <span>最小间距 {{ params.minSpacing }} 米</span>
          <input v-model.number="params.minSpacing" type="range" min="1" max="50" step="0.5" />
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
          <div>采样步长：<b>{{ step }}</b> 像素</div>
          <div>预计无人机数：<b>{{ pointCount }}</b> 架 / 上限 {{ params.maxPoints }}</div>
        </div>
      </div>
    </div>

    <template #footer>
      <span class="hint">{{ rendering ? '计算中…' : '' }}</span>
      <button @click="close">取消</button>
      <button
        class="primary"
        :disabled="!imageInfo || pointCount === 0 || generating"
        @click="confirm"
      >
        {{ generating ? '生成中…' : isEdit ? '应用' : '生成并添加帧' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.body {
  display: flex;
  gap: 16px;
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
  width: 280px;
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
.stat {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-dim);
}
.stat b {
  color: var(--accent);
}
.hint {
  flex: 1;
  font-size: 12px;
  color: var(--text-dim);
}
</style>
