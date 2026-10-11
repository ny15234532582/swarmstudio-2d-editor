/**
 * 过渡引擎（纯函数，可 Node 单测）。
 *
 * 四层 + 安全层，全部可调：
 *   ① 分配（algorithm）：求解器 nearest / hungarian / auction / bottleneck(+index)
 *      代价是一个**加权评分**：wDist·dᵖ、wEven·|d−d*|、wAngle·方向、wGroup·同组、
 *      wOrder·顺序、wRadial·半径、wAngular·极角；bottleneck 求「最小化最大加权得分」。
 *   ② 路径（path）：linear / arc / bezier；curvature、arcDirection、waveAmp
 *   ③ 速度剖面（velocityProfile）：linear / ease / trapezoid / minJerk；easing、accelRatio；speedMode
 *   ④ 相位（stagger）：总错峰 + staggerOrder
 *   ⑤ 安全：minSeparation + separationStrength
 *
 * 分配只在过渡开始时算一次（planTransition），逐帧只做 O(n) 采样（samplePlan）。
 */
import type {
  EasingKind,
  Frame,
  Point,
  Track,
  Transition,
  TransitionAlgorithm,
  TransitionPath,
  VelocityProfile,
} from './types'

// ------------------------------------------------------------ 缓动

export function ease(t: number, kind: EasingKind): number {
  const x = Math.min(1, Math.max(0, t))
  switch (kind) {
    case 'linear':
      return x
    case 'easeIn':
      return x * x
    case 'easeOut':
      return 1 - (1 - x) * (1 - x)
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
  }
}

export function minJerk(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * x * (10 - 15 * x + 6 * x * x)
}

function trapezoid(t: number, r: number): number {
  const x = Math.min(1, Math.max(0, t))
  const ratio = Math.min(0.4999, Math.max(0, r))
  if (ratio <= 1e-6) return x
  const vmax = 1 / (1 - ratio)
  const acc = vmax / ratio
  if (x < ratio) return 0.5 * acc * x * x
  if (x < 1 - ratio) return 0.5 * vmax * ratio + vmax * (x - ratio)
  const td = 1 - x
  return 1 - 0.5 * acc * td * td
}

export function profileProgress(
  profile: VelocityProfile,
  easing: EasingKind,
  tau: number,
  params: Record<string, number>,
): number {
  switch (profile) {
    case 'linear':
      return Math.min(1, Math.max(0, tau))
    case 'minJerk':
      return minJerk(tau)
    case 'trapezoid':
      return trapezoid(tau, params.accelRatio ?? 0.25)
    case 'ease':
    default:
      return ease(tau, easing)
  }
}

// ------------------------------------------------------------ 分配（加权评分 + 求解器）

export interface Pair {
  from: Point
  to: Point
}

export interface TransitionPlan {
  pairs: Pair[]
  exiting: Point[]
  entering: Point[]
}

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function emptyPlan(a: Point[], b: Point[]): TransitionPlan {
  return { pairs: [], exiting: a.slice(), entering: b.slice() }
}

const MATCH_MAX = 400
const BIG = 1e12
/** 得分项数量：dist / even / angle / group / order / radial / angular */
export const SCORE_TERMS = 7

interface Weights {
  dist: number
  p: number
  even: number
  evenMode: number
  angle: number
  group: number
  order: number
  radial: number
  angular: number
}

/** 分配上下文：加权项所需的各种参考量 */
interface MatchCtx {
  a: Point[]
  b: Point[]
  w: Weights
  refDist: number
  refDx: number
  refDy: number
  rankA: number[]
  rankB: number[]
  radialA: number[]
  radialB: number[]
  thetaA: number[]
  thetaB: number[]
  /** 均匀度目标距离 d*（0 = 不启用均匀项） */
  target: number
  /** 允许边：allowed[i][j] === true；null 表示全部允许 */
  allowed: boolean[][] | null
}

function centroid(pts: Point[]): { x: number; y: number } {
  if (!pts.length) return { x: 0, y: 0 }
  let x = 0
  let y = 0
  for (const p of pts) {
    x += p.x
    y += p.y
  }
  return { x: x / pts.length, y: y / pts.length }
}

/** 沿某轴排序得到归一化名次 [0,1]：0=极角，1=x，2=y */
function makeRanks(pts: Point[], c: { x: number; y: number }, axis: number): number[] {
  const key = (p: Point) =>
    axis === 1 ? p.x : axis === 2 ? p.y : Math.atan2(p.y - c.y, p.x - c.x)
  const order = pts.map((p, i) => ({ i, k: key(p) })).sort((m, n) => m.k - n.k)
  const rank = new Array(pts.length).fill(0)
  const denom = Math.max(1, pts.length - 1)
  order.forEach((v, pos) => (rank[v.i] = pos / denom))
  return rank
}

/** 候选近邻并集：源点 K 近邻 ∪ 目标点 K 近邻（保证不孤立任何点） */
function makeAllowed(a: Point[], b: Point[], limit: number): boolean[][] | null {
  if (limit <= 0 || Math.max(a.length, b.length) <= limit) return null
  const allowed = a.map(() => new Array(b.length).fill(false))
  for (let i = 0; i < a.length; i++) {
    const idx = b.map((q, j) => ({ j, d: dist(a[i], q) })).sort((x, y) => x.d - y.d)
    for (let k = 0; k < Math.min(limit, idx.length); k++) allowed[i][idx[k].j] = true
  }
  for (let j = 0; j < b.length; j++) {
    const idx = a.map((p, i) => ({ i, d: dist(p, b[j]) })).sort((x, y) => x.d - y.d)
    for (let k = 0; k < Math.min(limit, idx.length); k++) allowed[idx[k].i][j] = true
  }
  return allowed
}

function bboxDiagonal(a: Point[], b: Point[]): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of a.concat(b)) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return Math.hypot(maxX - minX, maxY - minY) || 1
}

function readWeights(params: Record<string, number>): Weights {
  return {
    dist: params.wDist ?? 1,
    p: params.costPower ?? 1,
    even: params.wEven ?? 0,
    evenMode: params.evenMode ?? 0,
    angle: params.wAngle ?? 0,
    group: params.wGroup ?? 0,
    order: params.wOrder ?? 0,
    radial: params.wRadial ?? 0,
    angular: params.wAngular ?? 0,
  }
}

