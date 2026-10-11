<script setup lang="ts">
/**
 * 过渡设置（右侧停靠栏）= 过渡的「配置 + 生成产物」。
 *
 * 流程：
 *   1) 配参数（草稿，不落库）；
 *   2) 点【预览】→ Worker 计算匹配 → 组装产物（轨道/统计/图表/轨迹）→ **只在内存**；
 *   3) 点【新增】/【保存修改】→ 才把过渡参数 + 产物写入 OPFS（SQLite）。
 *
 * 产物本随工程/过渡，可删除；编辑帧或参数不会自动更新已保存产物，需手动再预览+保存。
 */
import { computed, reactive, ref, watch } from 'vue'
import { droneLimits, editor, getPointsByFrame, setDroneLimits, showTrails } from '../editor'
import { service } from '../projects'
import { buildRender, renderSignature } from '../../core/transition'
import { SAFETY_LIMITS, minDurationForLimits, type SafetyResult } from '../../core/safety'
import {
  getRender,
  renderRevision,
  selectedRenderId,
  setRender,
} from '../../render/renderStore'
import { getRenderClient } from '../../render/renderClient'
import { createTransition } from '../../core/factory'
import type { Transition } from '../../core/types'
import StatCharts from './StatCharts.vue'

interface EditorState {
  mode: 'new' | 'edit'
  transitionId?: string
  fromFrameId?: string
  toFrameId?: string
}

const props = defineProps<{ state: EditorState | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'preview', id: string): void }>()

const DEFAULT_PARAMS: Record<string, number> = {
  wDist: 1, costPower: 1,
  wEven: 0, evenMode: 0, targetDistance: 0, evenIterations: 6,
  wAngle: 0, wGroup: 0,
  wOrder: 0, rankAxis: 0,
  wRadial: 0, wAngular: 0,
  neighborLimit: 0, epsilon: 0.05, secondaryMinTotal: 1, avoid: 1,
  curvature: 0.25, arcDirection: 0, waveAmp: 0,
  speedMode: 0, accelRatio: 0.25, maxSpeedOverride: 0, maxAccelOverride: 0,
  staggerOrder: 0,
  minSeparation: 0, separationStrength: 0.5, separationIterations: 1,
  unusedMode: 0, parkGap: 0, parkSpacing: 0, parkDim: 0.25,
}

const form = reactive<Transition>({
  id: '',
  fromFrameId: '',
  toFrameId: '',
  duration: 2,
  algorithm: 'bottleneck',
  path: 'linear',
  velocityProfile: 'ease',
  easing: 'easeInOut',
  stagger: 0,
  params: { ...DEFAULT_PARAMS },
})

const open = computed(() => !!props.state)
const mode = computed(() => props.state?.mode ?? 'new')

const simple = ref(true)
const showAdvanced = ref(false)
const limitSpeed = ref(0)
const limitAccel = ref(0)
const rendering = ref(false)
const persisted = ref(false)
const dirty = ref(false)
const safety = ref<SafetyResult | null>(null)
const checking = ref(false)
let lastElapsed = 0
let syncing = false

