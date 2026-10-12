<script setup lang="ts">
/**
 * 时间线（视频编辑器式）：单轨道，横向排列帧片段，片段之间是过渡段。
 *
 * - 刻度尺 + 播放头：点击/拖动可 seek；
 * - 片段块：点击选中帧、✕ 删除、拖拽排序；
 * - 过渡段：已存在则点击编辑（并在下方展开编辑器），不存在则显示「+」新增；
 * - 播放控制（播放/暂停）与时间显示由父组件（App）持有，本组件只发意图事件。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildTimeline, sampleRenderSegment } from '../../core/transition'
import { getRender, renderRevision } from '../../render/renderStore'
import {
  clearThumbnailCache,
  computeBBox,
  renderThumbnail,
  unionBBox,
  type BBox,
  type PreviewPoint,
} from '../../render/preview'
import {
  activeFrameId,
  droneCount,
  editor,
  frames,
  selectFrame,
  transitions,
  type FrameView,
} from '../editor'

const props = defineProps<{
  currentTime: number
  playing: boolean
  selectedTransitionId: string | null
  canPlay: boolean
}>()
const emit = defineEmits<{
  (e: 'seek', time: number): void
  (e: 'toggle-play'): void
  (e: 'add-frame'): void
  (e: 'edit-frame', frameId: string): void
  (e: 'select-transition', transitionId: string): void
  (e: 'new-transition', payload: { fromFrameId: string; toFrameId: string }): void
}>()

/** 时间轴缩放：像素/秒（用户缩放的下限） */
const pxPerSec = ref(60)
/** 缩放的取值范围（对数映射，保证小/大跨度都好调） */
const ZOOM_MIN = 2
const ZOOM_MAX = 4000
/** 滑块位置（0~100，对数映射到 pxPerSec）：可一直放大到远超"铺满宽度" */
const zoomPos = computed({
  get: () => (100 * Math.log(pxPerSec.value / ZOOM_MIN)) / Math.log(ZOOM_MAX / ZOOM_MIN),
  set: (v: number) => {
    const t = Math.min(100, Math.max(0, v)) / 100
    pxPerSec.value = ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, t)
  },
})
/** 拖拽排序时的源下标 */
const dragFrom = ref<number | null>(null)

/** 刻度尺容器（用于自适应铺满宽度） */
const rulerEl = ref<HTMLElement>()
const containerWidth = ref(0)
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  const el = rulerEl.value
  if (!el) return
  containerWidth.value = el.clientWidth
  resizeObserver = new ResizeObserver(() => {
    containerWidth.value = rulerEl.value?.clientWidth ?? 0
  })
  resizeObserver.observe(el)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

/** 总时长（依赖 frames/transitions 触发重算） */
const duration = computed(() => {
  frames.value
  transitions.value
  return buildTimeline(editor.track).duration
})

/**
 * 生效的像素/秒：完全由滑块控制（可自由放大/缩小），
 * 需要"铺满宽度"时用「适配」按钮一键设置。
 */
const pxPerSecEff = computed(() => pxPerSec.value)

/** 一键让整条时间线铺满容器宽度 */
function fitZoom(): void {
  const d = duration.value
  if (d <= 0 || containerWidth.value <= 0) return
  pxPerSec.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, containerWidth.value / d))
}

interface Block {
  kind: 'hold' | 'transition'
  id: string
  width: number
  frame?: FrameView
  index: number
  transitionId?: string
  fromId?: string
  toId?: string
  transitionDuration?: number
  algorithm?: string
}

/** 顺序展开：帧块 → （其后的过渡块）→ 下一帧块。
 *  宽度严格 = 时长 × 像素/秒，保证播放头/刻度与片段精确对齐（不加最小宽度、不加外边距）。 */
const blocks = computed<Block[]>(() => {
  const px = pxPerSecEff.value
  const list: Block[] = []
  frames.value.forEach((f, i) => {
    list.push({ kind: 'hold', id: f.id, width: f.duration * px, frame: f, index: i })
    const next = frames.value[i + 1]
    if (!next) return
    const tr = transitions.value.find((t) => t.fromFrameId === f.id && t.toFrameId === next.id)
    list.push({
      kind: 'transition',
      id: tr?.id ?? `gap:${f.id}:${next.id}`,
      // 无过渡时占 0 宽（对应时间轴上 0 时长），仅作为一个"新增"的浮层锚点
      width: tr ? (tr.duration + tr.stagger) * px : 0,
      index: i,
      transitionId: tr?.id,
      fromId: f.id,
      toId: next.id,
      transitionDuration: tr ? tr.duration + tr.stagger : undefined,
      algorithm: tr?.algorithm,
    })
  })
  return list
})

