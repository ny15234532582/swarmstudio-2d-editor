/**
 * 轻量级全局提示（Toast）状态与操作。
 *
 * 设计意图：用一个模块级响应式数组承载提示消息，任何模块（Store、UI、
 * 数据层）都能直接调用 toast() 而不必层层传递组件引用；ToastHost 只负责
 * 订阅渲染。这样把「产生提示」和「展示提示」解耦。
 */
import { ref } from 'vue'

/** 提示类型：仅用于决定边框颜色与图标，不影响展示逻辑 */
export type ToastType = 'info' | 'success' | 'error'

/** 单条提示：id 用于列表 key 与定时关闭时定位 */
export interface Toast {
  id: number
  type: ToastType
  message: string
}

/** 当前待展示的提示列表（响应式，供 ToastHost 渲染） */
export const toasts = ref<Toast[]>([])

/** 自增 id 生成器：保证同一会话内每条提示 id 唯一，避免快速重复提示相互覆盖 */
let nextId = 1

/**
 * 弹出一条提示。
 * @param timeout 自动关闭的毫秒数；传 0 或负数表示不自动关闭（常驻，需手动点击关闭）。
 */
export function toast(message: string, type: ToastType = 'info', timeout = 3200): void {
  const id = nextId++
  toasts.value.push({ id, type, message })
  // 仅在正数超时下安排关闭；用 id 而非对象引用，避免先关再弹时误删新提示
  if (timeout > 0) {
    window.setTimeout(() => dismiss(id), timeout)
  }
}

/** 关闭指定提示：以「过滤重建」替代原地删除，触发 ref 的依赖更新 */
export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}