// 预设
const W = (o: Record<string, number>): Record<string, number> => ({
  wDist: 0, wEven: 0, wAngle: 0, wGroup: 0, wOrder: 0, wRadial: 0, wAngular: 0, ...o,
})
interface Preset {
  key: string
  label: string
  hint: string
  algorithm?: Transition['algorithm']
  path?: Transition['path']
  velocityProfile?: Transition['velocityProfile']
  easing?: Transition['easing']
  duration?: number
  stagger?: number
  params: Record<string, number>
}
const PRESETS: Preset[] = [
  { key: 'shortest', label: '最短路程', hint: '总路程最短', algorithm: 'hungarian', path: 'linear', velocityProfile: 'ease', easing: 'easeInOut', duration: 3, stagger: 0, params: W({ wDist: 1 }) },
  { key: 'even', label: '最均匀', hint: '各点移动距离尽量相等', algorithm: 'hungarian', path: 'linear', velocityProfile: 'ease', easing: 'easeInOut', duration: 3, stagger: 0, params: W({ wDist: 0.2, wEven: 1 }) },
  { key: 'parallel', label: '平行流动', hint: '方向一致、少交叉', algorithm: 'hungarian', path: 'linear', velocityProfile: 'ease', easing: 'easeInOut', duration: 3, stagger: 0, params: W({ wDist: 0.5, wAngle: 1 }) },
  { key: 'group', label: '保持分组', hint: '同组尽量互配', algorithm: 'hungarian', path: 'linear', velocityProfile: 'ease', easing: 'easeInOut', duration: 3, stagger: 0, params: W({ wDist: 0.5, wGroup: 1 }) },
  { key: 'ring', label: '保持环状', hint: '保持半径与极角', algorithm: 'hungarian', path: 'linear', velocityProfile: 'ease', easing: 'easeInOut', duration: 3, stagger: 0, params: W({ wDist: 0.5, wRadial: 1, wAngular: 0.5 }) },
  { key: 'order', label: '顺序流动', hint: '保持相对顺序', algorithm: 'hungarian', path: 'linear', velocityProfile: 'ease', easing: 'easeInOut', duration: 3, stagger: 0, params: W({ wDist: 0.5, wOrder: 1 }) },
  { key: 'fast', label: '快速会聚', hint: '最小化最大距离、更快', algorithm: 'bottleneck', path: 'linear', velocityProfile: 'trapezoid', easing: 'easeInOut', duration: 2, stagger: 0, params: W({ wDist: 1 }) },
]

const activePreset = computed(() => {
  const hit = PRESETS.find((p) => {
    if ((p.algorithm ?? form.algorithm) !== form.algorithm) return false
    if ((p.path ?? 'linear') !== form.path) return false
    if ((p.velocityProfile ?? 'ease') !== form.velocityProfile) return false
    if ((p.easing ?? 'easeInOut') !== form.easing) return false
    if ((p.duration ?? form.duration) !== form.duration) return false
    if ((p.stagger ?? 0) !== form.stagger) return false
    for (const [k, v] of Object.entries(p.params)) {
      if (Math.abs((form.params[k] ?? 0) - v) > 1e-6) return false
    }
    return true
  })
  return hit?.key ?? null
})

/** 打开时按模式初始化表单 */
function setupForm(): void {
  syncing = true
  const limits = droneLimits.value
  limitSpeed.value = limits.maxSpeed
  limitAccel.value = limits.maxAccel
  dirty.value = false
  const s = props.state
  if (!s) return
  if (s.mode === 'new' && s.fromFrameId && s.toFrameId) {
    Object.assign(form, createTransition(s.fromFrameId, s.toFrameId))
    form.params = { ...DEFAULT_PARAMS, ...form.params }
    persisted.value = false
  } else if (s.mode === 'edit' && s.transitionId) {
    const t = editor.getTransition(s.transitionId)
    if (t) {
      Object.assign(form, {
        id: t.id,
        fromFrameId: t.fromFrameId,
        toFrameId: t.toFrameId,
        duration: t.duration,
        algorithm: t.algorithm,
        path: t.path,
        velocityProfile: t.velocityProfile ?? 'ease',
        easing: t.easing,
        stagger: t.stagger ?? 0,
        params: { ...DEFAULT_PARAMS, ...t.params },
      })
    }
    persisted.value = true
    selectedRenderId.value = form.id
  }
  syncing = false
}
watch(() => props.state, setupForm, { immediate: true })

// 参数改动 → 标记“未重新生成”
watch(
  () => JSON.stringify(form),
  () => {
    if (!syncing) dirty.value = true
  },
)

const render = computed(() => {
  renderRevision.value
  return getRender(form.id)
})
const stats = computed(() => render.value?.stats ?? null)