const trackWidth = computed(() => blocks.value.reduce((sum, b) => sum + b.width, 0))
const playheadX = computed(() => props.currentTime * pxPerSecEff.value)

/** 刻度步长：保证相邻标签间距不小于 ~46px，取 1/2/5/10/15/30/60… 等"好看"值 */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
const tickStep = computed(() => {
  const px = pxPerSecEff.value
  if (px <= 0) return 1
  const want = 46 / px
  for (const s of TICK_STEPS) if (s >= want) return s
  return TICK_STEPS[TICK_STEPS.length - 1]
})
/** 当前要显示的秒刻度（按步长间隔采样） */
const ticks = computed(() => {
  const step = tickStep.value
  const max = Math.max(step, Math.ceil(duration.value / step) * step)
  const arr: number[] = []
  for (let t = 0; t <= max + 1e-6; t += step) arr.push(t)
  return arr
})

// ---------------------------------------------------- 胶片条缩略图（剪映风格）

/**
 * 缩略图：渲染分辨率 = 显示尺寸 × SS（再缩小显示）→ 点更小更细。
 * PREVIEW_H 为参考高度；渲染高度 = PREVIEW_H × SS。
 */
const PREVIEW_H = 66
const SS = 3
/** 数据结构变更后（防抖）自增，用于失效缓存；拖动过程中不实时重算 */
const stripEpoch = ref(0)
let stripTimer: number | undefined
const pointCache = new Map<string, PreviewPoint[]>()
const bboxCache = new Map<string, { bbox: BBox; aspect: number }>()
watch([frames, transitions, renderRevision], () => {
  window.clearTimeout(stripTimer)
  stripTimer = window.setTimeout(() => {
    pointCache.clear()
    bboxCache.clear()
    clearThumbnailCache()
    stripEpoch.value++
  }, 200)
})
onBeforeUnmount(() => window.clearTimeout(stripTimer))

/** 取某帧点位（转成预览结构，按 epoch 记忆） */
function framePreviewPoints(frameId: string): PreviewPoint[] {
  const key = `${frameId}:${stripEpoch.value}`
  let pts = pointCache.get(key)
  if (!pts) {
    pts = editor.getFramePoints(frameId).map((p) => ({ x: p.x, y: p.y, r: p.r, g: p.g, b: p.b }))
    pointCache.set(key, pts)
  }
  return pts
}

/** 包围盒宽高比（限制在 [0.6, 6]，避免极端长条） */
function aspectOf(bbox: BBox): number {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const a = h > 1e-9 ? w / h : 1
  return Math.min(6, Math.max(0.6, a))
}

/** 某帧的包围盒 + 宽高比（按 epoch 记忆，避免重复扫描） */
function frameBBox(id: string): { bbox: BBox; aspect: number } {
  const key = `b:${id}:${stripEpoch.value}`
  let v = bboxCache.get(key)
  if (!v) {
    const bbox = computeBBox(framePreviewPoints(id))
    v = { bbox, aspect: aspectOf(bbox) }
    bboxCache.set(key, v)
  }
  return v
}

/** 过渡两端并集的包围盒 + 宽高比（按 epoch 记忆） */
function pairBBox(fromId: string, toId: string): { bbox: BBox; aspect: number } {
  const key = `p:${fromId}>${toId}:${stripEpoch.value}`
  let v = bboxCache.get(key)
  if (!v) {
    const bbox = unionBBox(frameBBox(fromId).bbox, frameBBox(toId).bbox)
    v = { bbox, aspect: aspectOf(bbox) }
    bboxCache.set(key, v)
  }
  return v
}

