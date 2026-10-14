/**
 * 产物计算客户端（Worker 池）：
 *  - 「匹配」在单个 worker 上跑（贪心排序是全局的，拆分会改变并列名次）；
 *  - 「安全检测」按采样帧区间分块，并行到多个 worker，再用 min/max 归约
 *    ⇒ 结果与单 worker **逐位一致**，但快 ~K 倍；
 *  - 内容签名命中时直接复用上次结果（匹配 / 安全各自缓存），避免重复重算。
 */
import { renderSignature, type RenderAssignment, type RenderPayload } from '../core/transition'
import {
  mergeSafety,
  safetySignature,
  safetySteps,
  type SafetyLimits,
  type SafetyResult,
} from '../core/safety'
import type { Point, Transition } from '../core/types'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** 每个缓存最多保留的条目数（超出丢最旧） */
const CACHE_MAX = 64
const matchCache = new Map<string, RenderAssignment>()
const safetyCache = new Map<string, SafetyResult>()

function cacheSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= CACHE_MAX) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

/** worker 数：留 1 核给主线程；上限 8（再多收益递减、还会和主线程抢核）；核太少退回单 worker */
function workerCount(): number {
  const hc =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4
  if (hc <= 2) return 1
  return Math.min(8, hc - 1)
}

export class RenderClient {
  private readonly workers: Worker[]
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private rr = 0

  constructor() {
    const count = workerCount()
    this.workers = []
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent) => this.onMessage(event.data)
      worker.onerror = (event) => this.onError(event)
      this.workers.push(worker)
    }
  }

  private onMessage(res: { id: number; ok: boolean; result?: unknown; error?: string }): void {
    const p = this.pending.get(res.id)
    if (!p) return
    this.pending.delete(res.id)
    if (res.ok) p.resolve(res.result)
    else p.reject(new Error(res.error || '计算失败'))
  }

  private onError(event: ErrorEvent): void {
    const error = new Error(`产物 Worker 错误：${event.message || '未知错误'}`)
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }

  private post(worker: Worker, request: object): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, ...request })
    })
  }

  private pick(): Worker {
    const worker = this.workers[this.rr % this.workers.length]
    this.rr++
    return worker
  }

  /** 匹配 + 避让（单 worker）。命中签名缓存则直接复用，跳过重算。 */
  compute(a: Point[], b: Point[], transition: Transition, minSep = 0): Promise<RenderAssignment> {
    const sig = renderSignature(transition.fromFrameId, transition.toFrameId, a, b, {
      algorithm: transition.algorithm,
      params: transition.params,
    })
    const key = `${sig}|sep${minSep}`
    const cached = matchCache.get(key)
    if (cached) return Promise.resolve(cached)
    return this.post(this.pick(), { kind: 'plan', a, b, transition, minSep }).then((res) => {
      const assignment = res as RenderAssignment
      cacheSet(matchCache, key, assignment)
      return assignment
    })
  }

  /** 安全检测：分块并行 + 归约；命中签名缓存则直接复用。 */
  async safety(render: RenderPayload, limits: SafetyLimits, fps = 30): Promise<SafetyResult> {
    const key = safetySignature(render, limits, fps)
    const cached = safetyCache.get(key)
    if (cached) return cached

    const steps = safetySteps(render, fps)
    let result: SafetyResult
    if (this.workers.length <= 1) {
      result = (await this.post(this.workers[0], { kind: 'safety', render, limits, fps })) as SafetyResult
    } else {
      const frames = steps + 1
      const posts: Array<Promise<unknown>> = []
      for (let c = 0; c < this.workers.length; c++) {
        const lo = Math.floor((c * frames) / this.workers.length)
        const hi = Math.floor(((c + 1) * frames) / this.workers.length) - 1
        if (hi < lo) continue
        posts.push(
          this.post(this.workers[c % this.workers.length], {
            kind: 'safetyPart',
            render,
            limits,
            fps,
            lo,
            hi,
          }),
        )
      }
      const parts = (await Promise.all(posts)) as SafetyLimits[]
      result = mergeSafety(parts, limits, steps)
    }
    cacheSet(safetyCache, key, result)
    return result
  }

  destroy(): void {
    for (const worker of this.workers) worker.terminate()
    this.pending.clear()
  }
}

let singleton: RenderClient | null = null

export function getRenderClient(): RenderClient {
  if (!singleton) singleton = new RenderClient()
  return singleton
}

/** 清空内容签名缓存（一般不需要：签名变化会自动失效） */
export function clearRenderCaches(): void {
  matchCache.clear()
  safetyCache.clear()
}