function buildCtx(a: Point[], b: Point[], params: Record<string, number>, target = 0): MatchCtx {
  const cA = centroid(a)
  const cB = centroid(b)
  let refDx = cB.x - cA.x
  let refDy = cB.y - cA.y
  const rl = Math.hypot(refDx, refDy) || 1
  refDx /= rl
  refDy /= rl
  const axis = params.rankAxis ?? 0
  return {
    a,
    b,
    w: readWeights(params),
    refDist: bboxDiagonal(a, b),
    refDx,
    refDy,
    rankA: makeRanks(a, cA, axis),
    rankB: makeRanks(b, cB, axis),
    radialA: a.map((p) => Math.hypot(p.x - cA.x, p.y - cA.y)),
    radialB: b.map((p) => Math.hypot(p.x - cB.x, p.y - cB.y)),
    thetaA: a.map((p) => Math.atan2(p.y - cA.y, p.x - cA.x)),
    thetaB: b.map((p) => Math.atan2(p.y - cB.y, p.x - cB.x)),
    target,
    allowed: makeAllowed(a, b, Math.floor(params.neighborLimit ?? 0)),
  }
}

function allowedEdge(ctx: MatchCtx, i: number, j: number): boolean {
  return ctx.allowed === null || ctx.allowed[i][j]
}

/** 每项得分（未加权）：dist / angle / group / order / radial / angular（均匀项依赖 target） */
function edgeScoreParts(ctx: MatchCtx, i: number, j: number): number[] {
  const ai = ctx.a[i]
  const bj = ctx.b[j]
  const d = dist(ai, bj)
  const dn = d / ctx.refDist
  const distTerm = Math.pow(dn, ctx.w.p)

  let evenTerm = 0
  if (ctx.w.even > 0 && ctx.target > 0) {
    const dev = ctx.w.evenMode === 1 ? (d - ctx.target) * (d - ctx.target) : Math.abs(d - ctx.target)
    evenTerm = Math.min(100, dev / ctx.target)
  }

  let angleTerm = 0
  if (ctx.w.angle > 0) {
    const len = d || 1e-9
    const cos = ((bj.x - ai.x) * ctx.refDx + (bj.y - ai.y) * ctx.refDy) / len
    angleTerm = (1 - cos) / 2
  }

  const groupTerm = ctx.w.group > 0 && ai.groupId && bj.groupId && ai.groupId !== bj.groupId ? 1 : 0
  const orderTerm = ctx.w.order > 0 ? Math.abs(ctx.rankA[i] - ctx.rankB[j]) : 0
  const radialTerm = ctx.w.radial > 0 ? Math.abs(ctx.radialA[i] - ctx.radialB[j]) / ctx.refDist : 0

  let angularTerm = 0
  if (ctx.w.angular > 0) {
    let da = Math.abs(ctx.thetaA[i] - ctx.thetaB[j])
    if (da > Math.PI) da = Math.PI * 2 - da
    angularTerm = da / Math.PI
  }

  return [distTerm, evenTerm, angleTerm, groupTerm, orderTerm, radialTerm, angularTerm]
}

/** 加权总得分（禁止边返回 BIG） */
function edgeScore(ctx: MatchCtx, i: number, j: number): number {
  if (!allowedEdge(ctx, i, j)) return BIG
  const parts = edgeScoreParts(ctx, i, j)
  const w = ctx.w
  return (
    w.dist * parts[0] +
    w.even * parts[1] +
    w.angle * parts[2] +
    w.group * parts[3] +
    w.order * parts[4] +
    w.radial * parts[5] +
    w.angular * parts[6]
  )
}

/** 按索引一一配对 */
function matchByIndex(a: Point[], b: Point[]): TransitionPlan {
  const pairs: Pair[] = []
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) pairs.push({ from: a[i], to: b[i] })
  return { pairs, exiting: a.slice(n), entering: b.slice(n) }
}

/** 贪心：按得分从小到大配对 */
function matchNearest(a: Point[], b: Point[], ctx: MatchCtx): TransitionPlan {
  if (a.length === 0 || b.length === 0) return emptyPlan(a, b)
  const candidates: Array<{ i: number; j: number; c: number }> = []
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (allowedEdge(ctx, i, j)) candidates.push({ i, j, c: edgeScore(ctx, i, j) })
    }
  }
  candidates.sort((p, q) => p.c - q.c)
  const usedA = new Uint8Array(a.length)
  const usedB = new Uint8Array(b.length)
  const pairs: Pair[] = []
  let matched = 0
  const target = Math.min(a.length, b.length)
  for (const c of candidates) {
    if (matched >= target) break
    if (usedA[c.i] || usedB[c.j]) continue
    usedA[c.i] = 1
    usedB[c.j] = 1
    pairs.push({ from: a[c.i], to: b[c.j] })
    matched++
  }
  return { pairs, exiting: a.filter((_, i) => !usedA[i]), entering: b.filter((_, j) => !usedB[j]) }
}