/** 深度分层避让信息（层数 / 最大深度偏移，米） */
const avoidInfo = computed(() => {
  const a = render.value?.avoid
  if (!a || a.colors <= 0) return null
  let maxL = 0
  for (const v of a.layer) maxL = Math.max(maxL, Math.abs(v))
  return { colors: a.colors, maxDepth: maxL * a.spacing }
})

const effMaxSpeed = computed(() => form.params.maxSpeedOverride || limitSpeed.value)
const effMaxAccel = computed(() => form.params.maxAccelOverride || limitAccel.value)
const speedOver = computed(() => effMaxSpeed.value > 0 && !!stats.value && stats.value.peakSpeed > effMaxSpeed.value)
const accelOver = computed(() => effMaxAccel.value > 0 && !!stats.value && stats.value.peakAccel > effMaxAccel.value)

/** 当前表单快照（存库/建产物用） */
function snapshot(): Transition {
  const params: Record<string, number> = {}
  for (const key of Object.keys(DEFAULT_PARAMS)) params[key] = Number(form.params[key]) || 0
  return {
    id: form.id,
    fromFrameId: form.fromFrameId,
    toFrameId: form.toFrameId,
    duration: Math.max(0.1, Number(form.duration) || 0.1),
    algorithm: form.algorithm,
    path: form.path,
    velocityProfile: form.velocityProfile,
    easing: form.easing,
    stagger: Math.max(0, Number(form.stagger) || 0),
    params,
  }
}

/** 预览：Worker 计算匹配 → 组装产物（仅内存） */
async function doPreview(): Promise<boolean> {
  const byFrame = getPointsByFrame()
  const a = byFrame.get(form.fromFrameId) ?? []
  const b = byFrame.get(form.toFrameId) ?? []
  if (a.length === 0 || b.length === 0) return false
  rendering.value = true
  try {
    const transition = snapshot()
    const assignment = await getRenderClient().compute(
      a,
      b,
      transition,
      transition.params.avoid ? SAFETY_LIMITS.minSeparation : 0,
    )
    lastElapsed = assignment.elapsedMs
    const built = buildRender(a, b, transition, assignment)
    setRender(form.id, built)
    selectedRenderId.value = form.id
    dirty.value = false
    return true
  } finally {
    rendering.value = false
  }
}

/** 安全检测（30fps 采样；Worker） */
async function runSafety(): Promise<void> {
  const r = render.value
  if (!r) {
    safety.value = null
    return
  }
  checking.value = true
  try {
    safety.value = await getRenderClient().safety(r, SAFETY_LIMITS, 30)
  } catch {
    safety.value = null
  } finally {
    checking.value = false
  }
}

watch(render, () => void runSafety(), { immediate: true })

/** 一键安全适配：迭代调「时长（速度/加速度）+ 斥力·错峰（间距）」直到通过或放弃 */
async function autoFitSafety(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await runSafety()
    const s = safety.value
    if (!s || s.pass) return
    // 速度/加速度 → 反推最小时长
    const t = minDurationForLimits(s.metrics, SAFETY_LIMITS, form.duration)
    if (t > form.duration + 1e-6) form.duration = Math.max(0.1, Math.ceil(t * 10) / 10)
    // 间距（交叉）→ 开启深度分层避让即可彻底解决；
    // 不用逐帧斥力（会抖动、并抬高速度），也不用错峰（实测无效）
    if (s.failures.includes('minSeparation')) {
      form.params.avoid = 1
      form.params.minSeparation = SAFETY_LIMITS.minSeparation
    }
    await doPreview()
  }
  await runSafety()
}