/** 采样某个进度的点位：有产物用产物，否则按索引直线插值近似 */
function samplePoints(
  render: ReturnType<typeof getRender>,
  from: PreviewPoint[],
  to: PreviewPoint[],
  t: number,
): PreviewPoint[] {
  if (render) {
    return sampleRenderSegment(render, t).map((s) => ({
      x: s.x,
      y: s.y,
      r: s.r,
      g: s.g,
      b: s.b,
      alpha: s.alpha,
    }))
  }
  return from.map((p, k) => {
    const q = to[k] ?? p
    return {
      x: p.x + (q.x - p.x) * t,
      y: p.y + (q.y - p.y) * t,
      r: Math.round(p.r + (q.r - p.r) * t),
      g: Math.round(p.g + (q.g - p.g) * t),
      b: Math.round(p.b + (q.b - p.b) * t),
    }
  })
}

/** 计算一个片段要平铺的胶片条：按自然方块大小铺满整段（张数不设上限） */
function blockStrip(block: Block): { tiles: string[]; tileW: number } {
  const blockW = Math.max(1, block.width)

  if (block.kind === 'hold' && block.frame) {
    const id = block.frame.id
    const { bbox, aspect } = frameBBox(id)
    const { n, tileW, renderW, renderH } = stripLayout(blockW, aspect)
    const url = renderThumbnail(
      `f:${id}:${stripEpoch.value}:${aspect.toFixed(3)}`,
      () => framePreviewPoints(id),
      bbox,
      renderW,
      renderH,
    )
    return { tiles: Array.from({ length: n }, () => url), tileW }
  }

  const fromId = block.fromId!
  const toId = block.toId!
  const { bbox, aspect } = pairBBox(fromId, toId)
  const { n, tileW, renderW, renderH } = stripLayout(blockW, aspect)
  const render = block.transitionId ? getRender(block.transitionId) : null
  const tiles: string[] = []
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1)
    const bucket = Math.round(t * 50)
    const key = render
      ? `t:${block.transitionId}:${renderRevision.value}:${bucket}:${aspect.toFixed(3)}`
      : `g:${fromId}:${toId}:${stripEpoch.value}:${bucket}:${aspect.toFixed(3)}`
    tiles.push(
      renderThumbnail(
        key,
        () => samplePoints(render, framePreviewPoints(fromId), framePreviewPoints(toId), bucket / 50),
        bbox,
        renderW,
        renderH,
      ),
    )
  }
  return { tiles, tileW }
}

/**
 * 胶片条布局：按自然方块大小铺满整段，张数不设上限。
 * 自然宽由内容宽高比决定；渲染分辨率 = 自然尺寸 × SS（缩小显示 → 点更小）。
 */
function stripLayout(
  blockW: number,
  aspect: number,
): { n: number; tileW: number; renderW: number; renderH: number } {
  const tileW = Math.max(24, PREVIEW_H * aspect)
  const n = Math.max(1, Math.ceil(blockW / tileW))
  return {
    n,
    tileW,
    renderW: Math.max(16, Math.round(PREVIEW_H * aspect)) * SS,
    renderH: PREVIEW_H * SS,
  }
}

/** 所有片段的胶片条（按 block.id 索引，随依赖变化重算） */
const strips = computed(() => {
  const map = new Map<string, { tiles: string[]; tileW: number }>()
  for (const b of blocks.value) map.set(b.id, blockStrip(b))
  return map
})

function stripOf(block: Block): { tiles: string[]; tileW: number } {
  return strips.value.get(block.id) ?? { tiles: [], tileW: PREVIEW_H }
}

/** 通过点击位置换算时间（相对轨道左边缘） */
function seekFromEvent(e: { clientX: number }, el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  const x = e.clientX - rect.left + el.scrollLeft
  emit('seek', Math.max(0, Math.min(duration.value, x / pxPerSecEff.value)))
}

// 播放头拖拽（scrub）：按下即定位并捕获指针，移动时持续 seek，抬起结束
let scrubbing = false

function onScrubStart(e: PointerEvent, el: HTMLElement): void {
  scrubbing = true
  el.setPointerCapture?.(e.pointerId)
  seekFromEvent(e, el)
}

function onScrubMove(e: PointerEvent, el: HTMLElement): void {
  if (scrubbing) seekFromEvent(e, el)
}

function onScrubEnd(e: PointerEvent, el: HTMLElement): void {
  if (!scrubbing) return
  scrubbing = false
  el.releasePointerCapture?.(e.pointerId)
}