/** 匈牙利核心（O(n³)），输入方阵代价，返回 row→col */
function hungarian(cost: number[][]): number[] {
  const n = cost.length
  const u = new Array(n + 1).fill(0)
  const v = new Array(n + 1).fill(0)
  const p = new Array(n + 1).fill(0)
  const way = new Array(n + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(n + 1).fill(Infinity)
    const used = new Array(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }
  const ans = new Array(n).fill(-1)
  for (let j = 1; j <= n; j++) if (p[j] > 0) ans[p[j] - 1] = j - 1
  return ans
}

function planFromAssignment(a: Point[], b: Point[], assign: number[]): TransitionPlan {
  const n = Math.max(a.length, b.length)
  const pairs: Pair[] = []
  const exiting: Point[] = []
  const entering: Point[] = []
  for (let i = 0; i < n; i++) {
    const j = assign[i] ?? -1
    const realA = i < a.length
    const realB = j >= 0 && j < b.length
    if (realA && realB) pairs.push({ from: a[i], to: b[j] })
    else if (realA) exiting.push(a[i])
    else if (realB) entering.push(b[j])
  }
  return { pairs, exiting, entering }
}

/** 匈牙利：最小化 Σ 加权得分（点数过大退化贪心） */
function matchHungarian(a: Point[], b: Point[], ctx: MatchCtx): TransitionPlan {
  if (a.length === 0 || b.length === 0) return emptyPlan(a, b)
  if (Math.max(a.length, b.length) > MATCH_MAX) return matchNearest(a, b, ctx)
  const n = Math.max(a.length, b.length)
  const cost: number[][] = []
  for (let i = 0; i < n; i++) {
    const row = new Array(n).fill(BIG)
    for (let j = 0; j < n; j++) {
      if (i < a.length && j < b.length && allowedEdge(ctx, i, j)) row[j] = edgeScore(ctx, i, j)
    }
    cost.push(row)
  }
  return planFromAssignment(a, b, hungarian(cost))
}

/** 拍卖：近似最小化 Σ 加权得分（大规模） */
function matchAuction(a: Point[], b: Point[], ctx: MatchCtx, epsilon = 0.05): TransitionPlan {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return emptyPlan(a, b)
  if (Math.max(n, m) > 5000) return matchNearest(a, b, ctx)

  let avg = 0
  let cnt = 0
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      if (allowedEdge(ctx, i, j)) {
        avg += edgeScore(ctx, i, j)
        cnt++
      }
  avg = cnt ? avg / cnt : 1
  const eps = Math.max(1e-9, epsilon * avg)

  const price = new Array(m).fill(0)
  const owner = new Array(m).fill(-1)
  const bidderObj = new Array(n).fill(-1)
  const target = Math.min(n, m)
  const maxGuard = 200 * n + 1000
  let guard = 0
  let assigned = 0
  while (assigned < target && guard++ < maxGuard) {
    let progressed = false
    for (let i = 0; i < n; i++) {
      if (bidderObj[i] !== -1) continue
      let j1 = -1
      let j2 = -1
      let v1 = -Infinity
      let v2 = -Infinity
      for (let j = 0; j < m; j++) {
        if (!allowedEdge(ctx, i, j)) continue
        const val = -edgeScore(ctx, i, j) - price[j]
        if (val > v1) {
          v2 = v1
          j2 = j1
          v1 = val
          j1 = j
        } else if (val > v2) {
          v2 = val
          j2 = j
        }
      }
      if (j1 === -1) continue
      const bid = (j2 === -1 ? 1 : v1 - v2) + eps
      price[j1] += bid
      const prev = owner[j1]
      owner[j1] = i
      bidderObj[i] = j1
      if (prev !== -1) bidderObj[prev] = -1
      else assigned++
      progressed = true
    }
    if (!progressed) break
  }
  const assign = new Array(n).fill(-1)
  for (let j = 0; j < m; j++) if (owner[j] >= 0) assign[owner[j]] = j
  return planFromAssignment(a, b, assign)
}

/** 用给定阈值（加权得分）做二分图最大匹配；返回 b→a 的匹配数组 */
function maxMatching(ctx: MatchCtx, threshold: number): number[] {
  const a = ctx.a
  const m = ctx.b.length
  const adj: number[][] = a.map(() => [])
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < m; j++) {
      if (allowedEdge(ctx, i, j) && edgeScore(ctx, i, j) <= threshold) adj[i].push(j)
    }
  }
  const matchB = new Array(m).fill(-1)
  const tryK = (i: number, seen: Uint8Array): boolean => {
    for (const j of adj[i]) {
      if (seen[j]) continue
      seen[j] = 1
      if (matchB[j] === -1 || tryK(matchB[j], seen)) {
        matchB[j] = i
        return true
      }
    }
    return false
  }
  for (let i = 0; i < a.length; i++) tryK(i, new Uint8Array(m))
  return matchB
}

/** 瓶颈：最小化「最大加权得分」（默认权重下即最小化最大距离）。secondaryMinTotal 时阈值内再最小化 Σ 得分 */
function matchBottleneck(a: Point[], b: Point[], ctx: MatchCtx, secondaryMinTotal: boolean): TransitionPlan {
  if (a.length === 0 || b.length === 0) return emptyPlan(a, b)
  const target = Math.min(a.length, b.length)
  if (Math.max(a.length, b.length) > MATCH_MAX) return matchNearest(a, b, ctx)

  const scores: number[] = []
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) if (allowedEdge(ctx, i, j)) scores.push(edgeScore(ctx, i, j))
  }
  if (scores.length === 0) return { pairs: [], exiting: a.slice(), entering: b.slice() }
  scores.sort((x, y) => x - y)

  let lo = 0
  let hi = scores.length - 1
  let threshold = scores[hi]
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const count = maxMatching(ctx, scores[mid]).filter((x) => x >= 0).length
    if (count >= target) {
      threshold = scores[mid]
      hi = mid - 1
    } else lo = mid + 1
  }

  if (secondaryMinTotal) {
    const n = Math.max(a.length, b.length)
    const cost: number[][] = []
    for (let i = 0; i < n; i++) {
      const row = new Array(n).fill(BIG)
      for (let j = 0; j < n; j++) {
        if (i < a.length && j < b.length && allowedEdge(ctx, i, j) && edgeScore(ctx, i, j) <= threshold) {
          row[j] = edgeScore(ctx, i, j)
        }
      }
      cost.push(row)
    }
    return planFromAssignment(a, b, hungarian(cost))
  }

  const matchB = maxMatching(ctx, threshold)
  const assign = new Array(a.length).fill(-1)
  for (let j = 0; j < b.length; j++) if (matchB[j] >= 0) assign[matchB[j]] = j
  return planFromAssignment(a, b, assign)
}

/** 均匀度目标距离种子：用「每个源点的最近目标」的平均距离 */
function seedTarget(ctx: MatchCtx): number {
  let sum = 0
  let cnt = 0
  for (let i = 0; i < ctx.a.length; i++) {
    let best = Infinity
    for (let j = 0; j < ctx.b.length; j++) {
      if (!allowedEdge(ctx, i, j)) continue
      const d = dist(ctx.a[i], ctx.b[j])
      if (d < best) best = d
    }
    if (best < Infinity) {
      sum += best
      cnt++
    }
  }
  return cnt ? sum / cnt : 0
}

function solve(ctx: MatchCtx, algorithm: TransitionAlgorithm, params: Record<string, number>): TransitionPlan {
  switch (algorithm) {
    case 'index':
      return matchByIndex(ctx.a, ctx.b)
    case 'hungarian':
      return matchHungarian(ctx.a, ctx.b, ctx)
    case 'auction':
      return matchAuction(ctx.a, ctx.b, ctx, params.epsilon ?? 0.05)
    case 'bottleneck':
      return matchBottleneck(ctx.a, ctx.b, ctx, (params.secondaryMinTotal ?? 1) !== 0)
    case 'nearest':
    default:
      return matchNearest(ctx.a, ctx.b, ctx)
  }
}

/**
 * 按算法（含加权参数）生成过渡分配计划。
 * 启用均匀度（wEven>0 且未手动指定 targetDistance）时，迭代更新目标距离 d*。
 */
export function planTransition(
  a: Point[],
  b: Point[],
  transition: Pick<Transition, 'algorithm' | 'params'>,
): TransitionPlan {
  const params = transition.params ?? {}
  const targetFixed = params.targetDistance ?? 0
  const even = (params.wEven ?? 0) > 0
  let target = targetFixed
  const ctx = buildCtx(a, b, params, target)
  if (even && targetFixed <= 0) {
    target = seedTarget(ctx)
    ctx.target = target
  }
  let plan = solve(ctx, transition.algorithm as TransitionAlgorithm, params)

  if (even && targetFixed <= 0 && transition.algorithm !== 'index' && plan.pairs.length > 0) {
    const iters = Math.max(0, Math.min(20, Math.floor(params.evenIterations ?? 6)))
    for (let k = 0; k < iters; k++) {
      const ds = plan.pairs.map((p) => dist(p.from, p.to))
      const mean = ds.reduce((x, y) => x + y, 0) / ds.length
      if (Math.abs(mean - target) < 1e-6) break
      target = mean
      ctx.target = target
      plan = solve(ctx, transition.algorithm as TransitionAlgorithm, params)
    }
  }
  return plan
}

