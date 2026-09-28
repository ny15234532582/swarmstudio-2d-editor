/**
 * 极简类型化事件总线。
 *
 * 为什么不用 Vue 的响应式：项目事实源包含数千个点对象，
 * 如果用 reactive/ref 深度追踪，每次读取都会建立依赖，写入会触发代理开销，
 * 在两万点场景下会明显拖慢。这里用「显式事件 + 版本号」的方式，
 * 让渲染层和 UI 层按需增量更新，而不是全量 diff。
 */
export type Listener<T> = (payload: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<unknown>>>()

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener<unknown>)
    return () => set!.delete(listener as Listener<unknown>)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) {
      ;(listener as Listener<Events[K]>)(payload)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
