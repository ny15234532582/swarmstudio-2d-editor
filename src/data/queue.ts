/**
 * 任务队列（数据操作层与 Worker 之间的中间层）。
 *
 * 职责（对应你的要求「中间加一层任务队列」）：
 * - **串行化**：concurrency 控制，保证同一时刻只有一个请求在途，
 *   避免 SQLite 侧出现交叉事务。
 * - **合并（coalescing）**：相同 key 的待执行任务会被 merge 成一个，
 *   例如连续多次自动保存会合并为一次批量写入，避免每次 pointermove 都写盘。
 * - **统一错误传播**：一个任务失败只 reject 它自己的 Promise。
 *
 * 队列本身与传输方式无关，因此可以用假 transport 单测。
 */
export interface TaskOptions<T, P> {
  /** 相同 key 的待执行任务会被合并；不传则不合并 */
  key?: string
  /** 初始负载 */
  payload: P
  /** 合并负载：返回合并后的新负载 */
  merge?: (prev: P, next: P) => P
  /** 实际执行逻辑，p 是合并后的负载 */
  run: (p: P) => Promise<T>
}

interface QueueItem {
  key?: string
  payload: unknown
  merge?: (prev: unknown, next: unknown) => unknown
  run: (p: unknown) => Promise<unknown>
  resolvers: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>
}

export class TaskQueue {
  private items: QueueItem[] = []
  private inflight = 0
  private readonly concurrency: number

  constructor(concurrency = 1) {
    this.concurrency = concurrency
  }

  enqueue<T, P>(options: TaskOptions<T, P>): Promise<T> {
    if (options.key !== undefined) {
      const existing = this.items.find((item) => item.key === options.key)
      if (existing && existing.merge) {
        existing.payload = existing.merge(existing.payload, options.payload)
        return new Promise<T>((resolve, reject) => {
          existing.resolvers.push({ resolve: resolve as (v: unknown) => void, reject })
        })
      }
    }
    const item: QueueItem = {
      key: options.key,
      payload: options.payload,
      merge: options.merge as QueueItem['merge'],
      run: options.run as QueueItem['run'],
      resolvers: [],
    }
    const promise = new Promise<T>((resolve, reject) => {
      item.resolvers.push({ resolve: resolve as (v: unknown) => void, reject })
    })
    this.items.push(item)
    this.pump()
    return promise
  }

  /** 当前排队（未执行）的任务数，用于观测 / 测试 */
  get pending(): number {
    return this.items.length
  }

  private pump(): void {
    while (this.inflight < this.concurrency && this.items.length > 0) {
      const item = this.items.shift()!
      this.inflight++
      item
        .run(item.payload)
        .then((result) => {
          for (const r of item.resolvers) r.resolve(result)
        })
        .catch((error) => {
          for (const r of item.resolvers) r.reject(error)
        })
        .finally(() => {
          this.inflight--
          this.pump()
        })
    }
  }
}