// ------------------------------------------------------------ 采样（②③④⑤）

export interface MotionSample {
  x: number
  y: number
  /** 深度（垂直于正面），用于 3D 间距与避让；缺省 0 */
  z?: number
  r: number
  g: number
  b: number
  alpha: number
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 单段轨迹取点：直线 / 弧线 / 三次贝塞尔（S 形） */
function pathPoint(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  s: number,
  path: TransitionPath,
  params: Record<string, number>,
): { x: number; y: number } {
  if (path === 'linear') return { x: lerp(ax, bx, s), y: lerp(ay, by, s) }
  const dx = bx - ax
  const dy = by - ay
  const dir = params.arcDirection ?? 0
  let sign = Math.sign(params.curvature ?? 0.25) || 1
  if (dir === 1) sign = 1
  else if (dir === 2) sign = -1
  const curve = Math.abs(params.curvature ?? 0.25) * sign
  const wave = params.waveAmp ?? 0
  const ox = -dy * curve
  const oy = dx * curve
  if (path === 'arc') {
    const cx = (ax + bx) / 2 + ox
    const cy = (ay + by) / 2 + oy
    const inv = 1 - s
    return {
      x: inv * inv * ax + 2 * inv * s * cx + s * s * bx,
      y: inv * inv * ay + 2 * inv * s * cy + s * s * by,
    }
  }
  const c1x = ax + dx / 3 + ox + oy * wave
  const c1y = ay + dy / 3 + oy - ox * wave
  const c2x = ax + (dx * 2) / 3 + ox + oy * wave
  const c2y = ay + (dy * 2) / 3 + oy - ox * wave
  const inv = 1 - s
  return {
    x: inv * inv * inv * ax + 3 * inv * inv * s * c1x + 3 * inv * s * s * c2x + s * s * s * bx,
    y: inv * inv * inv * ay + 3 * inv * inv * s * c1y + 3 * inv * s * s * c2y + s * s * s * by,
  }
}

function staggerRanks(plan: TransitionPlan, order: number): number[] {
  const n = plan.pairs.length
  const ranks = new Array(n)
  if (order === 1) {
    const idx = plan.pairs.map((p, k) => ({ k, d: dist(p.from, p.to) }))
    idx.sort((a, b) => a.d - b.d)
    idx.forEach((v, r) => (ranks[v.k] = r))
  } else if (order === 2) {
    const idx = plan.pairs.map((p, k) => ({ k, g: p.from.groupId ?? '' }))
    idx.sort((a, b) => (a.g < b.g ? -1 : a.g > b.g ? 1 : a.k - b.k))
    idx.forEach((v, r) => (ranks[v.k] = r))
  } else if (order === 3) {
    const idx = plan.pairs.map((_, k) => ({ k, h: Math.sin(k * 12.9898) * 43758.5453 }))
    idx.sort((a, b) => a.h - Math.floor(a.h) - (b.h - Math.floor(b.h)))
    idx.forEach((v, r) => (ranks[v.k] = r))
  } else {
    for (let k = 0; k < n; k++) ranks[k] = k
  }
  return ranks
}

/**
 * 待命区槽位（阵型下方一排）：退出机与进入机各占不同槽位，避免起降撞位。
 * 槽位按“退出在前、进入在后”顺序排在阵型包围盒下方。
 */
function standbySlots(
  plan: TransitionPlan,
  params: Record<string, number>,
): { exits: Array<{ x: number; y: number }>; enters: Array<{ x: number; y: number }> } {
  const pts: Point[] = []
  for (const p of plan.pairs) {
    pts.push(p.from, p.to)
  }
  for (const p of plan.exiting) pts.push(p)
  for (const p of plan.entering) pts.push(p)
  if (pts.length === 0) return { exits: [], enters: [] }
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const total = plan.exiting.length + plan.entering.length
  const gap = params.parkGap > 0 ? params.parkGap : (maxY - minY) * 0.2 + 40
  const spacing = params.parkSpacing > 0 ? params.parkSpacing : Math.max(10, gap * 0.8)
  const cx = (minX + maxX) / 2
  const y = maxY + gap
  const slot = (k: number) => ({ x: cx + (k - (total - 1) / 2) * spacing, y })
  const exits: Array<{ x: number; y: number }> = []
  const enters: Array<{ x: number; y: number }> = []
  plan.exiting.forEach((_, k) => exits.push(slot(k)))
  plan.entering.forEach((_, k) => enters.push(slot(plan.exiting.length + k)))
  return { exits, enters }
}

export function samplePlan(plan: TransitionPlan, transition: Transition, t: number): MotionSample[] {
  const stagger = Math.max(0, transition.stagger)
  const total = Math.max(0.0001, transition.duration + stagger)
  const elapsed = Math.min(1, Math.max(0, t)) * total
  const count = plan.pairs.length
  const order = transition.params?.staggerOrder ?? 0
  const ranks = stagger > 0 ? staggerRanks(plan, order) : null
  const speedMode = transition.params?.speedMode ?? 0

  let maxD = 0
  if (speedMode === 1) for (const p of plan.pairs) maxD = Math.max(maxD, dist(p.from, p.to))

  const out: MotionSample[] = []
  plan.pairs.forEach(({ from, to }, k) => {
    const rank = ranks ? ranks[k] : k
    const delay = count > 1 && stagger > 0 ? (rank / (count - 1)) * stagger : 0
    let duration = transition.duration
    if (speedMode === 1 && maxD > 0) duration = Math.max(0.0001, transition.duration * (dist(from, to) / maxD))
    const tau = Math.min(1, Math.max(0, (elapsed - delay) / duration))
    const s = profileProgress(transition.velocityProfile, transition.easing, tau, transition.params)
    const p = pathPoint(from.x, from.y, to.x, to.y, s, transition.path, transition.params)
    out.push({
      x: p.x,
      y: p.y,
      z: from.z + (to.z - from.z) * s,
      r: Math.round(lerp(from.r, to.r, s)),
      g: Math.round(lerp(from.g, to.g, s)),
      b: Math.round(lerp(from.b, to.b, s)),
      alpha: 1,
    })
  })

  const globalS = profileProgress(transition.velocityProfile, transition.easing, t, transition.params)
  const unusedMode = transition.params?.unusedMode ?? 0
  if (unusedMode === 0 && (plan.exiting.length > 0 || plan.entering.length > 0)) {
    // 未使用无人机：飞往/飞回阵型下方的待命区（全程在空中，暗显表示待命）
    const slots = standbySlots(plan, transition.params ?? {})
    const dim = transition.params?.parkDim ?? 0.25
    plan.exiting.forEach((from, k) => {
      const s = slots.exits[k]
      const p = pathPoint(from.x, from.y, s.x, s.y, globalS, 'linear', transition.params)
      out.push({ x: p.x, y: p.y, r: from.r, g: from.g, b: from.b, alpha: lerp(1, dim, globalS) })
    })
    plan.entering.forEach((to, k) => {
      const s = slots.enters[k]
      const p = pathPoint(s.x, s.y, to.x, to.y, globalS, 'linear', transition.params)
      out.push({ x: p.x, y: p.y, r: to.r, g: to.g, b: to.b, alpha: lerp(dim, 1, globalS) })
    })
  } else {
    // 原地淡入 / 淡出
    for (const from of plan.exiting) {
      out.push({ x: from.x, y: from.y, r: from.r, g: from.g, b: from.b, alpha: 1 - globalS })
    }
    for (const to of plan.entering) {
      out.push({ x: to.x, y: to.y, r: to.r, g: to.g, b: to.b, alpha: globalS })
    }
  }

  const minSep = transition.params?.minSeparation ?? 0
  const strength = transition.params?.separationStrength ?? 0
  const sepIters = Math.max(1, Math.min(12, Math.floor(transition.params?.separationIterations ?? 1)))
  if (minSep > 0 && strength > 0 && out.length > 1) {
    for (let it = 0; it < sepIters; it++) applySeparation(out, minSep, strength)
  }
  return out
}

function applySeparation(samples: MotionSample[], minSep: number, strength: number): void {
  const cell = minSep
  const key = (cx: number, cy: number) => (cx & 0xffff) * 0x10000 + (cy & 0xffff)
  const grid = new Map<number, number[]>()
  const cxOf = (s: MotionSample) => Math.floor(s.x / cell)
  const cyOf = (s: MotionSample) => Math.floor(s.y / cell)
  samples.forEach((s, i) => {
    const k = key(cxOf(s), cyOf(s))
    const list = grid.get(k)
    if (list) list.push(i)
    else grid.set(k, [i])
  })
  const minSep2 = minSep * minSep
  const shift = samples.map(() => ({ x: 0, y: 0 }))
  for (let i = 0; i < samples.length; i++) {
    const cx = cxOf(samples[i])
    const cy = cyOf(samples[i])
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(key(gx, gy))
        if (!bucket) continue
        for (const j of bucket) {
          if (j <= i) continue
          const dx = samples[j].x - samples[i].x
          const dy = samples[j].y - samples[i].y
          const d2 = dx * dx + dy * dy
          if (d2 >= minSep2) continue
          const d = Math.sqrt(d2)
          if (d < 1e-6) {
            // 完全重合：沿一个确定性方向各推开 minSep/2，避免 NaN 且能分开
            const ang = (i % 360) * (Math.PI / 180)
            const ox = Math.cos(ang) * minSep * 0.5 * strength
            const oy = Math.sin(ang) * minSep * 0.5 * strength
            shift[i].x -= ox
            shift[i].y -= oy
            shift[j].x += ox
            shift[j].y += oy
          } else {
            const push = ((minSep - d) / d) * 0.5 * strength
            shift[i].x -= dx * push
            shift[i].y -= dy * push
            shift[j].x += dx * push
            shift[j].y += dy * push
          }
        }
      }
    }
  }
  for (let i = 0; i < samples.length; i++) {
    samples[i].x += shift[i].x
    samples[i].y += shift[i].y
  }
}

