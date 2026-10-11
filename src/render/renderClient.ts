/**
 * 产物计算客户端：把「匹配」与「安全检测」请求发给 renderWorker，按 id 关联 Promise。
 */
import type { RenderAssignment, RenderPayload } from '../core/transition'
import type { SafetyLimits, SafetyResult } from '../core/safety'
import type { Point, Transition } from '../core/types'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class RenderClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor() {
    this.worker = new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent) => this.onMessage(event.data)
    this.worker.onerror = (event) => {
      const error = new Error(`产物 Worker 错误：${event.message || '未知错误'}`)
      for (const p of this.pending.values()) p.reject(error)
      this.pending.clear()
    }
  }

  private onMessage(res: { id: number; ok: boolean; result?: unknown; error?: string }): void {
    const p = this.pending.get(res.id)
    if (!p) return
    this.pending.delete(res.id)
    if (res.ok) p.resolve(res.result)
    else p.reject(new Error(res.error || '计算失败'))
  }

  private post(request: object): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, ...request })
    })
  }

  compute(a: Point[], b: Point[], transition: Transition, minSep = 0): Promise<RenderAssignment> {
    return this.post({ kind: 'plan', a, b, transition, minSep }) as Promise<RenderAssignment>
  }

  safety(render: RenderPayload, limits: SafetyLimits, fps = 30): Promise<SafetyResult> {
    return this.post({ kind: 'safety', render, limits, fps }) as Promise<SafetyResult>
  }

  destroy(): void {
    this.worker.terminate()
    this.pending.clear()
  }
}

let singleton: RenderClient | null = null

export function getRenderClient(): RenderClient {
  if (!singleton) singleton = new RenderClient()
  return singleton
}
