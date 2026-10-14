/**
 * 过渡产物 Worker：两种任务
 *  - plan：只做最贵的「匹配」（planTransition），返回下标分配；
 *  - safety：对一份产物做安全检测（30fps 采样 + 数值微分 + 最小间距）。
 * 都放这里，避免主线程卡顿。
 */
import { planAvoidance, planTransition, type RenderAssignment } from '../core/transition'
import {
  safetyCheck,
  safetyCheckRange,
  type SafetyLimits,
  type SafetyResult,
} from '../core/safety'
import type { Point, Transition } from '../core/types'
import type { RenderPayload } from '../core/transition'

interface WorkerScope {
  postMessage(message: unknown): void
  onmessage: ((event: MessageEvent) => void) | null
}

const scope = self as unknown as WorkerScope

interface PlanRequest {
  id: number
  kind: 'plan'
  a: Point[]
  b: Point[]
  transition: Transition
  /** >0 时做分层深度避让（沿深度轴给冲突机分层） */
  minSep: number
}
interface SafetyRequest {
  id: number
  kind: 'safety'
  render: RenderPayload
  limits: SafetyLimits
  fps: number
}
/** 安全检测分块：只算采样帧区间 [lo, hi]（含两端），归约由主线程完成 */
interface SafetyPartRequest {
  id: number
  kind: 'safetyPart'
  render: RenderPayload
  limits: SafetyLimits
  fps: number
  lo: number
  hi: number
}
type Req = PlanRequest | SafetyRequest | SafetyPartRequest

scope.onmessage = (event: MessageEvent) => {
  const req = event.data as Req
  try {
    if (req.kind === 'safetyPart') {
      const result: SafetyLimits = safetyCheckRange(req.render, req.limits, req.fps, req.lo, req.hi)
      scope.postMessage({ id: req.id, ok: true, result })
      return
    }
    if (req.kind === 'safety') {
      const result: SafetyResult = safetyCheck(req.render, req.limits, req.fps)
      scope.postMessage({ id: req.id, ok: true, result })
      return
    }
    const { a, b, transition, minSep } = req
    const t0 = performance.now()
    const plan = planTransition(a, b, transition)
    const ia = new Map<string, number>()
    a.forEach((p, i) => ia.set(p.id, i))
    const ib = new Map<string, number>()
    b.forEach((p, j) => ib.set(p.id, j))
    const pairs: [number, number][] = []
    for (const { from, to } of plan.pairs) {
      const i = ia.get(from.id)
      const j = ib.get(to.id)
      if (i !== undefined && j !== undefined) pairs.push([i, j])
    }
    const exiting = plan.exiting.map((p) => ia.get(p.id)).filter((i): i is number => i !== undefined)
    const entering = plan.entering.map((p) => ib.get(p.id)).filter((j): j is number => j !== undefined)
    // 轨迹规划（去冲突）：直线打底，仅沿深度轴给冲突机分层偏移
    const avoid = minSep > 0 ? planAvoidance(a, b, pairs, transition, minSep) : undefined
    const result: RenderAssignment = { pairs, exiting, entering, elapsedMs: performance.now() - t0, avoid }
    scope.postMessage({ id: req.id, ok: true, result })
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: (err as Error).message })
  }
}