// ------------------------------------------------------------ 轨迹预览

export function transitionTrails(
  a: Point[],
  b: Point[],
  transition: Transition,
  steps = 16,
): Array<Array<{ x: number; y: number }>> {
  const plan = planTransition(a, b, transition)
  const seg = plan.pairs.length > 2000 ? 6 : steps
  const out: Array<Array<{ x: number; y: number }>> = []
  for (const { from, to } of plan.pairs) {
    const poly: Array<{ x: number; y: number }> = []
    for (let i = 0; i <= seg; i++) {
      poly.push(pathPoint(from.x, from.y, to.x, to.y, i / seg, transition.path, transition.params))
    }
    out.push(poly)
  }
  return out
}

// ------------------------------------------------------------ 统计

export interface TransitionStats {
  pairCount: number
  exitingCount: number
  enteringCount: number
  minDistance: number
  maxDistance: number
  meanDistance: number
  medianDistance: number
  stdDistance: number
  totalDistance: number
  cv: number
  peakSpeed: number
  avgSpeed: number
  peakAccel: number
  avgAccel: number
  peakJerk: number
  duration: number
  /** 加权总得分 / 最大单项得分 */
  totalScore: number
  maxScore: number
  /** 各权重项的得分贡献（顺序同 SCORE_TERMS） */
  scoreByTerm: number[]
  distances: number[]
  velocityCurve: number[]
  progressCurve: number[]
}

interface ProfileAnalysis {
  peakSpeed: number
  avgSpeed: number
  peakAccel: number
  avgAccel: number
  peakJerk: number
  velocity: number[]
  progress: number[]
}

function profileAnalysis(transition: Transition, maxDistance: number, duration: number): ProfileAnalysis {
  const N = 64
  const dt = 1 / N
  const s: number[] = []
  for (let i = 0; i <= N; i++) {
    s.push(profileProgress(transition.velocityProfile, transition.easing, i * dt, transition.params))
  }
  const v = new Array(N + 1).fill(0)
  const a = new Array(N + 1).fill(0)
  const j = new Array(N + 1).fill(0)
  for (let i = 1; i <= N; i++) v[i] = (s[i] - s[i - 1]) / dt
  for (let i = 2; i <= N; i++) a[i] = (s[i] - 2 * s[i - 1] + s[i - 2]) / (dt * dt)
  for (let i = 3; i <= N; i++) j[i] = (s[i] - 3 * s[i - 1] + 3 * s[i - 2] - s[i - 3]) / (dt * dt * dt)

  const peak = (arr: number[]) => arr.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
  const mean = (arr: number[]) => (arr.length ? arr.reduce((m, x) => m + Math.abs(x), 0) / arr.length : 0)

  const speedScale = duration > 0 ? maxDistance / duration : 0
  const accelScale = duration > 0 ? maxDistance / (duration * duration) : 0
  const jerkScale = duration > 0 ? maxDistance / (duration * duration * duration) : 0

  return {
    peakSpeed: peak(v) * speedScale,
    avgSpeed: mean(v) * speedScale,
    peakAccel: peak(a) * accelScale,
    avgAccel: mean(a) * accelScale,
    peakJerk: peak(j) * jerkScale,
    velocity: v.map((x) => x * speedScale),
    progress: s,
  }
}

