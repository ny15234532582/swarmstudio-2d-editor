import { describe, expect, it } from 'vitest'
import { buildRender, planAvoidance, sampleRenderSegment } from '../src/core/transition'
import {
  SAFETY_LIMITS,
  mergeSafety,
  minDurationForLimits,
  safetyCheck,
  safetyCheckRange,
  safetySteps,
  shortestDurationForLimits,
} from '../src/core/safety'
import type { Point, Transition } from '../src/core/types'

function pt(id: string, x: number, y: number, f = 'f1'): Point {
  return { id, frameId: f, x, y, z: 0, r: 0, g: 0, b: 0 }
}
function tr(extra: Partial<Transition> = {}): Transition {
  return {
    id: 't',
    fromFrameId: 'f1',
    toFrameId: 'f2',
    duration: 2,
    algorithm: 'index',
    path: 'linear',
    velocityProfile: 'linear',
    easing: 'linear',
    stagger: 0,
    params: {},
    ...extra,
  }
}

describe('安全检测', () => {
  it('水平速度峰值 = 距离/时长；超限判失败', () => {
    const a = [pt('a0', 0, 0)]
    const b = [pt('b0', 10, 0, 'f2')]
    const t = tr({ duration: 2 })
    const render = buildRender(a, b, t, { pairs: [[0, 0]], exiting: [], entering: [], elapsedMs: 1 })
    const r = safetyCheck(render, SAFETY_LIMITS, 30)
    expect(r.metrics.hSpeed).toBeCloseTo(5, 1) // 10 / 2
    expect(r.pass).toBe(false) // 5 > 4.5
    expect(r.failures).toContain('hSpeed')
  })

  it('最小时长反解后不再超限', () => {
    const a = [pt('a0', 0, 0)]
    const b = [pt('b0', 10, 0, 'f2')]
    const render = buildRender(a, b, tr({ duration: 2 }), {
      pairs: [[0, 0]],
      exiting: [],
      entering: [],
      elapsedMs: 1,
    })
    const r = safetyCheck(render, SAFETY_LIMITS, 30)
    const needed = minDurationForLimits(r.metrics, SAFETY_LIMITS, 2)
    expect(needed).toBeGreaterThan(2)
    const render2 = buildRender(a, b, tr({ duration: needed }), {
      pairs: [[0, 0]],
      exiting: [],
      entering: [],
      elapsedMs: 1,
    })
    const r2 = safetyCheck(render2, SAFETY_LIMITS, 30)
    expect(r2.metrics.hSpeed).toBeLessThanOrEqual(SAFETY_LIMITS.hSpeed + 1e-6)
  })

  it('最小间距过近判失败', () => {
    const a = [pt('a0', 0, 0), pt('a1', 0, 0.5)]
    const b = [pt('b0', 0, 0, 'f2'), pt('b1', 0, 0.5, 'f2')]
    const render = buildRender(a, b, tr(), {
      pairs: [
        [0, 0],
        [1, 1],
      ],
      exiting: [],
      entering: [],
      elapsedMs: 1,
    })
    const r = safetyCheck(render, SAFETY_LIMITS, 30)
    expect(r.metrics.minSeparation).toBeLessThan(SAFETY_LIMITS.minSeparation)
    expect(r.failures).toContain('minSeparation')
  })

  it('轨迹规划：直线交叉的两架被 3D 绕行分开', () => {
    const a = [pt('a0', 0, 0), pt('a1', 10, 0)]
    const b = [pt('b0', 10, 0, 'f2'), pt('b1', 0, 0, 'f2')]
    const t = tr()
    const pairs: [number, number][] = [
      [0, 0],
      [1, 1],
    ]
    const avoid = planAvoidance(a, b, pairs, t, SAFETY_LIMITS.minSeparation)
    const render = buildRender(a, b, t, { pairs, exiting: [], entering: [], elapsedMs: 0, avoid })
    let worst = Infinity
    for (let k = 0; k <= 40; k++) {
      const s = sampleRenderSegment(render, k / 40)
      for (let i = 0; i < s.length; i++) {
        for (let j = i + 1; j < s.length; j++) {
          const dz = (s[i].z ?? 0) - (s[j].z ?? 0)
          worst = Math.min(worst, Math.hypot(s[i].x - s[j].x, s[i].y - s[j].y, dz))
        }
      }
    }
    expect(worst).toBeGreaterThan(1.2)
  })

  it('分块并行安全检测与单次全量逐位一致（多种块数）', () => {
    const a: Point[] = []
    const b: Point[] = []
    const pairs: [number, number][] = []
    for (let k = 0; k < 8; k++) {
      a.push(pt(`a${k}`, (k % 4) * 3, Math.floor(k / 4) * 3))
      b.push(pt(`b${k}`, 12 - (k % 4) * 3, Math.floor(k / 4) * 3, 'f2'))
      pairs.push([k, k])
    }
    const t = tr({ duration: 1.5 })
    const avoid = planAvoidance(a, b, pairs, t, SAFETY_LIMITS.minSeparation)
    const render = buildRender(a, b, t, { pairs, exiting: [], entering: [], elapsedMs: 0, avoid })
    const single = safetyCheck(render, SAFETY_LIMITS, 30)
    const steps = safetySteps(render, 30)
    const frames = steps + 1
    for (const K of [1, 2, 3, 4, 7, 16, 64]) {
      const parts = []
      for (let c = 0; c < K; c++) {
        const lo = Math.floor((c * frames) / K)
        const hi = Math.floor(((c + 1) * frames) / K) - 1
        if (hi < lo) continue
        parts.push(safetyCheckRange(render, SAFETY_LIMITS, 30, lo, hi))
      }
      const merged = mergeSafety(parts, SAFETY_LIMITS, steps)
      expect(merged.metrics).toEqual(single.metrics)
      expect(merged.pass).toBe(single.pass)
      expect(merged.failures).toEqual(single.failures)
      expect(merged.frames).toBe(single.frames)
    }
  })
})