/** 新增 / 保存修改：把过渡参数 + 产物持久化到 OPFS */
async function onCommit(): Promise<void> {
  if (!render.value) {
    const ok = await doPreview()
    if (!ok) return
  }
  if (!safety.value?.pass) {
    await runSafety()
    if (!safety.value?.pass) {
      alert('安全检测未通过：请先点「安全适配」，或调整参数使其不超限后再保存。')
      return
    }
  }
  const transition = snapshot()
  editor.upsertTransition(transition)
  const byFrame = getPointsByFrame()
  const signature = renderSignature(
    transition.fromFrameId,
    transition.toFrameId,
    byFrame.get(transition.fromFrameId) ?? [],
    byFrame.get(transition.toFrameId) ?? [],
    { algorithm: transition.algorithm, params: transition.params },
  )
  const r = render.value
  if (r) {
    await service.saveRender({
      transitionId: transition.id,
      signature,
      algorithm: transition.algorithm,
      payload: JSON.stringify(r),
      elapsedMs: lastElapsed,
      createdAt: Date.now(),
    })
  }
  persisted.value = true
  dirty.value = false
}

function applyPreset(p: Preset): void {
  if (p.algorithm) form.algorithm = p.algorithm
  if (p.path) form.path = p.path
  if (p.velocityProfile) form.velocityProfile = p.velocityProfile
  if (p.easing) form.easing = p.easing
  if (typeof p.duration === 'number') form.duration = p.duration
  if (typeof p.stagger === 'number') form.stagger = p.stagger
  form.params = { ...DEFAULT_PARAMS, ...p.params }
}

function applyLimits(): void {
  setDroneLimits({ maxSpeed: Number(limitSpeed.value) || 0, maxAccel: Number(limitAccel.value) || 0 })
}

function close(): void {
  // 只关闭面板；保留内存中的预览产物，使飞行轨迹在关闭后仍然显示
  emit('close')
}

/** 点【预览】= 计算产物 + 立即播放 */
async function onPreview(): Promise<void> {
  const ok = await doPreview()
  if (ok) emit('preview', form.id)
}
</script>

