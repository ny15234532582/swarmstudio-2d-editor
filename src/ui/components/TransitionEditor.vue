<script setup lang="ts">
/**
 * 过渡设置（右侧停靠栏）= 过渡的「配置 + 生成产物」。
 *
 * 流程：
 *   1) 配参数（草稿，不落库）；
 *   2) 点【应用】→ 右下角弹窗：Worker 计算匹配 → 组装产物（只在内存）→ 安全检测逐项打勾
 *      → 给出「当前设置下符合要求的最短时长」→ 可预览（带进度条拖拽）；此时【保存】才写入 OPFS。
 *
 * 产物本随工程/过渡，可删除；编辑帧或参数不会自动更新已保存产物，需重新【应用】+【保存】。
 */
import { computed, reactive, ref, watch } from 'vue'
import { editor, getPointsByFrame, showTrails, showTransitionPreviewAt } from '../editor'
import { service } from '../projects'
import { buildRender, renderSignature, type RenderAssignment } from '../../core/transition'
import {
  SAFETY_LIMITS,
  minDurationForLimits,
  shortestDurationForLimits,
  type SafetyLimits,
  type SafetyResult,
} from '../../core/safety'
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
  // 安全限值（可配置；0=用系统默认 SAFETY_LIMITS）
  limMinSeparation: SAFETY_LIMITS.minSeparation,
  limHSpeed: SAFETY_LIMITS.hSpeed,
  limUpSpeed: SAFETY_LIMITS.upSpeed,
  limDownSpeed: SAFETY_LIMITS.downSpeed,
  limHAccel: SAFETY_LIMITS.hAccel,
  limUpAccel: SAFETY_LIMITS.upAccel,
  limDownAccel: SAFETY_LIMITS.downAccel,
}

/** 安全限值的参数键（用于 UI 与保留） */
const LIMIT_KEYS = [
  'limMinSeparation',
  'limHSpeed',
  'limUpSpeed',
  'limDownSpeed',
  'limHAccel',
  'limUpAccel',
  'limDownAccel',
] as const

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
const statsOpen = ref(false)
function closeStats(): void {
  statsOpen.value = false
}
const rendering = ref(false)
const persisted = ref(false)
const dirty = ref(false)
const safety = ref<SafetyResult | null>(null)
const checking = ref(false)
let lastElapsed = 0
let syncing = false

// ---------------------------------------------------- 确认弹窗（右下角）状态
type ConfirmPhase = 'computing' | 'mindur' | 'checking' | 'done' | 'failed'
const confirmOpen = ref(false)
const phase = ref<ConfirmPhase>('computing')
const checkedCount = ref(0)
const minDuration = ref<number | null>(null)
const minDurationApprox = ref(false)
const previewT = ref(0)
const previewPlaying = ref(false)
let previewRaf = 0
let previewLast = 0
/** 最近一次预览算出的匹配（与时长无关，可用于验证最短时长时复用，免重跑求解器） */
let lastAssignment: RenderAssignment | null = null

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
    for (const [k, v] of Object.entries(p.params)) {
      if (Math.abs((form.params[k] ?? 0) - v) > 1e-6) return false
    }
    return true
  })
  return hit?.key ?? null
})

/** 可应用：有起止帧即可（新建时会自动预选一个默认风格） */
const canApply = computed(() => !!form.fromFrameId && !!form.toFrameId)