export function transitionStats(plan: TransitionPlan, transition: Transition): TransitionStats {
  const total = Math.max(0.0001, transition.duration + Math.max(0, transition.stagger))
  const ds = plan.pairs.map((p) => dist(p.from, p.to))
  const sorted = ds.slice().sort((x, y) => x - y)
  const minDistance = sorted.length ? sorted[0] : 0
  const maxDistance = sorted.length ? sorted[sorted.length - 1] : 0
  const mean = ds.length ? ds.reduce((sum, d) => sum + d, 0) / ds.length : 0
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : 0
  const variance = ds.length ? ds.reduce((sum, d) => sum + (d - mean) * (d - mean), 0) / ds.length : 0
  const stdDistance = Math.sqrt(variance)
  const totalDistance = ds.reduce((sum, d) => sum + d, 0)
  const ana = profileAnalysis(transition, maxDistance, transition.duration)

  // 加权得分：用配对点重建上下文（from 集与 to 集），target 用均值近似
  const froms = plan.pairs.map((p) => p.from)
  const tos = plan.pairs.map((p) => p.to)
  const params = transition.params ?? {}
  const ctx = buildCtx(froms, tos, params, mean)
  const w = ctx.w
  const scoreByTerm = new Array(SCORE_TERMS).fill(0)
  let totalScore = 0
  let maxScore = 0
  plan.pairs.forEach((_, i) => {
    const parts = edgeScoreParts(ctx, i, i)
    parts.forEach((x, k) => (scoreByTerm[k] += x))
    const s =
      w.dist * parts[0] +
      w.even * parts[1] +
      w.angle * parts[2] +
      w.group * parts[3] +
      w.order * parts[4] +
      w.radial * parts[5] +
      w.angular * parts[6]
    totalScore += s
    maxScore = Math.max(maxScore, s)
  })
  const weightedTerms = scoreByTerm.map((sum, k) => sum * [w.dist, w.even, w.angle, w.group, w.order, w.radial, w.angular][k])

  return {
    pairCount: plan.pairs.length,
    exitingCount: plan.exiting.length,
    enteringCount: plan.entering.length,
    minDistance,
    maxDistance,
    meanDistance: mean,
    medianDistance: median,
    stdDistance,
    totalDistance,
    cv: mean > 0 ? stdDistance / mean : 0,
    peakSpeed: ana.peakSpeed,
    avgSpeed: ana.avgSpeed,
    peakAccel: ana.peakAccel,
    avgAccel: ana.avgAccel,
    peakJerk: ana.peakJerk,
    duration: total,
    totalScore,
    maxScore,
    scoreByTerm: weightedTerms,
    distances: ds,
    velocityCurve: ana.velocity,
    progressCurve: ana.progress,
  }
}

// ------------------------------------------------------------ 产物（Render）

/** 产物中的分配结果：用 A/B 帧点位的下标（紧凑、可序列化） */
export interface RenderAssignment {
  pairs: [number, number][]
  exiting: number[]
  entering: number[]
  elapsedMs: number
  /** 分层避让（可选）：每架的深度层偏移 */
  avoid?: AvoidPlan
}

/** 采样参数快照（生成产物时冻结） */
export interface RenderParams {
  path: TransitionPath
  curvature: number
  arcDirection: number
  waveAmp: number
  velocityProfile: VelocityProfile
  easing: EasingKind
  speedMode: number
  accelRatio: number
  minSeparation: number
  separationStrength: number
  separationIterations: number
  staggerOrder: number
  /** 未使用无人机：0 飞往待命区（默认），1 原地淡入淡出 */
  unusedMode: number
  /** 待命区与阵型的间距（0=自动） */
  parkGap: number
  /** 待命槽位间距（0=自动） */
  parkSpacing: number
  /** 待命时透明度（落灯待命） */
  parkDim: number
}

/**
 * 过渡产物：自包含（冻结帧点位 + 参数 + 分配 + 统计），
 * 可脱离工程直接逐帧采样播放，不再做匹配。
 */
export interface RenderPayload {
  fromFrameId: string
  toFrameId: string
  a: Point[]
  b: Point[]
  pairs: [number, number][]
  exiting: number[]
  entering: number[]
  duration: number
  stagger: number
  params: RenderParams
  stats: TransitionStats
  /** 分层避让（可选）：每架的深度层偏移 */
  avoid?: AvoidPlan
}

/** 只影响「匹配」的参数键（用于签名判定是否过期） */
const MATCH_SIG_KEYS = [
  'wDist', 'costPower', 'wEven', 'evenMode', 'targetDistance', 'evenIterations',
  'wAngle', 'wGroup', 'wOrder', 'rankAxis', 'wRadial', 'wAngular',
  'neighborLimit', 'epsilon', 'secondaryMinTotal',
]

function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** 帧点位内容哈希（跨会话稳定：id + 取整坐标） */
export function frameHash(points: Point[]): string {
  let s = ''
  for (const p of points) s += `${p.id}:${p.x.toFixed(3)},${p.y.toFixed(3)};`
  return fnv1a(s)
}

/** 产物签名：算法 + 只影响匹配的参数 + 帧内容哈希 + 帧 id */
export function renderSignature(
  fromFrameId: string,
  toFrameId: string,
  a: Point[],
  b: Point[],
  transition: Pick<Transition, 'algorithm' | 'params'>,
): string {
  const params = transition.params ?? {}
  const key = MATCH_SIG_KEYS.map((k) => `${k}=${params[k] ?? 0}`).join(',')
  return fnv1a(`${fromFrameId}|${toFrameId}|${transition.algorithm}|${key}|${frameHash(a)}|${frameHash(b)}`)
}

function planFromRender(r: RenderPayload): TransitionPlan {
  const pairs: Pair[] = []
  for (const [i, j] of r.pairs) {
    const from = r.a[i]
    const to = r.b[j]
    if (from && to) pairs.push({ from, to })
  }
  const exiting = r.exiting.map((i) => r.a[i]).filter(Boolean) as Point[]
  const entering = r.entering.map((j) => r.b[j]).filter(Boolean) as Point[]
  return { pairs, exiting, entering }
}