describe('shortestDurationForLimits', () => {
  const zero = {
    minSeparation: Infinity,
    hSpeed: 0,
    upSpeed: 0,
    downSpeed: 0,
    hAccel: 0,
    upAccel: 0,
    downAccel: 0,
  }

  it('速度受限：T_min = T·peak/limit（可小于当前时长）', () => {
    const m = { ...zero, hSpeed: 4.4 }
    // 90 × 4.4/4.5 = 88
    expect(shortestDurationForLimits(m, SAFETY_LIMITS, 90)).toBeCloseTo(88, 5)
  })

  it('加速度受限：T_min = T·√(peak/limit)', () => {
    const m = { ...zero, hAccel: 18 } // 18 = 4.5 × 4 → √4 = 2
    expect(shortestDurationForLimits(m, SAFETY_LIMITS, 90)).toBeCloseTo(180, 5)
  })

  it('结果与当前时长选择无关（峰值按 1/T 缩放）', () => {
    const p80 = 2.0 // 80s 时的峰值速度
    const m80 = { ...zero, hSpeed: p80 }
    const m100 = { ...zero, hSpeed: p80 * (80 / 100) } // 100s 时峰值 = p80 × 80/100
    const a = shortestDurationForLimits(m80, SAFETY_LIMITS, 80)
    const b = shortestDurationForLimits(m100, SAFETY_LIMITS, 100)
    expect(a).toBeCloseTo(b, 5)
    expect(a).toBeCloseTo((80 * p80) / SAFETY_LIMITS.hSpeed, 5)
  })

  it('无运动（峰值全 0）→ 返回当前时长', () => {
    expect(shortestDurationForLimits(zero, SAFETY_LIMITS, 90)).toBe(90)
  })
})
