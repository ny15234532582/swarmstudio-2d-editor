import { describe, expect, it } from 'vitest'
import {
  buildRender,
  buildTimeline,
  ease,
  minJerk,
  planTransition,
  profileProgress,
  renderSignature,
  sampleFrameAt,
  samplePlan,
  sampleRenderSegment,
  segmentAt,
  trailsFromRender,
  transitionStats,
} from '../src/core/transition'
import { createTrack } from '../src/core/factory'
import type { Frame, Point, Transition } from '../src/core/types'

function pt(id: string, x: number, y: number, frameId = 'f1'): Point {
  return { id, x, y, z: 0, r: 0, g: 0, b: 0, frameId }
}

function frame(id: string, duration: number): Frame {
  return { id, name: id, thumbnail: '', width: 0, height: 0, duration }
}

/** 构造一个只关心匹配/剖面的过渡对象 */
function trans(algorithm: Transition['algorithm'], extra: Partial<Transition> = {}): Transition {
  return {
    id: 't',
    fromFrameId: 'f1',
    toFrameId: 'f2',
    duration: 2,
    algorithm,
    path: 'linear',
    velocityProfile: 'linear',
    easing: 'linear',
    stagger: 0,
    params: {},
    ...extra,
  }
}

describe('transition 引擎', () => {
  it('缓动端点正确', () => {
    for (const k of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(ease(0, k)).toBeCloseTo(0, 6)
      expect(ease(1, k)).toBeCloseTo(1, 6)
    }
  })

  it('速度剖面端点均为 0→1', () => {
    for (const p of ['linear', 'ease', 'trapezoid', 'minJerk'] as const) {
      expect(profileProgress(p, 'easeInOut', 0, { accelRatio: 0.25 })).toBeCloseTo(0, 6)
      expect(profileProgress(p, 'easeInOut', 1, { accelRatio: 0.25 })).toBeCloseTo(1, 6)
    }
    // 最小 jerk 五次多项式在 0.5 处为 0.5
    expect(minJerk(0.5)).toBeCloseTo(0.5, 6)
  })

  it('index 匹配按序号配对', () => {
    const a = [pt('a0', 0, 0), pt('a1', 1, 0)]
    const b = [pt('b0', 0, 0, 'f2'), pt('b1', 1, 0, 'f2')]
    const plan = planTransition(a, b, trans('index'))
    expect(plan.pairs).toHaveLength(2)
    expect(plan.pairs[0].from.id).toBe('a0')
    expect(plan.pairs[0].to.id).toBe('b0')
  })

  it('nearest 匹配交叉的点（避免走对角）', () => {
    const a = [pt('a0', -1, 0), pt('a1', 1, 0)]
    const b = [pt('b0', 1, 0, 'f2'), pt('b1', -1, 0, 'f2')]
    const map = new Map(planTransition(a, b, trans('nearest')).pairs.map((p) => [p.from.id, p.to.id]))
    expect(map.get('a0')).toBe('b1')
    expect(map.get('a1')).toBe('b0')
  })

  it('hungarian 最小总距离（避免交叉）', () => {
    const a = [pt('a0', 0, 0), pt('a1', 10, 0)]
    const b = [pt('b0', 11, 0, 'f2'), pt('b1', 1, 0, 'f2')]
    const plan = planTransition(a, b, trans('hungarian'))
    const map = new Map(plan.pairs.map((p) => [p.from.id, p.to.id]))
    expect(map.get('a0')).toBe('b1')
    expect(map.get('a1')).toBe('b0')
  })

  it('auction 也给出无交叉匹配', () => {
    const a = [pt('a0', 0, 0), pt('a1', 10, 0)]
    const b = [pt('b0', 11, 0, 'f2'), pt('b1', 1, 0, 'f2')]
    const plan = planTransition(a, b, trans('auction', { params: { epsilon: 0.01 } }))
    const map = new Map(plan.pairs.map((p) => [p.from.id, p.to.id]))
    expect(map.get('a0')).toBe('b1')
    expect(map.get('a1')).toBe('b0')
    expect(plan.pairs).toHaveLength(2)
  })

  it('数量不等时多出的点淡出/淡入', () => {
    const a = [pt('a0', 0, 0), pt('a1', 1, 0)]
    const b = [pt('b0', 0, 0, 'f2')]
    const plan = planTransition(a, b, trans('index'))
    expect(plan.pairs).toHaveLength(1)
    expect(plan.exiting.map((p) => p.id)).toEqual(['a1'])
  })

  it('直线过渡中点等于两点平均', () => {
    const a = [pt('a0', 0, 0)]
    const b = [pt('b0', 10, 20, 'f2')]
    const t = trans('index', { path: 'linear', velocityProfile: 'linear' })
    const mid = samplePlan(planTransition(a, b, t), t, 0.5)
    expect(mid[0].x).toBeCloseTo(5, 5)
    expect(mid[0].y).toBeCloseTo(10, 5)
    expect(mid[0].alpha).toBeCloseTo(1, 5)
  })

  it('错峰：后面的点出发更晚', () => {
    const a = [pt('a0', 0, 0), pt('a1', 0, 0)]
    const b = [pt('b0', 10, 0, 'f2'), pt('b1', 10, 0, 'f2')]
    const t = trans('index', { velocityProfile: 'linear', duration: 2, stagger: 2 })
    const plan = planTransition(a, b, t)
    // 段总长 = duration + stagger = 4；t=0.75 → elapsed=3
    const s = samplePlan(plan, t, 0.75)
    expect(s[0].x).toBeCloseTo(10, 5) // 第一个点延迟 0，3s>2s 已到
    expect(s[1].x).toBeCloseTo(5, 5) // 第二个点延迟 2s，已飞 1s（半程）
  })

  it('时间线过渡段长度包含错峰', () => {
    const track = createTrack()
    track.clips = [frame('f1', 3), frame('f2', 2)]
    track.transitions = [trans('nearest', { id: 'tr', fromFrameId: 'f1', toFrameId: 'f2', duration: 2, stagger: 1 })]
    const { duration, segments } = buildTimeline(track)
    expect(duration).toBe(3 + 3 + 2) // 3 + (2+1) + 2
    expect(segments.map((s) => s.kind)).toEqual(['hold', 'transition', 'hold'])
    expect(segmentAt(segments, 4)?.kind).toBe('transition')
  })

  it('统计：峰值速度随距离/时长变化且大于平均速度', () => {
    const a = [pt('a0', 0, 0)]
    const b = [pt('b0', 100, 0, 'f2')]
    const t = trans('index', { velocityProfile: 'minJerk', duration: 2 })
    const stats = transitionStats(planTransition(a, b, t), t)
    expect(stats.maxDistance).toBeCloseTo(100, 5)
    // 最小 jerk 峰值速度系数 1.875 → 1.875*100/2 = 93.75
    expect(stats.peakSpeed).toBeCloseTo(93.75, 0)
    expect(stats.peakAccel).toBeGreaterThan(0)
  })

  it('sampleFrameAt 在停留段返回该帧原始点位', () => {
    const track = createTrack()
    track.clips = [frame('f1', 3)]
    const points = new Map<string, Point[]>([['f1', [pt('a0', 1, 2)]]])
    const out = sampleFrameAt(track, points, 1)
    expect(out).toHaveLength(1)
    expect(out[0].x).toBe(1)
    expect(out[0].alpha).toBe(1)
  })

  it('bottleneck 完成完美匹配，且最大距离不大于匈牙利', () => {
    const a = [pt('a0', 0, 0), pt('a1', 5, 0), pt('a2', 10, 0)]
    const b = [pt('b0', 3, 0, 'f2'), pt('b1', 6, 0, 'f2'), pt('b2', 100, 0, 'f2')]
    const bn = planTransition(a, b, trans('bottleneck'))
    const hu = planTransition(a, b, trans('hungarian'))
    expect(bn.pairs).toHaveLength(3)
    const maxOf = (plan: ReturnType<typeof planTransition>) =>
      Math.max(...plan.pairs.map((p) => Math.hypot(p.from.x - p.to.x, p.from.y - p.to.y)))
    expect(maxOf(bn)).toBeLessThanOrEqual(maxOf(hu) + 1e-9)
  })

  it('等速模式：近的点先到、远点后到（各点速度一致）', () => {
    const a = [pt('a0', 0, 0), pt('a1', 0, 0)]
    const b = [pt('b0', 100, 0, 'f2'), pt('b1', 10, 0, 'f2')]
    const t = trans('index', { velocityProfile: 'linear', duration: 10, params: { speedMode: 1 } })
    const plan = planTransition(a, b, t)
    // t=0.2 → elapsed=2s：近点(10/100*10=1s)已完成；远点(10s)才 20%
    const s = samplePlan(plan, t, 0.2)
    expect(s[0].x).toBeCloseTo(20, 5) // 远点
    expect(s[1].x).toBeCloseTo(10, 5) // 近点已到
  })

  it('最小间距斥力：过近的点被推开', () => {
    const a = [pt('a0', 0, 0), pt('a1', 0.1, 0)]
    const b = [pt('b0', 0, 0, 'f2'), pt('b1', 0.1, 0, 'f2')]
    const t = trans('index', {
      velocityProfile: 'linear',
      params: { minSeparation: 10, separationStrength: 1 },
    })
    const s = samplePlan(planTransition(a, b, t), t, 0.5)
    const d = Math.hypot(s[0].x - s[1].x, s[0].y - s[1].y)
    expect(d).toBeGreaterThan(0.1)
  })

  it('贝塞尔路径偏离直线', () => {
    const a = [pt('a0', 0, 0)]
    const b = [pt('b0', 10, 0, 'f2')]
    const t = trans('index', { path: 'bezier', velocityProfile: 'linear', params: { curvature: 0.3 } })
    const s = samplePlan(planTransition(a, b, t), t, 0.5)
    expect(Math.abs(s[0].y)).toBeGreaterThan(0.1)
  })

  it('代价指数 p 生效且仍完成匹配', () => {
    const a = [pt('a0', 0, 0), pt('a1', 10, 0)]
    const b = [pt('b0', 1, 0, 'f2'), pt('b1', 11, 0, 'f2')]
    const plan = planTransition(a, b, trans('hungarian', { params: { costPower: 2 } }))
    expect(plan.pairs).toHaveLength(2)
  })

  it('候选近邻 K：并集候选，不孤立目标点（不会直接出现在终点）', () => {
    const a = [pt('a0', 0, 0), pt('a1', 10, 0), pt('a2', 20, 0)]
    const b = [pt('b0', 0, 0, 'f2'), pt('b1', 10, 0, 'f2'), pt('b2', 100, 0, 'f2')]
    for (const algo of ['bottleneck', 'hungarian', 'nearest'] as const) {
      const plan = planTransition(a, b, trans(algo, { params: { neighborLimit: 1 } }))
      expect(plan.pairs).toHaveLength(3)
      expect(plan.entering).toHaveLength(0)
      expect(plan.exiting).toHaveLength(0)
    }
  })

  it('均匀度项 wEven：最小化「偏离目标距离」，优于纯总距离', () => {
    const a = [pt('a0', 0, 0), pt('a1', 5, 0), pt('a2', 10, 0)]
    const b = [pt('b0', 1, 0, 'f2'), pt('b1', 6, 0, 'f2'), pt('b2', 100, 0, 'f2')]
    const t = 20
    const total = planTransition(a, b, trans('hungarian', { params: { wDist: 1, wEven: 0 } }))
    const even = planTransition(a, b, trans('hungarian', { params: { wDist: 0, wEven: 1, targetDistance: t } }))
    const dev = (plan: ReturnType<typeof planTransition>) =>
      plan.pairs.reduce((s, p) => s + Math.abs(Math.hypot(p.from.x - p.to.x, p.from.y - p.to.y) - t), 0)
    expect(dev(even)).toBeLessThanOrEqual(dev(total) + 1e-6)
  })

  it('顺序项 wOrder：保持相对顺序（按 x 轴名次配对）', () => {
    const a = [pt('a0', 0, 0), pt('a1', 10, 0), pt('a2', 20, 0)]
    const b = [pt('b0', 20, 0, 'f2'), pt('b1', 10, 0, 'f2'), pt('b2', 0, 0, 'f2')]
    const plan = planTransition(a, b, trans('hungarian', { params: { wDist: 0, wOrder: 1, rankAxis: 1 } }))
    const map = new Map(plan.pairs.map((p) => [p.from.id, p.to.id]))
    expect(map.get('a0')).toBe('b2')
    expect(map.get('a1')).toBe('b1')
    expect(map.get('a2')).toBe('b0')
  })

  it('统计包含加权得分与分项贡献', () => {
    const a = [pt('a0', 0, 0), pt('a1', 10, 0)]
    const b = [pt('b0', 5, 0, 'f2'), pt('b1', 15, 0, 'f2')]
    const tr = trans('hungarian', { params: { wDist: 1, wAngle: 0.5 } })
    const stats = transitionStats(planTransition(a, b, tr), tr)
    expect(stats.totalScore).toBeGreaterThan(0)
    expect(stats.scoreByTerm).toHaveLength(7)
  })

  it('产物：签名稳定、随坐标变化', () => {
    const a = [pt('a0', 0, 0), pt('a1', 1, 0)]
    const b = [pt('b0', 0, 0, 'f2'), pt('b1', 1, 0, 'f2')]
    const t = trans('index')
    const s1 = renderSignature('f1', 'f2', a, b, t)
    expect(renderSignature('f1', 'f2', a, b, t)).toBe(s1)
    const moved = [pt('a0', 0, 0), pt('a1', 2, 0)]
    expect(renderSignature('f1', 'f2', moved, b, t)).not.toBe(s1)
    // 不影响匹配的参数变化不应改签名
    const t2 = trans('index', { velocityProfile: 'minJerk', duration: 5, params: { curvature: 0.9 } })
    expect(renderSignature('f1', 'f2', a, b, t2)).toBe(s1)
  })

  it('产物：buildRender + sampleRenderSegment 可直接播放', () => {
    const a = [pt('a0', 0, 0)]
    const b = [pt('b0', 10, 20, 'f2')]
    const t = trans('index', { velocityProfile: 'linear', path: 'linear' })
    const render = buildRender(a, b, t, { pairs: [[0, 0]], exiting: [], entering: [], elapsedMs: 1 })
    const mid = sampleRenderSegment(render, 0.5)
    expect(mid[0].x).toBeCloseTo(5, 5)
    expect(mid[0].y).toBeCloseTo(10, 5)
    expect(render.stats.pairCount).toBe(1)
    expect(trailsFromRender(render, 4)).toHaveLength(1)
  })

  it('未使用无人机：默认飞往阵型下方的待命区（不再原地淡出）', () => {
    const a = [pt('a0', 0, 0), pt('a1', 10, 0)] // a1 只在 A
    const b = [pt('b0', 0, 0, 'f2')] // a0 匹配 b0
    const t = trans('index', { velocityProfile: 'linear', params: { unusedMode: 0, parkDim: 0.25 } })
    const plan = planTransition(a, b, t)
    // t=1：退出点 a1 应飞到待命区（+Y 下方），并暗显
    const s1 = samplePlan(plan, t, 1)
    const parked = s1.find((s) => s.alpha > 0 && s.alpha < 0.5)
    expect(parked).toBeTruthy()
    expect(parked!.y).toBeGreaterThan(0)
  })

  it('未使用无人机：只在目标帧的点从待命区飞入', () => {
    const a = [pt('a0', 0, 0)]
    const b = [pt('b0', 0, 0, 'f2'), pt('b1', 10, 0, 'f2')] // b1 只在 B
    const t = trans('index', { velocityProfile: 'linear', params: { unusedMode: 0, parkDim: 0.25 } })
    const plan = planTransition(a, b, t)
    // t=0：进入点在待命区、暗显
    const s0 = samplePlan(plan, t, 0)
    const waiting = s0.find((s) => s.alpha > 0 && s.alpha < 0.5)
    expect(waiting).toBeTruthy()
    expect(waiting!.y).toBeGreaterThan(0)
    // t=1：进入点到达 b1，全部不透明
    const arrived = samplePlan(plan, t, 1).filter((s) => s.alpha > 0.9)
    expect(arrived.length).toBe(2)
  })
})