/** 由产物还原一个「用于采样」的过渡对象（含所有采样参数） */
function transitionFromRender(r: RenderPayload): Transition {
  const p = r.params
  return {
    id: '',
    fromFrameId: r.fromFrameId,
    toFrameId: r.toFrameId,
    duration: r.duration,
    algorithm: 'index',
    path: p.path,
    velocityProfile: p.velocityProfile,
    easing: p.easing,
    stagger: r.stagger,
    params: {
      curvature: p.curvature,
      arcDirection: p.arcDirection,
      waveAmp: p.waveAmp,
      speedMode: p.speedMode,
      accelRatio: p.accelRatio,
      minSeparation: p.minSeparation,
      separationStrength: p.separationStrength,
      separationIterations: p.separationIterations,
      staggerOrder: p.staggerOrder,
      unusedMode: p.unusedMode,
      parkGap: p.parkGap,
      parkSpacing: p.parkSpacing,
      parkDim: p.parkDim,
    },
  }
}

/** 组装产物：冻结帧点位 + 参数快照 + 分配 + 统计 */
export function buildRender(
  a: Point[],
  b: Point[],
  transition: Transition,
  assignment: RenderAssignment,
  avoid?: AvoidPlan,
): RenderPayload {
  const plan: TransitionPlan = {
    pairs: assignment.pairs.map(([i, j]) => ({ from: a[i], to: b[j] })),
    exiting: assignment.exiting.map((i) => a[i]),
    entering: assignment.entering.map((j) => b[j]),
  }
  const params = transition.params ?? {}
  return {
    fromFrameId: transition.fromFrameId,
    toFrameId: transition.toFrameId,
    a,
    b,
    pairs: assignment.pairs,
    exiting: assignment.exiting,
    entering: assignment.entering,
    duration: transition.duration,
    stagger: transition.stagger,
    avoid: avoid ?? assignment.avoid,
    params: {
      path: transition.path,
      curvature: params.curvature ?? 0.25,
      arcDirection: params.arcDirection ?? 0,
      waveAmp: params.waveAmp ?? 0,
      velocityProfile: transition.velocityProfile,
      easing: transition.easing,
      speedMode: params.speedMode ?? 0,
      accelRatio: params.accelRatio ?? 0.25,
      minSeparation: params.minSeparation ?? 0,
      separationStrength: params.separationStrength ?? 0.5,
      separationIterations: params.separationIterations ?? 1,
      staggerOrder: params.staggerOrder ?? 0,
      unusedMode: params.unusedMode ?? 0,
      parkGap: params.parkGap ?? 0,
      parkSpacing: params.parkSpacing ?? 0,
      parkDim: params.parkDim ?? 0.25,
    },
    stats: transitionStats(plan, transition),
  }
}

/**
 * 避让规划结果（分层避让）：给每架飞机一个整数「深度层」。
 * x/y 保持直线不动画面，仅沿深度 z 偏移；深度偏移 = 层号 * spacing * bump(t)，
 * bump 两端回 0，故不破坏关键帧队形。
 */
export interface AvoidPlan {
  /** 参与规划的机对数（= 采样点对数） */
  n: number
  /** 每架的层号（已居中，可为负） */
  layer: Float64Array
  /** 相邻层深度间距（≥ 最小安全间距） */
  spacing: number
  /** 抬升/回落的归一化时宽（0~0.5） */
  ramp: number
  /** 着色用了几层 */
  colors: number
}

/** 平台型平滑 bump：0 →(ramp)→ 1 →(平台)→ 1 →(ramp)→ 0；C1 连续。
 *  ramp <= 0 时恒为 1（深度偏移全程保持不变，速度开销为 0）。 */
function bump(t: number, ramp: number): number {
  if (ramp <= 0) return 1
  const a = Math.max(1e-4, Math.min(0.5, ramp))
  const u = t <= a ? t / a : t >= 1 - a ? (1 - t) / a : 1
  const s = u < 0 ? 0 : u > 1 ? 1 : u
  return s * s * (3 - 2 * s)
}

/** 由产物取出第 k 架在进度 t 的避让偏移（仅深度 z） */
function sampleAvoid(plan: AvoidPlan, k: number, t: number): { x: number; y: number; z: number } {
  if (k < 0 || k >= plan.n) return { x: 0, y: 0, z: 0 }
  return { x: 0, y: 0, z: plan.layer[k] * plan.spacing * bump(t, plan.ramp) }
}

/**
 * 轨迹规划器（分层避让）：x/y 走直线不动画面，仅沿深度轴 z 给冲突机分层。
 *
 * 1) 采样若干帧，统计「任一时刻 3D 距离 < 阈值」的机对，建并集冲突图；
 * 2) 贪心着色（度数降序 first-fit）→ 同色机永不相冲，异色机深度差 ≥ spacing；
 * 3) 层号居中减小振幅，再乘平台 bump 使两端回 0（不破坏关键帧）。
 *
 * 深度只增加与 (x,y) 正交的距离，绝不会制造新冲突，因此该方案单调安全：
 * 同色 ⇒ 平面本身就 ≥ 阈值；异色 ⇒ 深度差 ≥ spacing ≈ 1.25×minSep。
 */