/** 打开时按模式初始化表单 */
function setupForm(): void {
  syncing = true
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
  // 打开时：若无匹配风格则预选默认风格；并固定以简单模式打开（保证能看到风格）
  if (activePreset.value === null) applyPreset(PRESETS[0])
  simple.value = true
  // 每次打开重置确认弹窗与预览
  confirmOpen.value = false
  stopPreview()
  phase.value = 'computing'
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

/** 生效的安全限值：参数 >0 用参数，否则回退系统默认 SAFETY_LIMITS */
function effectiveLimits(): SafetyLimits {
  const pick = (k: string, d: number) => {
    const v = Number(form.params[k])
    return Number.isFinite(v) && v > 0 ? v : d
  }
  return {
    minSeparation: pick('limMinSeparation', SAFETY_LIMITS.minSeparation),
    hSpeed: pick('limHSpeed', SAFETY_LIMITS.hSpeed),
    upSpeed: pick('limUpSpeed', SAFETY_LIMITS.upSpeed),
    downSpeed: pick('limDownSpeed', SAFETY_LIMITS.downSpeed),
    hAccel: pick('limHAccel', SAFETY_LIMITS.hAccel),
    upAccel: pick('limUpAccel', SAFETY_LIMITS.upAccel),
    downAccel: pick('limDownAccel', SAFETY_LIMITS.downAccel),
  }
}

// 统计超限标红阈值：用生效的安全限值（水平速度/水平加速度）
const effMaxSpeed = computed(() => effectiveLimits().hSpeed)
const effMaxAccel = computed(() => effectiveLimits().hAccel)
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
      transition.params.avoid ? effectiveLimits().minSeparation : 0,
    )
    lastElapsed = assignment.elapsedMs
    lastAssignment = assignment
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
    safety.value = await getRenderClient().safety(r, effectiveLimits(), 30)
  } catch {
    safety.value = null
  } finally {
    checking.value = false
  }
}

// 注：安全检测改为在「确认修改」弹窗流程里执行（见 startConfirm），不再自动跑。

