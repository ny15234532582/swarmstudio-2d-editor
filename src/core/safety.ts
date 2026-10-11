/**
 * 安全检测：对一份「过渡产物」在过渡段内按 30fps 采样，
 * 逐架数值微分求速度/加速度分量，并用网格求全 3D 最小间距，最后与固定限值比较。
 *
 * 轴约定：竖直 = 高度（画布 y 向下为正 ⇒ 高度 = -y，上升 = y 减小），水平 = 画布 x（深度 z=0）。
 * 单位：长度=坐标单位（米），时间=秒。
 */
import { sampleRenderSegment, type MotionSample, type RenderPayload } from './transition'

export interface SafetyLimits {
  minSeparation: number
  hSpeed: number
  upSpeed: number
  downSpeed: number
  hAccel: number
  upAccel: number
  downAccel: number
}

/** 固定限值（不可改） */
export const SAFETY_LIMITS: SafetyLimits = {
  minSeparation: 1.5,
  hSpeed: 4.5,
  upSpeed: 3.5,
  downSpeed: 3.0,
  hAccel: 4.5,
  upAccel: 4.0,
  downAccel: 3.5,
}

export type SafetyMetricKey = keyof SafetyLimits

export interface SafetyResult {
  /** 7 项统计峰值 */
  metrics: SafetyLimits
  /** 是否全部不超限 */
  pass: boolean
  /** 超限的项 */
  failures: SafetyMetricKey[]
  /** 采样帧数 */
  frames: number
}

const METRIC_KEYS: SafetyMetricKey[] = [
  'minSeparation',
  'hSpeed',
  'upSpeed',
  'downSpeed',
  'hAccel',
  'upAccel',
  'downAccel',
]
/** 最小间距是“下限”，其余是“上限” */
const isLowerBound = (k: SafetyMetricKey) => k === 'minSeparation'

/**
 * 执行安全检测。流式处理（只保留 3 个时间片），内存 O(n)。
 * @param fps 采样帧率（默认 30）
 */
export function safetyCheck(
  render: RenderPayload,
  limits: SafetyLimits = SAFETY_LIMITS,
  fps = 30,
): SafetyResult {
  const duration = Math.max(0.0001, render.duration + render.stagger)
  const n = render.pairs.length + render.exiting.length + render.entering.length
  // 采样上限：点数越多，帧率自动降低，避免 3000×30fps×100s ≈ 9e6 样本过重
  const MAX_SAMPLES = 3_000_000
  const steps = Math.max(
    2,
    Math.min(Math.ceil(duration * fps), Math.floor(MAX_SAMPLES / Math.max(1, n))),
  )
  const dt = duration / steps

  const m: SafetyLimits = {
    minSeparation: Infinity,
    hSpeed: 0,
    upSpeed: 0,
    downSpeed: 0,
    hAccel: 0,
    upAccel: 0,
    downAccel: 0,
  }

  let p0: MotionSample[] | null = null
  let p1: MotionSample[] | null = null
  for (let i = 0; i <= steps; i++) {
    const cur = sampleRenderSegment(render, i / steps)
    // 最小间距（全 3D；z=0 ⇒ 用 x,y）
    const sep = minSeparation(cur, limits.minSeparation)
    if (sep < m.minSeparation) m.minSeparation = sep
    // 速度（后向差分）：i>=1；水平 = (x, 深度z)，竖直 = 高度(=-y)
    if (i >= 1 && p1) {
      for (let k = 0; k < cur.length; k++) {
        const vx = (cur[k].x - p1[k].x) / dt
        const vz = ((cur[k].z ?? 0) - (p1[k].z ?? 0)) / dt
        // 画布 y 向下为正 ⇒ 高度上升 = y 减小
        const climb = -(cur[k].y - p1[k].y) / dt
        const h = Math.hypot(vx, vz)
        if (h > m.hSpeed) m.hSpeed = h
        if (climb > m.upSpeed) m.upSpeed = climb
        if (-climb > m.downSpeed) m.downSpeed = -climb
      }
    }
    // 加速度（二阶差分）：i>=2
    if (i >= 2 && p1 && p0) {
      for (let k = 0; k < cur.length; k++) {
        const ax = (cur[k].x - 2 * p1[k].x + p0[k].x) / (dt * dt)
        const az = ((cur[k].z ?? 0) - 2 * (p1[k].z ?? 0) + (p0[k].z ?? 0)) / (dt * dt)
        const aClimb = -(cur[k].y - 2 * p1[k].y + p0[k].y) / (dt * dt)
        const h = Math.hypot(ax, az)
        if (h > m.hAccel) m.hAccel = h
        if (aClimb > m.upAccel) m.upAccel = aClimb
        if (-aClimb > m.downAccel) m.downAccel = -aClimb
      }
    }
    p0 = p1
    p1 = cur
  }
  if (!Number.isFinite(m.minSeparation)) m.minSeparation = 0

  const failures = METRIC_KEYS.filter((k) =>
    isLowerBound(k) ? m[k] < limits[k] - 1e-9 : m[k] > limits[k] + 1e-9,
  )
  return { metrics: m, pass: failures.length === 0, failures, frames: steps + 1 }
}

/** 网格求当前帧中所有点的最小两两距离（全 3D，含阈值剪枝） */
function minSeparation(samples: MotionSample[], threshold: number): number {
  const n = samples.length
  if (n < 2) return Infinity
  const cell = Math.max(1e-6, threshold)
  const key = (cx: number, cy: number, cz: number) =>
    ((cx & 0x3ff) * 1024 + (cy & 0x3ff)) * 1024 + (cz & 0x3ff)
  const grid = new Map<number, number[]>()
  const cxOf = (i: number) => Math.floor(samples[i].x / cell)
  const cyOf = (i: number) => Math.floor(samples[i].y / cell)
  const czOf = (i: number) => Math.floor((samples[i].z ?? 0) / cell)
  for (let i = 0; i < n; i++) {
    const k = key(cxOf(i), cyOf(i), czOf(i))
    const list = grid.get(k)
    if (list) list.push(i)
    else grid.set(k, [i])
  }
  let best = Infinity
  for (let i = 0; i < n; i++) {
    const cx = cxOf(i)
    const cy = cyOf(i)
    const cz = czOf(i)
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const bucket = grid.get(key(gx, gy, gz))
          if (!bucket) continue
          for (const j of bucket) {
            if (j <= i) continue
            const dx = samples[j].x - samples[i].x
            const dy = samples[j].y - samples[i].y
            const dz = (samples[j].z ?? 0) - (samples[i].z ?? 0)
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
            if (d < best) best = d
          }
        }
      }
    }
  }
  return best
}

/**
 * 由当前峰值反推「满足速度/加速度限值」的最小过渡时长（秒）。
 * 速度 ∝ 1/T，加速度 ∝ 1/T²；取各上限项所需 T 的最大值。
 */
export function minDurationForLimits(m: SafetyLimits, limits: SafetyLimits, duration: number): number {
  let factor = 1
  const need = (peak: number, limit: number, squared: boolean) => {
    if (limit <= 0 || peak <= 0) return
    const f = squared ? Math.sqrt(peak / limit) : peak / limit
    if (f > factor) factor = f
  }
  need(m.hSpeed, limits.hSpeed, false)
  need(m.upSpeed, limits.upSpeed, false)
  need(m.downSpeed, limits.downSpeed, false)
  need(m.hAccel, limits.hAccel, true)
  need(m.upAccel, limits.upAccel, true)
  need(m.downAccel, limits.downAccel, true)
  return duration * factor
}