<template>
  <aside class="drawer" :class="{ open }">
    <template v-if="open">
      <header class="head">
        <h3>{{ mode === 'new' ? '新增过渡' : '修改过渡' }}</h3>
        <button class="ghost" @click="close">✕</button>
      </header>

      <div class="scroll">
        <div class="modebar">
          <button :class="{ on: simple }" @click="simple = true">简单</button>
          <button :class="{ on: !simple }" @click="simple = false">高级</button>
        </div>
        <label class="trail-toggle">
          <input type="checkbox" v-model="showTrails" />
          <span>显示飞行轨迹</span>
        </label>

        <!-- 简单模式 -->
        <template v-if="simple">
          <div class="section">
            <div class="title">风格</div>
            <div class="presets">
              <button
                v-for="p in PRESETS"
                :key="p.key"
                :class="['preset', { active: activePreset === p.key }]"
                :title="p.hint"
                @click="applyPreset(p)"
              >
                {{ p.label }}
              </button>
            </div>
          </div>
          <div class="section">
            <div class="title">节奏</div>
            <label class="field">
              <span>转场时长 {{ form.duration }}s</span>
              <input v-model.number="form.duration" type="range" min="0.5" max="8" step="0.5" />
            </label>
            <label class="field">
              <span>出发错落 {{ form.stagger }}s</span>
              <input v-model.number="form.stagger" type="range" min="0" max="3" step="0.1" />
            </label>
            <label class="field">
              <span>到达方式</span>
              <select v-model.number="form.params.speedMode">
                <option :value="0">同时到达</option>
                <option :value="1">匀速前进（近的先到）</option>
              </select>
            </label>
            <label class="field">
              <span>未使用无人机</span>
              <select v-model.number="form.params.unusedMode">
                <option :value="0">飞往下方待命区</option>
                <option :value="1">原地淡出</option>
              </select>
            </label>
          </div>
        </template>

        <!-- 高级模式 -->
        <template v-else>
          <div class="section">
            <div class="title">① 求解器 + 加权评分</div>
            <label class="field">
              <span>求解器</span>
              <select v-model="form.algorithm">
                <option value="bottleneck">瓶颈（最小化最大得分）</option>
                <option value="hungarian">匈牙利（最小化总得分）</option>
                <option value="auction">拍卖（近似）</option>
                <option value="nearest">最近邻（贪心）</option>
                <option value="index">按索引</option>
              </select>
            </label>
            <label class="field">
              <span>距离权重 {{ form.params.wDist }}</span>
              <input v-model.number="form.params.wDist" type="range" min="0" max="5" step="0.1" />
            </label>
            <label class="field">
              <span>代价指数 p（dᵖ）{{ form.params.costPower }}</span>
              <input v-model.number="form.params.costPower" type="range" min="1" max="4" step="0.25" />
            </label>
            <label class="field">
              <span>均匀度权重 {{ form.params.wEven }}</span>
              <input v-model.number="form.params.wEven" type="range" min="0" max="5" step="0.1" />
            </label>
            <div v-if="form.params.wEven > 0" class="subrow">
              <label class="field">
                <span>目标距离 d*（0=自动）</span>
                <input v-model.number="form.params.targetDistance" type="number" min="0" step="1" />
              </label>
              <label class="field">
                <span>迭代</span>
                <input v-model.number="form.params.evenIterations" type="number" min="0" max="20" step="1" />
              </label>
              <label class="field">
                <span>偏差</span>
                <select v-model.number="form.params.evenMode">
                  <option :value="0">L1</option>
                  <option :value="1">L2</option>
                </select>
              </label>
            </div>
            <label class="field">
              <span>方向一致权重 {{ form.params.wAngle }}</span>
              <input v-model.number="form.params.wAngle" type="range" min="0" max="2" step="0.05" />
            </label>
            <label class="field">
              <span>同组保持权重 {{ form.params.wGroup }}</span>
              <input v-model.number="form.params.wGroup" type="range" min="0" max="2" step="0.1" />
            </label>
            <label class="field">
              <span>保持顺序权重 {{ form.params.wOrder }}</span>
              <input v-model.number="form.params.wOrder" type="range" min="0" max="2" step="0.1" />
            </label>
            <label v-if="form.params.wOrder > 0" class="field">
              <span>顺序轴</span>
              <select v-model.number="form.params.rankAxis">
                <option :value="0">极角</option>
                <option :value="1">X</option>
                <option :value="2">Y</option>
              </select>
            </label>
            <label class="field">
              <span>保持半径权重 {{ form.params.wRadial }}</span>
              <input v-model.number="form.params.wRadial" type="range" min="0" max="2" step="0.1" />
            </label>
            <label class="field">
              <span>保持极角权重 {{ form.params.wAngular }}</span>
              <input v-model.number="form.params.wAngular" type="range" min="0" max="2" step="0.05" />
            </label>
            <label class="field">
              <span>候选近邻数 K（0=全部）{{ form.params.neighborLimit }}</span>
              <input v-model.number="form.params.neighborLimit" type="range" min="0" max="50" step="1" />
            </label>
            <label v-if="form.algorithm === 'auction'" class="field">
              <span>ε 投标增量 {{ form.params.epsilon }}</span>
              <input v-model.number="form.params.epsilon" type="range" min="0.005" max="0.5" step="0.005" />
            </label>
            <label v-if="form.algorithm === 'bottleneck'" class="field row">
              <input v-model.number="form.params.secondaryMinTotal" type="checkbox" :true-value="1" :false-value="0" />
              <span>次级目标：最大得分最优后，总得分最短</span>
            </label>
            <label class="field row">
              <input v-model.number="form.params.avoid" type="checkbox" :true-value="1" :false-value="0" />
              <span>深度分层避让（直线打底，沿深度轴给冲突机分层，间距 ≥1.5）</span>
            </label>
          </div>

          <div class="section">
            <div class="title">② 路径（空间形状）</div>
            <label class="field">
              <span>轨迹</span>
              <select v-model="form.path">
                <option value="linear">直线</option>
                <option value="arc">弧线</option>
                <option value="bezier">曲线（贝塞尔）</option>
              </select>
            </label>
            <label v-if="form.path !== 'linear'" class="field">
              <span>曲率 {{ form.params.curvature }}</span>
              <input v-model.number="form.params.curvature" type="range" min="-1" max="1" step="0.05" />
            </label>
            <label v-if="form.path !== 'linear'" class="field">
              <span>绕行方向</span>
              <select v-model.number="form.params.arcDirection">
                <option :value="0">最短</option>
                <option :value="1">顺时针</option>
                <option :value="2">逆时针</option>
              </select>
            </label>
            <label v-if="form.path === 'bezier'" class="field">
              <span>S 形幅度 {{ form.params.waveAmp }}</span>
              <input v-model.number="form.params.waveAmp" type="range" min="-1" max="1" step="0.05" />
            </label>
          </div>

          <div class="section">
            <div class="title">③ 速度剖面 / 时间</div>
            <label class="field">
              <span>速度剖面</span>
              <select v-model="form.velocityProfile">
                <option value="ease">缓动</option>
                <option value="linear">线性</option>
                <option value="trapezoid">梯形 / S 曲线</option>
                <option value="minJerk">最小 jerk</option>
              </select>
            </label>
            <label v-if="form.velocityProfile === 'ease'" class="field">
              <span>缓动</span>
              <select v-model="form.easing">
                <option value="easeInOut">缓入缓出</option>
                <option value="linear">线性</option>
                <option value="easeIn">缓入</option>
                <option value="easeOut">缓出</option>
              </select>
            </label>
            <label v-if="form.velocityProfile === 'trapezoid'" class="field">
              <span>加速占比 {{ form.params.accelRatio }}</span>
              <input v-model.number="form.params.accelRatio" type="range" min="0" max="0.5" step="0.05" />
            </label>
            <label class="field">
              <span>时间模型</span>
              <select v-model.number="form.params.speedMode">
                <option :value="0">同时到达</option>
                <option :value="1">等速</option>
              </select>
            </label>
            <label class="field">
              <span>时长（秒）</span>
              <input v-model.number="form.duration" type="number" min="0.1" step="0.1" />
            </label>
          </div>

          <div class="section">
            <div class="title">④ 相位（谁先出发）</div>
            <label class="field">
              <span>错峰总时长 {{ form.stagger }}s</span>
              <input v-model.number="form.stagger" type="range" min="0" max="5" step="0.1" />
            </label>
            <label v-if="form.stagger > 0" class="field">
              <span>错峰顺序</span>
              <select v-model.number="form.params.staggerOrder">
                <option :value="0">按序号</option>
                <option :value="1">按距离</option>
                <option :value="2">按分组</option>
                <option :value="3">随机</option>
              </select>
            </label>
          </div>

          <div class="section">
            <div class="title">⑤ 未使用无人机</div>
            <label class="field">
              <span>处理方式</span>
              <select v-model.number="form.params.unusedMode">
                <option :value="0">飞往待命区（阵型下方）</option>
                <option :value="1">原地淡入淡出</option>
              </select>
            </label>
            <template v-if="form.params.unusedMode === 0">
              <label class="field">
                <span>待命区间距（0=自动）{{ form.params.parkGap }}</span>
                <input v-model.number="form.params.parkGap" type="range" min="0" max="300" step="10" />
              </label>
              <label class="field">
                <span>槽位间距（0=自动）{{ form.params.parkSpacing }}</span>
                <input v-model.number="form.params.parkSpacing" type="range" min="0" max="80" step="2" />
              </label>
              <label class="field">
                <span>待命透明度 {{ form.params.parkDim }}</span>
                <input v-model.number="form.params.parkDim" type="range" min="0" max="1" step="0.05" />
              </label>
            </template>
          </div>

          <div class="section">
            <button class="link" @click="showAdvanced = !showAdvanced">
              {{ showAdvanced ? '▾' : '▸' }} 高级参数
            </button>
            <template v-if="showAdvanced">
              <label class="field">
                <span>过渡级最大速度（0=用项目）</span>
                <input v-model.number="form.params.maxSpeedOverride" type="number" min="0" step="1" />
              </label>
              <label class="field">
                <span>过渡级最大加速度（0=用项目）</span>
                <input v-model.number="form.params.maxAccelOverride" type="number" min="0" step="1" />
              </label>
              <label class="field">
                <span>最小间距（斥力）{{ form.params.minSeparation }}</span>
                <input v-model.number="form.params.minSeparation" type="number" min="0" step="1" />
              </label>
              <label class="field">
                <span>斥力强度 {{ form.params.separationStrength }}</span>
                <input v-model.number="form.params.separationStrength" type="range" min="0" max="1" step="0.05" />
              </label>
            </template>
          </div>

          <div class="section">
            <div class="title">无人机能力上限（项目级）</div>
            <div class="row">
              <label class="field">
                <span>最大速度</span>
                <input v-model.number="limitSpeed" type="number" min="0" step="1" @change="applyLimits" />
              </label>
              <label class="field">
                <span>最大加速度</span>
                <input v-model.number="limitAccel" type="number" min="0" step="1" @change="applyLimits" />
              </label>
            </div>
          </div>
        </template>

        <!-- 统计（仅生成产物后显示） -->
        <div class="section">
          <div class="title">统计</div>
          <template v-if="stats">
            <div class="stats">
              <div>点对 <b>{{ stats.pairCount }}</b>　未用（退出/进入）<b>{{ stats.exitingCount }}/{{ stats.enteringCount }}</b></div>
              <div>段时长 <b>{{ stats.duration.toFixed(1) }}s</b></div>
              <div>距离 最小/中位/最大：<b>{{ stats.minDistance.toFixed(1) }}</b> / {{ stats.medianDistance.toFixed(1) }} / <b>{{ stats.maxDistance.toFixed(1) }}</b></div>
              <div>距离 均值±标准差（CV）：{{ stats.meanDistance.toFixed(1) }} ± {{ stats.stdDistance.toFixed(1) }}（{{ (stats.cv * 100).toFixed(0) }}%）</div>
              <div>总路程：<b>{{ stats.totalDistance.toFixed(0) }}</b></div>
              <div>总得分 / 最大得分：<b>{{ stats.totalScore.toFixed(1) }}</b> / {{ stats.maxScore.toFixed(2) }}</div>
              <div :class="{ over: speedOver }">峰值速度：<b>{{ stats.peakSpeed.toFixed(1) }}</b> / {{ effMaxSpeed || '∞' }}（均 {{ stats.avgSpeed.toFixed(1) }}）</div>
              <div :class="{ over: accelOver }">峰值加速度：<b>{{ stats.peakAccel.toFixed(1) }}</b> / {{ effMaxAccel || '∞' }}（均 {{ stats.avgAccel.toFixed(1) }}）</div>
              <div>峰值 jerk：{{ stats.peakJerk.toFixed(1) }}</div>
            </div>
            <StatCharts :stats="stats" :max-speed="effMaxSpeed" :max-accel="effMaxAccel" />
          </template>
        </div>

        <!-- 安全检测（硬约束：不通过不能保存） -->
        <div class="section">
          <div class="title">安全检测</div>
          <div v-if="!render" class="hint">生成产物后自动检测</div>
          <div v-else-if="checking" class="hint">检测中…</div>
          <template v-else-if="safety">
            <div class="badge" :class="safety.pass ? 'ok' : 'bad'">
              {{ safety.pass ? '通过' : '不通过（不能保存）' }}
            </div>
            <div class="stats">
              <div :class="{ over: safety.metrics.minSeparation < SAFETY_LIMITS.minSeparation }">
                最小间距：<b>{{ safety.metrics.minSeparation.toFixed(2) }}</b> / ≥ {{ SAFETY_LIMITS.minSeparation }}
              </div>
              <div :class="{ over: safety.metrics.hSpeed > SAFETY_LIMITS.hSpeed }">
                水平速度：<b>{{ safety.metrics.hSpeed.toFixed(2) }}</b> / ≤ {{ SAFETY_LIMITS.hSpeed }}
              </div>
              <div :class="{ over: safety.metrics.upSpeed > SAFETY_LIMITS.upSpeed }">
                上升速度：<b>{{ safety.metrics.upSpeed.toFixed(2) }}</b> / ≤ {{ SAFETY_LIMITS.upSpeed }}
              </div>
              <div :class="{ over: safety.metrics.downSpeed > SAFETY_LIMITS.downSpeed }">
                下降速度：<b>{{ safety.metrics.downSpeed.toFixed(2) }}</b> / ≤ {{ SAFETY_LIMITS.downSpeed }}
              </div>
              <div :class="{ over: safety.metrics.hAccel > SAFETY_LIMITS.hAccel }">
                水平加速度：<b>{{ safety.metrics.hAccel.toFixed(2) }}</b> / ≤ {{ SAFETY_LIMITS.hAccel }}
              </div>
              <div :class="{ over: safety.metrics.upAccel > SAFETY_LIMITS.upAccel }">
                上升加速度：<b>{{ safety.metrics.upAccel.toFixed(2) }}</b> / ≤ {{ SAFETY_LIMITS.upAccel }}
              </div>
              <div :class="{ over: safety.metrics.downAccel > SAFETY_LIMITS.downAccel }">
                下降加速度：<b>{{ safety.metrics.downAccel.toFixed(2) }}</b> / ≤ {{ SAFETY_LIMITS.downAccel }}
              </div>
              <div v-if="avoidInfo">
                深度分层避让：<b>{{ avoidInfo.colors }}</b> 层（最大 ±{{ avoidInfo.maxDepth.toFixed(1) }}m）
              </div>
            </div>
            <button v-if="!safety.pass" class="mini" :disabled="rendering || checking" @click="autoFitSafety">
              安全适配
            </button>
          </template>
        </div>
      </div>

      <footer class="foot">
        <button :disabled="rendering" @click="onPreview">{{ rendering ? '计算中…' : '预览' }}</button>
        <button class="primary" :disabled="rendering || (!!render && !!safety && !safety.pass)" @click="onCommit">
          {{ mode === 'new' ? '新增' : '保存修改' }}
        </button>
      </footer>
    </template>
  </aside>
