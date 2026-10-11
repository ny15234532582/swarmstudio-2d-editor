import { describe, expect, it } from 'vitest'
import { buildRender, planAvoidance, sampleRenderSegment } from '../src/core/transition'
import { SAFETY_LIMITS, minDurationForLimits, safetyCheck } from '../src/core/safety'
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
})
