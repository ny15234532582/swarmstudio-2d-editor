/**
 * 过渡产物内存缓存：持久化产物（打开项目时载入）+ 当前抽屉的内存预览。
 * 用 revision 触发 Vue 更新；播放/轨迹/统计都从这里取产物。
 */
import { ref } from 'vue'
import type { RenderPayload } from '../core/transition'

const renders = new Map<string, RenderPayload>()

/** 产物集合变化计数（触发 UI 更新） */
export const renderRevision = ref(0)
/** 当前正在编辑/预览的过渡 id（用于轨迹与播放） */
export const selectedRenderId = ref<string | null>(null)

export function setRender(id: string, render: RenderPayload): void {
  renders.set(id, render)
  renderRevision.value++
}

export function getRender(id: string | null | undefined): RenderPayload | null {
  if (!id) return null
  return renders.get(id) ?? null
}

export function removeRender(id: string): void {
  renders.delete(id)
  if (selectedRenderId.value === id) selectedRenderId.value = null
  renderRevision.value++
}

export function clearRenders(): void {
  renders.clear()
  selectedRenderId.value = null
  renderRevision.value++
}

/** 用持久化产物整体替换（打开项目时） */
export function setRenders(entries: Array<[string, RenderPayload | null]>): void {
  renders.clear()
  for (const [id, r] of entries) if (r) renders.set(id, r)
  renderRevision.value++
}

export function hasAllRenders(ids: string[]): boolean {
  return ids.every((id) => renders.has(id))
}

export function hasRender(id: string): boolean {
  return renders.has(id)
}
