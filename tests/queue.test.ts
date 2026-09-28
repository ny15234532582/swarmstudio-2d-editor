import { describe, expect, it } from 'vitest'
import { TaskQueue } from '../src/data/queue'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('TaskQueue', () => {
  it('串行执行任务', async () => {
    const queue = new TaskQueue(1)
    const order: number[] = []
    const task = (n: number, delay: number) =>
      queue.enqueue({
        payload: n,
        run: async (value) => {
          await tick(delay)
          order.push(value as number)
          return value
        },
      })
    await Promise.all([task(1, 20), task(2, 5), task(3, 1)])
    expect(order).toEqual([1, 2, 3])
  })

  it('相同 key 的待执行任务会被合并', async () => {
    const queue = new TaskQueue(1)
    const runs: unknown[] = []
    const enqueue = (value: number) =>
      queue.enqueue<number, { values: number[] }>({
        key: 'save',
        payload: { values: [value] },
        merge: (prev, next) => ({ values: [...prev.values, ...next.values] }),
        run: async (payload) => {
          runs.push(payload.values)
          return payload.values.length
        },
      })

    const blocker = queue.enqueue({ payload: null, run: () => tick(30) })
    const p1 = enqueue(1)
    const p2 = enqueue(2)
    const p3 = enqueue(3)
    await blocker
    expect(await Promise.all([p1, p2, p3])).toEqual([3, 3, 3])
    expect(runs).toEqual([[1, 2, 3]])
  })

  it('单个任务失败只 reject 它自己', async () => {
    const queue = new TaskQueue(1)
    const bad = queue.enqueue({ payload: null, run: async () => { throw new Error('boom') } })
    const good = queue.enqueue({ payload: null, run: async () => 'ok' })
    await expect(bad).rejects.toThrow('boom')
    await expect(good).resolves.toBe('ok')
  })
})