export function planAvoidance(
  a: Point[],
  b: Point[],
  pairs: [number, number][],
  transition: Transition,
  minSep: number,
  opts: { frames?: number; margin?: number; spacingScale?: number; ramp?: number } = {},
): AvoidPlan {
  const n = pairs.length
  const spacing = minSep * (opts.spacingScale ?? 1.3)
  const ramp = opts.ramp ?? 0
  const empty: AvoidPlan = { n, layer: new Float64Array(n), spacing, ramp, colors: 0 }
  if (n < 2 || minSep <= 0) return empty
  const params = transition.params ?? {}
  const frameCount = Math.max(2, opts.frames ?? 400)
  // 建图阈值放宽（margin），保证“同色”机对在未采样时刻也有余量
  const threshold = minSep * (opts.margin ?? 1.3)

  const base = (k: number, t: number) => {
    const e = profileProgress(transition.velocityProfile, transition.easing, t, params)
    const [i, j] = pairs[k]
    const pp = pathPoint(a[i].x, a[i].y, b[j].x, b[j].y, e, transition.path, params)
    return { x: pp.x, y: pp.y, z: (a[i].z ?? 0) + ((b[j].z ?? 0) - (a[i].z ?? 0)) * e }
  }

  // ---- 1) 建并集冲突图 ----
  const adjSets: Set<number>[] = Array.from({ length: n }, () => new Set<number>())
  const cell = threshold
  const key = (cx: number, cy: number, cz: number) =>
    ((cx & 0x3ff) * 1024 + (cy & 0x3ff)) * 1024 + (cz & 0x3ff)
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const pz = new Float64Array(n)
  const thr2 = threshold * threshold
  for (let fi = 0; fi < frameCount; fi++) {
    const t = frameCount === 1 ? 0 : fi / (frameCount - 1)
    for (let k = 0; k < n; k++) {
      const bp = base(k, t)
      px[k] = bp.x
      py[k] = bp.y
      pz[k] = bp.z
    }
    const grid = new Map<number, number[]>()
    for (let k = 0; k < n; k++) {
      const kk = key(Math.floor(px[k] / cell), Math.floor(py[k] / cell), Math.floor(pz[k] / cell))
      const list = grid.get(kk)
      if (list) list.push(k)
      else grid.set(kk, [k])
    }
    for (let k = 0; k < n; k++) {
      const cx = Math.floor(px[k] / cell)
      const cy = Math.floor(py[k] / cell)
      const cz = Math.floor(pz[k] / cell)
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (let gz = cz - 1; gz <= cz + 1; gz++) {
            const bucket = grid.get(key(gx, gy, gz))
            if (!bucket) continue
            for (const m of bucket) {
              if (m <= k) continue
              const dx = px[m] - px[k]
              const dy = py[m] - py[k]
              const dz = pz[m] - pz[k]
              if (dx * dx + dy * dy + dz * dz < thr2) {
                adjSets[k].add(m)
                adjSets[m].add(k)
              }
            }
          }
        }
      }
    }
  }

  // ---- 2) DSATUR 着色（饱和度优先；比度数降序 first-fit 更省层） ----
  const deg = new Int32Array(n)
  for (let k = 0; k < n; k++) deg[k] = adjSets[k].size
  const color = new Int32Array(n).fill(-1)
  const sat = new Int32Array(n)
  const nc: Set<number>[] = Array.from({ length: n }, () => new Set<number>())
  let K = 0
  for (let done = 0; done < n; done++) {
    let best = -1
    for (let v = 0; v < n; v++) {
      if (color[v] >= 0) continue
      if (best < 0 || sat[v] > sat[best] || (sat[v] === sat[best] && deg[v] > deg[best])) best = v
    }
    const s = nc[best]
    let c = 0
    while (s.has(c)) c++
    color[best] = c
    if (c + 1 > K) K = c + 1
    for (const u of adjSets[best]) {
      if (color[u] >= 0) continue
      if (!nc[u].has(c)) {
        nc[u].add(c)
        sat[u]++
      }
    }
  }

  // ---- 3) 居中：减小深度振幅 ----
  const half = (K - 1) / 2
  const layer = new Float64Array(n)
  for (let k = 0; k < n; k++) layer[k] = color[k] - half
  return { n, layer, spacing, ramp, colors: K }
}

/** 由产物逐帧采样（t 为区段归一化进度 [0,1]），不再匹配 */
export function sampleRenderSegment(render: RenderPayload, t: number): MotionSample[] {
  const samples = samplePlan(planFromRender(render), transitionFromRender(render), t)
  const avoid = render.avoid
  if (avoid) {
    const tt = Math.min(1, Math.max(0, t))
    const n = Math.min(render.pairs.length, samples.length)
    for (let k = 0; k < n; k++) {
      const off = sampleAvoid(avoid, k, tt)
      samples[k].x += off.x
      samples[k].y += off.y
      samples[k].z = (samples[k].z ?? 0) + off.z
    }
  }
  return samples
}

/** 由产物生成飞行轨迹折线 */
export function trailsFromRender(
  render: RenderPayload,
  steps = 16,
): Array<Array<{ x: number; y: number }>> {
  const count = render.pairs.length
  const seg = count > 5000 ? 4 : count > 2000 ? 6 : steps
  const pathParams = {
    curvature: render.params.curvature,
    arcDirection: render.params.arcDirection,
    waveAmp: render.params.waveAmp,
  }
  const out: Array<Array<{ x: number; y: number }>> = []
  render.pairs.forEach(([i, j], pairIndex) => {
    const from = render.a[i]
    const to = render.b[j]
    if (!from || !to) return
    const poly: Array<{ x: number; y: number }> = []
    for (let k = 0; k <= seg; k++) {
      const u = k / seg
      const pp = pathPoint(from.x, from.y, to.x, to.y, u, render.params.path, pathParams)
      if (render.avoid) {
        const off = sampleAvoid(render.avoid, pairIndex, u)
        poly.push({ x: pp.x + off.x, y: pp.y + off.y })
      } else {
        poly.push(pp)
      }
    }
    out.push(poly)
  })
  return out
}

// ------------------------------------------------------------ 时间线

export type TimelineSegment =
  | { kind: 'hold'; frameId: string; start: number; end: number }
  | {
      kind: 'transition'
      transitionId: string
      fromFrameId: string
      toFrameId: string
      start: number
      end: number
    }

export interface Timeline {
  segments: TimelineSegment[]
  duration: number
}

export function transitionLength(transition: Transition): number {
  return Math.max(0, transition.duration + transition.stagger)
}

export function buildTimeline(track: Track): Timeline {
  const segments: TimelineSegment[] = []
  let t = 0
  const { clips, transitions } = track
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    segments.push({ kind: 'hold', frameId: clip.id, start: t, end: t + clip.duration })
    t += clip.duration
    const trans = transitions.find((tr) => tr.fromFrameId === clip.id && tr.toFrameId === clips[i + 1]?.id)
    if (trans && i + 1 < clips.length) {
      const len = transitionLength(trans)
      segments.push({
        kind: 'transition',
        transitionId: trans.id,
        fromFrameId: trans.fromFrameId,
        toFrameId: trans.toFrameId,
        start: t,
        end: t + len,
      })
      t += len
    }
  }
  return { segments, duration: t }
}

export function segmentAt(segments: TimelineSegment[], time: number): TimelineSegment | null {
  if (segments.length === 0) return null
  for (const seg of segments) if (time < seg.end) return seg
  return segments[segments.length - 1]
}

export function sampleFrameAt(
  track: Track,
  pointsByFrame: Map<string, Point[]>,
  time: number,
): MotionSample[] {
  const { segments } = buildTimeline(track)
  const seg = segmentAt(segments, time)
  if (!seg) return []
  if (seg.kind === 'hold') {
    return (pointsByFrame.get(seg.frameId) ?? []).map((p) => ({
      x: p.x,
      y: p.y,
      r: p.r,
      g: p.g,
      b: p.b,
      alpha: 1,
    }))
  }
  const trans = track.transitions.find((tr) => tr.id === seg.transitionId)
  if (!trans) return []
  const a = pointsByFrame.get(seg.fromFrameId) ?? []
  const b = pointsByFrame.get(seg.toFrameId) ?? []
  const plan = planTransition(a, b, trans)
  const t = seg.end > seg.start ? (time - seg.start) / (seg.end - seg.start) : 1
  return samplePlan(plan, trans, t)
}

export function framePointCount(pointsByFrame: Map<string, Point[]>, frame: Frame): number {
  return pointsByFrame.get(frame.id)?.length ?? 0
}
