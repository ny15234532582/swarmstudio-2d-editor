/**
 * 极简类型化事件总线。
 *
 * 为什么不用 Vue 的响应式：项目事实源包含数千个点对象，
 * 如果用 reactive/ref 深度追踪，每次读取都会建立依赖，写入会触发代理开销，
 * 在两万点场景下会明显拖慢。这里用「显式事件 + 版本号」的方式，
 * 让渲染层和 UI 层按需增量更新，而不是全量 diff。
 */
export type Listener<T> = (payload: T) => void

/**
 * 泛型事件总线。Events 是「事件名 → payload 类型」的映射，
 * 让 on/emit 的 payload 在编译期获得完整类型约束。
 */
export class Emitter<Events extends Record<string, unknown>> {
  /** 事件名 → 监听器集合；用 Set 天然去重且便于 O(1) 注销 */
  private listeners = new Map<keyof Events, Set<Listener<unknown>>>()

  /** 订阅事件，返回「取消订阅」函数（便于组件卸载时清理，避免内存泄漏） */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener<unknown>)
    return () => set!.delete(listener as Listener<unknown>)
  }

  /** 同步派发；无监听者时直接返回。注意：派发过程中修改监听器集合的行为未定义 */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) {
      ;(listener as Listener<Events[K]>)(payload)
    }
  }

  /** 清空全部监听器（销毁时调用） */
  clear(): void {
    this.listeners.clear()
  }
}
