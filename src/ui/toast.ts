import { ref } from 'vue'

export type ToastType = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  type: ToastType
  message: string
}

export const toasts = ref<Toast[]>([])

let nextId = 1

export function toast(message: string, type: ToastType = 'info', timeout = 3200): void {
  const id = nextId++
  toasts.value.push({ id, type, message })
  if (timeout > 0) {
    window.setTimeout(() => dismiss(id), timeout)
  }
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}