function onHoldClick(index: number, frameId: string): void {
  // 点击帧块仅选中；改参数走块上的「✎」编辑
  selectFrame(frameId)
  void index
}

function addTransition(fromId: string, toId: string): void {
  // 不再立刻创建过渡，而是打开“配置 + 生成产物”的草稿
  emit('new-transition', { fromFrameId: fromId, toFrameId: toId })
}

function onTransitionClick(block: Block): void {
  if (block.transitionId) emit('select-transition', block.transitionId)
  else if (block.fromId && block.toId) addTransition(block.fromId, block.toId)
}

function onDrop(toIndex: number): void {
  if (dragFrom.value === null || dragFrom.value === toIndex) return
  editor.moveFrame(dragFrom.value, toIndex)
  dragFrom.value = null
}

function formatTime(t: number): string {
  return `${t.toFixed(1)}s`
}
</script>

<template>
  <div class="timeline">
    <!-- 控制条：播放 / 时间 / 缩放 -->
    <div class="controls">
      <button
        class="play"
        :disabled="!playing && !canPlay"
        :title="canPlay ? '播放 / 暂停（空格）' : '请先对每个过渡点击「开始计算」生成产物'"
        @click="emit('toggle-play')"
      >
        {{ playing ? '⏸ 暂停' : '▶ 播放' }}
      </button>
      <button @click="emit('add-frame')">＋ 新增帧</button>
      <span class="time">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
      <span class="hint">无人机总数 {{ droneCount }}</span>
      <label class="zoom">
        缩放
        <input v-model.number="zoomPos" type="range" min="0" max="100" step="1" />
        <button class="fit" title="让整条时间线铺满宽度" @click="fitZoom">适配</button>
      </label>
    </div>

    <!-- 刻度尺 + 轨道共用同一横向滚动容器，保证播放头 / 刻度 / 片段始终对齐 -->
    <div class="tl-scroll" ref="rulerEl">
    <div
      class="ruler"
      @pointerdown="onScrubStart($event, $event.currentTarget as HTMLElement)"
      @pointermove="onScrubMove($event, $event.currentTarget as HTMLElement)"
      @pointerup="onScrubEnd($event, $event.currentTarget as HTMLElement)"
      @pointercancel="onScrubEnd($event, $event.currentTarget as HTMLElement)"
    >
      <div class="ruler-inner" :style="{ width: trackWidth + 'px' }">
        <span
          v-for="t in ticks"
          :key="t"
          class="tick"
          :style="{ left: t * pxPerSecEff + 'px' }"
        >
          {{ t }}s
        </span>
        <div class="playhead" :style="{ left: playheadX + 'px' }">
          <span class="playhead-knob" />
        </div>
      </div>
    </div>

      <!-- 轨道：帧块 + 过渡块 -->
      <div class="track" :style="{ width: trackWidth + 'px' }">
        <template v-for="block in blocks" :key="block.id">
          <!-- 帧片段 -->
          <div
            v-if="block.kind === 'hold'"
            class="clip"
            :class="{ active: block.frame?.id === activeFrameId }"
            :style="{ width: block.width + 'px' }"
            :draggable="true"
            @click="onHoldClick(block.index, block.frame!.id)"
            @dragstart="dragFrom = block.index"
            @dragover.prevent
            @drop="onDrop(block.index)"
          >
            <div class="filmstrip" :style="{ '--tw': stripOf(block).tileW + 'px' }">
              <template v-for="(u, i) in stripOf(block).tiles" :key="i">
                <img v-if="u" :src="u" class="tile" draggable="false" alt="" />
                <div v-else class="tile placeholder" />
              </template>
            </div>
            <div class="clip-meta">
              <div class="clip-name">{{ block.frame?.name }}</div>
              <div class="clip-sub">{{ block.frame?.duration }}s · {{ block.frame?.pointCount }} 点</div>
            </div>
            <button
              class="clip-edit"
              title="编辑帧"
              @click.stop="emit('edit-frame', block.frame!.id)"
            >
              ✎
            </button>
            <button
              class="clip-del"
              title="删除帧"
              @click.stop="editor.removeFrame(block.frame!.id)"
            >
              ✕
            </button>
          </div>

          <!-- 过渡段 -->
          <div
            v-else
            class="trans"
            :class="{ active: block.transitionId === props.selectedTransitionId, empty: !block.transitionId }"
            :style="{ width: block.width + 'px' }"
            :title="block.transitionId ? '点击编辑过渡' : '点击新增过渡'"
            @click="onTransitionClick(block)"
          >
            <template v-if="block.transitionId">
              <div class="filmstrip" :style="{ '--tw': stripOf(block).tileW + 'px' }">
                <template v-for="(u, i) in stripOf(block).tiles" :key="i">
                  <img v-if="u" :src="u" class="tile" draggable="false" alt="" />
                  <div v-else class="tile placeholder" />
                </template>
              </div>
              <span class="trans-label">
                {{ block.algorithm }} · {{ block.transitionDuration }}s
              </span>
            </template>
            <span v-else class="trans-add">+</span>
          </div>
        </template>

        <div v-if="blocks.length === 0" class="empty-track" @click="emit('add-frame')">
          点击「＋ 新增帧」导入图片生成第一个帧片段
        </div>
        <div class="playhead track-playhead" :style="{ left: playheadX + 'px' }" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  border-top: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
}
.controls {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.play {
  min-width: 72px;
}
.time {
  color: var(--text);
}
.hint {
  margin-left: auto;
}
.zoom {
  display: flex;
  align-items: center;
  gap: 6px;
}
.zoom input {
  width: 120px;
}
.ruler {
  position: relative;
  height: 22px;
  overflow: visible;
  border-bottom: 1px solid var(--border);
  cursor: ew-resize;
  user-select: none;
  touch-action: none;
}
.ruler-inner {
  position: relative;
  height: 100%;
}
.tick {
  position: absolute;
  top: 4px;
  font-size: 10px;
  color: var(--text-dim);
  border-left: 1px solid var(--border);
  padding-left: 2px;
  white-space: nowrap;
}
.tl-scroll {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px 0;
}
.track {
  position: relative;
  display: flex;
  align-items: stretch;
  height: 78px;
  padding: 0;
}
.clip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  overflow: hidden;
  cursor: pointer;
  flex-shrink: 0;
}
.clip.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
/* 胶片条：铺满片段背景的等宽方块缩略图（剪映风格） */
.filmstrip {
  position: absolute;
  inset: 0;
  display: flex;
  overflow: hidden;
  border-radius: 5px;
}
.filmstrip .tile {
  width: var(--tw, 66px);
  height: 100%;
  object-fit: cover;
  flex: 0 0 auto;
}
.filmstrip .tile.placeholder {
  background: rgba(255, 255, 255, 0.04);
}
.clip-meta {
  position: relative;
  z-index: 1;
  padding: 3px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.42);
  min-width: 0;
}
.clip-name {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.clip-sub {
  font-size: 10px;
  color: var(--text-dim);
  white-space: nowrap;
}
.clip-edit,
.clip-del {
  position: absolute;
  top: 2px;
  padding: 0 4px;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.4);
  border: none;
}
.clip-edit {
  right: 26px;
}
.clip-del {
  right: 2px;
}
.trans {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: 1px dashed var(--success);
  background: rgba(74, 217, 145, 0.08);
  color: var(--success);
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
  overflow: hidden;
}
.trans.empty {
  overflow: visible;
  border: none;
  background: none;
  margin: 0;
  padding: 0;
}
.trans.active {
  border-style: solid;
  box-shadow: 0 0 0 1px var(--success) inset;
}
.trans-label {
  position: relative;
  z-index: 1;
  white-space: nowrap;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.42);
}
.trans-add {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px dashed var(--accent);
  background: rgba(54, 198, 255, 0.12);
  color: var(--accent);
  font-size: 14px;
  line-height: 1;
}
.empty-track {
  align-self: center;
  margin-left: 12px;
  color: var(--text-dim);
  font-size: 12px;
}
.playhead {
  position: absolute;
  top: 0;
  width: 1px;
  background: var(--danger);
  pointer-events: none;
}
.playhead-knob {
  position: absolute;
  top: 0;
  left: -4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--danger);
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.25);
}
.ruler .playhead {
  bottom: 0;
  height: 100%;
}
.track-playhead {
  height: 100%;
}
</style>