/** 一键安全适配：时长（速度/加速度）+ 开启深度分层避让（间距）直到通过或放弃 */
async function autoFitSafety(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await runSafety()
    const s = safety.value
    if (!s || s.pass) return
    // 速度/加速度 → 反推最小时长
    const t = minDurationForLimits(s.metrics, effectiveLimits(), form.duration)
    if (t > form.duration + 1e-6) form.duration = Math.max(0.1, Math.ceil(t * 10) / 10)
    // 间距（交叉）→ 开启深度分层避让即可彻底解决（不用逐帧斥力：会抖动、并抬高速度）
    if (s.failures.includes('minSeparation')) form.params.avoid = 1
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

// ---------------------------------------------------- 确认修改：右下角弹窗流程

const METRIC_ORDER = ['minSeparation', 'hSpeed', 'upSpeed', 'downSpeed', 'hAccel', 'upAccel', 'downAccel'] as const
const METRIC_LABELS: Record<string, string> = {
  minSeparation: '最小间距',
  hSpeed: '水平速度',
  upSpeed: '上升速度',
  downSpeed: '下降速度',
  hAccel: '水平加速度',
  upAccel: '上升加速度',
  downAccel: '下降加速度',
}
const METRIC_UNITS: Record<string, string> = {
  minSeparation: 'm',
  hSpeed: 'm/s',
  upSpeed: 'm/s',
  downSpeed: 'm/s',
  hAccel: 'm/s²',
  upAccel: 'm/s²',
  downAccel: 'm/s²',
}

interface CheckItem {
  key: string
  label: string
  unit: string
  value: number
  limit: number
  pass: boolean
}

const safetyItems = computed<CheckItem[]>(() => {
  const s = safety.value
  if (!s) return []
  const limits = effectiveLimits()
  return METRIC_ORDER.map((k) => {
    const value = s.metrics[k]
    const limit = limits[k]
    const pass = k === 'minSeparation' ? value >= limit - 1e-9 : value <= limit + 1e-9
    return { key: k, label: METRIC_LABELS[k], unit: METRIC_UNITS[k], value, limit, pass }
  })
})

const previewDuration = computed(() => {
  const r = render.value
  return r ? Math.max(0.1, r.duration + r.stagger) : 0
})
const previewTimeLabel = computed(() => {
  const dur = previewDuration.value
  return `${(previewT.value * dur).toFixed(1)}s / ${dur.toFixed(1)}s`
})
/** 间距不达标（缩时长无解，需避让） */
const separationFailed = computed(
  () => !!safety.value && safety.value.failures.includes('minSeparation'),
)

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 估算最短时长（由当前峰值反推；用于起点与兜底） */
function computeMinDuration(): void {
  const s = safety.value
  if (!s) {
    minDuration.value = null
    return
  }
  const est = shortestDurationForLimits(s.metrics, effectiveLimits(), form.duration)
  minDuration.value = Math.max(0.1, Math.round(est * 10) / 10)
}

/**
 * 实测确认最短时长：复用已算好的匹配（与时长无关），在候选时长上真实跑一次安全检测；
 * 不达标则用实测峰值重新反推并小幅上调。成功返回「经确认」的值，否则退回估算并标记「约」。
 */
async function confirmMinDuration(): Promise<void> {
  const s = safety.value
  const assignment = lastAssignment
  minDurationApprox.value = false
  if (!s || !assignment) {
    computeMinDuration()
    minDurationApprox.value = true
    return
  }
  const byFrame = getPointsByFrame()
  const a = byFrame.get(form.fromFrameId) ?? []
  const b = byFrame.get(form.toFrameId) ?? []
  const limits = effectiveLimits()
  const base = snapshot()
  let target = Math.max(0.1, Math.round(shortestDurationForLimits(s.metrics, limits, form.duration) * 10) / 10)
  let verified: number | null = null
  for (let i = 0; i < 4; i++) {
    const render = buildRender(a, b, { ...base, duration: target }, assignment)
    const res = await getRenderClient().safety(render, limits, 30)
    if (!res.failures.some((f) => f !== 'minSeparation')) {
      verified = target
      break
    }
    const re = shortestDurationForLimits(res.metrics, limits, target)
    target = Math.max(
      Math.round(re * 10) / 10,
      Math.round(target * 1.02 * 10) / 10,
      Math.round((target + 0.1) * 10) / 10,
    )
  }
  if (verified != null) {
    minDuration.value = verified
    minDurationApprox.value = false
  } else {
    computeMinDuration()
    minDurationApprox.value = true
  }
}

/** 逐个揭示安全检测项：检测完一项打一个勾（或叉） */
async function runCheckReveal(): Promise<void> {
  phase.value = 'checking'
  checkedCount.value = 0
  const items = safetyItems.value
  for (let i = 0; i < items.length; i++) {
    await delay(110)
    checkedCount.value = i + 1
  }
  phase.value = safety.value?.pass ? 'done' : 'failed'
  if (phase.value === 'done') {
    previewT.value = 0
    showTransitionPreviewAt(form.id, 0)
  }
}

/** 点【应用】：右下角弹窗 → 计算 → 安全检测逐项打勾 → 确认最短时长 → 预览 */
async function startConfirm(): Promise<void> {
  if (!form.fromFrameId || !form.toFrameId) return
  confirmOpen.value = true
  stopPreview()
  previewT.value = 0
  checkedCount.value = 0
  minDuration.value = null
  minDurationApprox.value = false
  safety.value = null
  phase.value = 'computing'
  const ok = await doPreview()
  if (!ok) {
    phase.value = 'failed'
    return
  }
  await runSafety()
  phase.value = 'mindur'
  await confirmMinDuration()
  await runCheckReveal()
}

/** 一键应用最短时长：设为该值并重算 + 验证（采样帧率变化有小误差，做有限次微调） */
async function applyMinDuration(): Promise<void> {
  if (minDuration.value == null) return
  stopPreview()
  phase.value = 'computing'
  let target = minDuration.value
  let applied = false
  for (let i = 0; i < 6; i++) {
    form.duration = target
    const ok = await doPreview()
    if (!ok) {
      phase.value = 'failed'
      return
    }
    await runSafety()
    const s = safety.value
    if (!s) {
      phase.value = 'failed'
      return
    }
    // 除间距外的项（速度/加速度）全部达标即为最短
    if (!s.failures.some((f) => f !== 'minSeparation')) {
      minDuration.value = Math.round(target * 10) / 10
      minDurationApprox.value = false
      applied = true
      break
    }
    // 微调：小幅加时长重试
    target = Math.round((target * 1.01 + 0.1) * 10) / 10
  }
  if (!applied) computeMinDuration()
  await runCheckReveal()
}

/** 弹窗内【安全适配】 */
async function onAutoFit(): Promise<void> {
  await autoFitSafety()
  await runCheckReveal()
}

function togglePreview(): void {
  if (previewPlaying.value) {
    stopPreview()
    return
  }
  if (previewDuration.value <= 0) return
  if (previewT.value >= 1) previewT.value = 0
  previewPlaying.value = true
  previewLast = performance.now()
  const step = (ts: number) => {
    if (!previewPlaying.value) return
    const dt = (ts - previewLast) / 1000
    previewLast = ts
    previewT.value = Math.min(1, previewT.value + dt / previewDuration.value)
    showTransitionPreviewAt(form.id, previewT.value)
    if (previewT.value < 1) previewRaf = requestAnimationFrame(step)
    else previewPlaying.value = false
  }
  previewRaf = requestAnimationFrame(step)
}

function stopPreview(): void {
  previewPlaying.value = false
  if (previewRaf) cancelAnimationFrame(previewRaf)
  previewRaf = 0
}

/** 拖拽进度条：暂停并显示该进度 */
function onScrub(): void {
  stopPreview()
  showTransitionPreviewAt(form.id, previewT.value)
}

function onCancel(): void {
  stopPreview()
  showTransitionPreviewAt(form.id, -1)
  confirmOpen.value = false
}

/** 弹窗内【保存】= 现在的「保存修改」 */
async function onSave(): Promise<void> {
  if (phase.value !== 'done') return
  await onCommit()
  if (safety.value?.pass) {
    stopPreview()
    showTransitionPreviewAt(form.id, -1)
    confirmOpen.value = false
  }
}

/** 用户偏好类参数：套用风格预设时保留、不被重置 */
const PRESERVE_KEYS = [
  'speedMode',
  'unusedMode',
  'parkGap',
  'parkSpacing',
  'parkDim',
  'avoid',
  'minSeparation',
  'separationStrength',
  'separationIterations',
  'staggerOrder',
  'maxSpeedOverride',
  'maxAccelOverride',
  ...LIMIT_KEYS,
]

function applyPreset(p: Preset): void {
  if (p.algorithm) form.algorithm = p.algorithm
  if (p.path) form.path = p.path
  if (p.velocityProfile) form.velocityProfile = p.velocityProfile
  if (p.easing) form.easing = p.easing
  // 只重置“风格类”参数；保留用户偏好（到达方式/未使用/避让/上限等）
  const kept: Record<string, number> = {}
  for (const k of PRESERVE_KEYS) kept[k] = Number(form.params[k]) || 0
  form.params = { ...DEFAULT_PARAMS, ...p.params, ...kept }
  // 不改 form.duration / form.stagger：时长与错落完全由【节奏】控制
}

/** 重置为默认：等同“新建过渡”的初始状态（默认风格 + 默认时长/错落 + 缺省参数） */
function resetToDefault(): void {
  const fresh = createTransition(form.fromFrameId, form.toFrameId)
  form.path = fresh.path
  form.velocityProfile = fresh.velocityProfile
  form.easing = fresh.easing
  form.duration = fresh.duration
  form.stagger = fresh.stagger
  form.params = { ...DEFAULT_PARAMS }
  applyPreset(PRESETS[0])
}

function close(): void {
  // 关闭面板：同时收掉确认弹窗、清掉预览；保留内存产物（飞行轨迹仍显示）
  stopPreview()
  showTransitionPreviewAt(form.id, -1)
  confirmOpen.value = false
  emit('close')
}
</script>

<template>
  <aside class="drawer" :class="{ open }">
    <template v-if="open">
      <header class="head">
        <h3>{{ mode === 'new' ? '新增过渡' : '修改过渡' }}</h3>
        <div class="head-actions">
          <button class="link" :disabled="!stats" :title="stats ? '查看统计' : '生成产物后可查看统计'" @click="statsOpen = true">统计</button>
          <button class="ghost" @click="close">✕</button>
        </div>
      </header>

      <div class="scroll">
        <div class="modebar">
          <button :class="{ on: simple }" @click="simple = true">简单</button>
          <button :class="{ on: !simple }" @click="simple = false">高级</button>
          <button class="link reset" title="重置为默认（默认风格 + 默认时长/错落）" @click="resetToDefault">
            重置
          </button>
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
              <span>转场时长（秒）</span>
              <input v-model.number="form.duration" type="number" min="0.1" step="0.1" />
            </label>
            <label class="field">
              <span>出发错落（秒）</span>
              <input v-model.number="form.stagger" type="number" min="0" step="0.1" />
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
          <details class="section">
            <summary class="title" title="决定谁飞到哪个点：选择配对用的算法">
              求解器
            </summary>
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
            <label class="field" title="每个点只在最近的 K 个候选里配对（0=全局最优，越大越慢越准）">
              <span>候选近邻数 K（0=全部）{{ form.params.neighborLimit }}</span>
              <input v-model.number="form.params.neighborLimit" type="range" min="0" max="50" step="1" />
            </label>
            <label v-if="form.algorithm === 'auction'" class="field" title="拍卖算法的每次加价步长：越小越接近最优但越慢">
              <span>ε 投标增量 {{ form.params.epsilon }}</span>
              <input v-model.number="form.params.epsilon" type="range" min="0.005" max="0.5" step="0.005" />
            </label>
            <label v-if="form.algorithm === 'bottleneck'" class="field row" title="先让最长的那个配对尽量短，再在其基础上让总距离最短">
              <input v-model.number="form.params.secondaryMinTotal" type="checkbox" :true-value="1" :false-value="0" />
              <span>次级目标：最大得分最优后，总得分最短</span>
            </label>
          </details>

          <details class="section">
            <summary class="title" title="各项代价的加权：总分 = 各权重 × 对应代价 之和，权重越大越偏向该项">加权评分</summary>
            <div class="hint">
              配对时会计算"总分 = 各权重 × 对应代价"之和，再据此择优；权重越大越偏向该项（0 = 不启用该项）。
            </div>
            <label class="field" title="“移动距离”在总分里的比重：越大越倾向就近配对、总路程更短">
              <span>距离权重 {{ form.params.wDist }}（就近配对）</span>
              <input v-model.number="form.params.wDist" type="range" min="0" max="5" step="0.1" />
            </label>
            <label class="field" title="距离的幂次：p 越大越严厉惩罚长距离（结果更均衡）">
              <span>代价指数 p（dᵖ）{{ form.params.costPower }}（惩罚长距离）</span>
              <input v-model.number="form.params.costPower" type="range" min="1" max="4" step="0.25" />
            </label>
            <label class="field" title="让各架无人机的移动距离尽量相等（接近目标距离 d*）">
              <span>均匀度权重 {{ form.params.wEven }}（距离尽量相等）</span>
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
            <label class="field" title="让配对后的运动方向尽量一致，减少交叉">
              <span>方向一致权重 {{ form.params.wAngle }}（少交叉）</span>
              <input v-model.number="form.params.wAngle" type="range" min="0" max="2" step="0.05" />
            </label>
            <label class="field" title="同一分组的点尽量互相配对（保持分组不散）">
              <span>同组保持权重 {{ form.params.wGroup }}（同组互配）</span>
              <input v-model.number="form.params.wGroup" type="range" min="0" max="2" step="0.1" />
            </label>
            <label class="field" title="沿某个轴的先后顺序尽量保持不变（避免整体错位）">
              <span>保持顺序权重 {{ form.params.wOrder }}（先后不变）</span>
              <input v-model.number="form.params.wOrder" type="range" min="0" max="2" step="0.1" />
            </label>
            <label v-if="form.params.wOrder > 0" class="field" title="以哪个轴的坐标顺序作为“保持顺序”的排序依据">
              <span>顺序轴</span>
              <select v-model.number="form.params.rankAxis">
                <option :value="0">极角</option>
                <option :value="1">X</option>
                <option :value="2">Y</option>
              </select>
            </label>
            <label class="field" title="尽量保持到中心（质心）的距离不变（保持环形/圆形结构）">
              <span>保持半径权重 {{ form.params.wRadial }}（到中心距离不变）</span>
              <input v-model.number="form.params.wRadial" type="range" min="0" max="2" step="0.1" />
            </label>
            <label class="field" title="尽量保持绕中心的角度不变（保持旋转排布不扭转）">
              <span>保持极角权重 {{ form.params.wAngular }}（绕中心角度不变）</span>
              <input v-model.number="form.params.wAngular" type="range" min="0" max="2" step="0.05" />
            </label>
          </details>

          <details class="section">
            <summary class="title" title="无人机的空间走法：直线 / 弧线 / 贝塞尔曲线">路径</summary>
            <label class="field">
              <span>轨迹</span>
              <select v-model="form.path">
                <option value="linear">直线</option>
                <option value="arc">弧线</option>
                <option value="bezier">曲线（贝塞尔）</option>
              </select>
            </label>
            <label v-if="form.path !== 'linear'" class="field" title="弧线/曲线的弯曲程度（正负决定往哪边弯）">
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
          </details>

          <details class="section">
            <summary class="title" title="随时间变化的快慢：速度剖面决定速度曲线形状；时长决定整体快慢；错峰决定谁先出发">速度剖面与时间</summary>
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
            <label v-if="form.velocityProfile === 'trapezoid'" class="field" title="梯形速度曲线里加/减速段占比（其余为匀速段）">
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
            <label class="field" title="错峰总时长：越大出发越分散（0=同时出发）">
              <span>错峰总时长（秒）</span>
              <input v-model.number="form.stagger" type="number" min="0" step="0.1" />
            </label>
            <label v-if="form.stagger > 0" class="field" title="按什么顺序错峰出发">
              <span>错峰顺序</span>
              <select v-model.number="form.params.staggerOrder">
                <option :value="0">按序号</option>
                <option :value="1">按距离</option>
                <option :value="2">按分组</option>
                <option :value="3">随机</option>
              </select>
            </label>
          </details>

          <details class="section">
            <summary class="title" title="两帧数量不同的无人机：多余的一方如何处理">未使用无人机</summary>
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
          </details>

          <details class="section">
            <summary
              class="title"
              title="去冲突与安全底线：深度分层避让解决交叉；限值为硬约束，不满足不能保存（0=用系统默认）"
            >
              安全与避让
            </summary>
            <label class="field row" title="直线打底，仅沿深度轴给冲突机分层（不改正面画面）">
              <input v-model.number="form.params.avoid" type="checkbox" :true-value="1" :false-value="0" />
              <span>深度分层避让</span>
            </label>
            <div class="row">
              <label class="field">
                <span>最小间距（米）≥</span>
                <input v-model.number="form.params.limMinSeparation" type="number" min="0" step="0.1" />
              </label>
              <label class="field">
                <span>水平速度 ≤</span>
                <input v-model.number="form.params.limHSpeed" type="number" min="0" step="0.1" />
              </label>
            </div>
            <div class="row">
              <label class="field">
                <span>上升速度 ≤</span>
                <input v-model.number="form.params.limUpSpeed" type="number" min="0" step="0.1" />
              </label>
              <label class="field">
                <span>下降速度 ≤</span>
                <input v-model.number="form.params.limDownSpeed" type="number" min="0" step="0.1" />
              </label>
            </div>
            <div class="row">
              <label class="field">
                <span>水平加速度 ≤</span>
                <input v-model.number="form.params.limHAccel" type="number" min="0" step="0.1" />
              </label>
              <label class="field">
                <span>上升加速度 ≤</span>
                <input v-model.number="form.params.limUpAccel" type="number" min="0" step="0.1" />
              </label>
            </div>
            <div class="row">
              <label class="field">
                <span>下降加速度 ≤</span>
                <input v-model.number="form.params.limDownAccel" type="number" min="0" step="0.1" />
              </label>
            </div>
          </details>
        </template>
      </div>

      <footer class="foot">
        <button class="primary" :disabled="rendering || !canApply" @click="startConfirm">应用</button>
      </footer>
    </template>
  </aside>

  <div v-if="open && statsOpen" class="stats-overlay" @click.self="closeStats">
    <div class="stats-dialog">
      <header class="stats-head">
        <h3>过渡统计</h3>
        <button class="ghost" @click.stop="closeStats">✕</button>
      </header>
      <div class="stats-body">
        <template v-if="stats">
          <div class="stat-grid">
            <div class="card">
              <div class="k">点对</div>
              <div class="v">{{ stats.pairCount }}</div>
            </div>
            <div class="card">
              <div class="k">未用（退出 / 进入）</div>
              <div class="v">{{ stats.exitingCount }} / {{ stats.enteringCount }}</div>
            </div>
            <div class="card">
              <div class="k">段时长</div>
              <div class="v">{{ stats.duration.toFixed(1) }}<i>s</i></div>
            </div>
            <div class="card">
              <div class="k">总路程</div>
              <div class="v">{{ stats.totalDistance.toFixed(0) }}<i>m</i></div>
            </div>
            <div class="card wide">
              <div class="k">距离 最小 / 中位 / 最大</div>
              <div class="v">
                {{ stats.minDistance.toFixed(1) }} · {{ stats.medianDistance.toFixed(1) }} ·
                {{ stats.maxDistance.toFixed(1) }}<i>m</i>
              </div>
            </div>
            <div class="card wide">
              <div class="k">距离 均值 ± 标准差（CV）</div>
              <div class="v">
                {{ stats.meanDistance.toFixed(1) }} ± {{ stats.stdDistance.toFixed(1) }}
                <i>{{ (stats.cv * 100).toFixed(0) }}%</i>
              </div>
            </div>
            <div class="card" :class="{ over: speedOver }">
              <div class="k">峰值速度 / 上限</div>
              <div class="v">
                {{ stats.peakSpeed.toFixed(1) }} / {{ effMaxSpeed || '∞' }}<i>m/s</i>
              </div>
            </div>
            <div class="card" :class="{ over: accelOver }">
              <div class="k">峰值加速度 / 上限</div>
              <div class="v">
                {{ stats.peakAccel.toFixed(1) }} / {{ effMaxAccel || '∞' }}<i>m/s²</i>
              </div>
            </div>
            <div class="card">
              <div class="k">总得分 / 最大得分</div>
              <div class="v">{{ stats.totalScore.toFixed(1) }} / {{ stats.maxScore.toFixed(2) }}</div>
            </div>
            <div class="card">
              <div class="k">峰值 jerk</div>
              <div class="v">{{ stats.peakJerk.toFixed(1) }}</div>
            </div>
          </div>
          <StatCharts :stats="stats" :max-speed="effMaxSpeed" :max-accel="effMaxAccel" />
        </template>
        <div v-else class="hint">生成产物后显示统计</div>
      </div>
    </div>
  </div>

  <!-- 确认修改：右下角弹窗（不遮挡画布） -->
  <div v-if="open && confirmOpen" class="confirm-panel">
    <header class="cp-head">
      <h3>{{ mode === 'new' ? '新增过渡' : '修改过渡' }}</h3>
      <button class="ghost" @click="onCancel">✕</button>
    </header>
    <div class="cp-body">
      <div v-if="phase === 'computing' || phase === 'mindur'" class="cp-loading">
        <span class="spinner" />
        <span>{{ phase === 'mindur' ? '正在确认最短时长…' : '正在计算匹配与生成产物…' }}</span>
      </div>

      <template v-else>
        <ul class="cp-checks">
          <li
            v-for="(it, i) in safetyItems"
            :key="it.key"
            :class="{
              pending: i >= checkedCount,
              ok: i < checkedCount && it.pass,
              bad: i < checkedCount && !it.pass,
            }"
          >
            <span class="mark">{{ i < checkedCount ? (it.pass ? '✓' : '✗') : '' }}</span>
            <span class="lab">{{ it.label }}</span>
            <span v-if="i < checkedCount" class="val">
              {{ it.value.toFixed(2) }} / {{ it.limit }}{{ it.unit }}
            </span>
          </li>
        </ul>

        <div v-if="minDuration != null" class="cp-mindur">
          <template v-if="separationFailed">
            当前设置下，符合要求的最短时长为 {{ minDurationApprox ? '约 ' : '' }}<b>{{ minDuration }}</b> 秒（间距未达标，缩短时长无法解决，需开启避让）。
          </template>
          <template v-else>
            当前设置下，符合要求的最短时长为 {{ minDurationApprox ? '约 ' : '' }}<b>{{ minDuration }}</b> 秒。是否
            <button class="cp-link" @click="applyMinDuration">应用</button>？
          </template>
        </div>

        <div v-if="avoidInfo && phase === 'done'" class="cp-note">
          深度分层避让：{{ avoidInfo.colors }} 层（最大 ±{{ avoidInfo.maxDepth.toFixed(1) }}m）
        </div>

        <div v-if="phase === 'failed'" class="cp-fail">
          <span>安全检测未通过，无法保存</span>
          <button class="mini" @click="onAutoFit">安全适配</button>
        </div>

        <div v-if="phase === 'done'" class="cp-preview">
          <button class="mini" @click="togglePreview">{{ previewPlaying ? '⏸ 暂停' : '▶ 预览' }}</button>
          <input
            class="cp-range"
            type="range"
            min="0"
            max="1"
            step="0.002"
            v-model.number="previewT"
            @input="onScrub"
          />
          <span class="cp-time">{{ previewTimeLabel }}</span>
        </div>
      </template>
    </div>
    <footer class="cp-foot">
      <button @click="onCancel">取消</button>
      <button class="primary" :disabled="phase !== 'done'" @click="onSave">保存</button>
    </footer>
  </div>
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
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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
.modebar .reset {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: var(--text-dim);
  padding: 6px 2px;
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
summary.title {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
summary.title::-webkit-details-marker {
  display: none;
}
summary.title::before {
  content: '▸';
  color: var(--text-dim);
  font-size: 10px;
}
details[open] > summary.title::before {
  content: '▾';
}
details:not([open]) > summary.title {
  margin-bottom: 0;
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
.link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
  margin-bottom: 6px;
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
/* 统计弹窗：指标卡片网格 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.stat-grid .card {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  min-width: 0;
}
.stat-grid .card.wide {
  grid-column: span 2;
}
.stat-grid .card .k {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-grid .card .v {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.stat-grid .card .v i {
  font-style: normal;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-dim);
}
.stat-grid .card.over {
  border-color: var(--danger);
}
.stat-grid .card.over .v {
  color: var(--danger);
}
/* 统计弹窗（自带遮罩，独立于通用 Modal） */
.stats-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
}
.stats-dialog {
  width: 900px;
  max-width: 92vw;
  max-height: 90vh;
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
}
.stats-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.stats-head h3 {
  margin: 0;
  font-size: 15px;
}
.stats-body {
  padding: 16px;
}
.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 14px;
  border-top: 1px solid var(--border);
}
/* 确认修改：右下角弹窗 */
.confirm-panel {
  position: fixed;
  right: 12px;
  bottom: 12px;
  width: 340px;
  max-height: calc(100vh - 24px);
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  z-index: 260;
  overflow: hidden;
}
.cp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.cp-head h3 {
  margin: 0;
  font-size: 13px;
}
.cp-body {
  padding: 12px;
  overflow: auto;
}
.cp-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: cp-spin 0.8s linear infinite;
}
@keyframes cp-spin {
  to {
    transform: rotate(360deg);
  }
}
.cp-checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cp-checks li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.cp-checks li .mark {
  width: 14px;
  text-align: center;
  font-weight: 700;
}
.cp-checks li .lab {
  flex: 0 0 68px;
}
.cp-checks li .val {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.cp-checks li.ok .mark {
  color: var(--success);
}
.cp-checks li.ok .val {
  color: var(--text);
}
.cp-checks li.bad .mark,
.cp-checks li.bad .val {
  color: var(--danger);
}
.cp-note {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.cp-mindur {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(54, 198, 255, 0.08);
  border: 1px solid rgba(54, 198, 255, 0.25);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
}
.cp-mindur b {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.cp-link {
  background: transparent;
  border: none;
  padding: 0;
  color: var(--accent);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.cp-fail {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--danger);
}
.cp-preview {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.cp-range {
  flex: 1;
  min-width: 0;
}
.cp-time {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.cp-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
}
</style>