</template>

<style scoped>
.drawer {
  width: 0;
  flex-shrink: 0;
  background: var(--panel);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.15s ease;
}
.drawer.open {
  width: 360px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.head h3 {
  margin: 0;
  font-size: 14px;
}
.ghost {
  background: transparent;
  border: none;
}
.modebar {
  display: flex;
  gap: 4px;
  padding: 8px 14px 0;
}
.modebar button {
  flex: 1;
  font-size: 12px;
  background: var(--panel-2);
}
.modebar button.on {
  background: var(--accent);
  color: #04121b;
  border-color: var(--accent);
}
.trail-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px 0;
  font-size: 12px;
  color: var(--text-dim);
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.preset {
  padding: 8px 14px;
  font-size: 13px;
}
.preset.active {
  background: var(--accent);
  color: #04121b;
  border-color: var(--accent);
  font-weight: 600;
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
}
.section {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.title {
  font-size: 12px;
  color: var(--accent);
  margin-bottom: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.field.row {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.field input,
.field select {
  min-width: 120px;
}
.subrow {
  display: flex;
  gap: 8px;
}
.subrow .field {
  flex: 1;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.link {
  background: transparent;
  border: none;
  color: var(--text-dim);
  padding: 0;
  font-size: 12px;
}
.hint {
  font-size: 12px;
  color: var(--text-dim);
}
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
  margin-bottom: 6px;
}
.badge.ok {
  background: #123626;
  color: var(--success);
}
.badge.bad {
  background: #3a2020;
  color: var(--danger);
}
.stats {
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-dim);
}
.stats b {
  color: var(--text);
}
.stats .over {
  color: var(--danger);
}
.stats .over b {
  color: var(--danger);
}
.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 14px;
  border-top: 1px solid var(--border);
}
</style>
