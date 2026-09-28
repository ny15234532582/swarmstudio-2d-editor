/**
 * 视口变换：负责世界坐标 ↔ 屏幕坐标、平移、缩放、适配。
 *
 * 渲染层不重算点位数据，只调整 Pixi 世界容器的 position/scale，
 * 平移与缩放是 O(1) 操作（对应题目 6.4）。
 */
import type { Rect, Vec2 } from '../core/types'

export const MIN_SCALE = 0.02
export const MAX_SCALE = 40

export class Viewport {
  /** 世界原点在屏幕上的位置 */
  x = 0
  y = 0
  /** 缩放系数 */
  scale = 1

  worldToScreen(wx: number, wy: number): Vec2 {
    return { x: wx * this.scale + this.x, y: wy * this.scale + this.y }
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return { x: (sx - this.x) / this.scale, y: (sy - this.y) / this.scale }
  }

  /** 以屏幕上的某个锚点为中心缩放 */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE)
    const applied = next / this.scale
    // 保持锚点对应的世界坐标不动
    this.x = screenX - (screenX - this.x) * applied
    this.y = screenY - (screenY - this.y) * applied
    this.scale = next
  }

  /** 将世界矩形适配到给定的屏幕尺寸 */
  fit(rect: Rect, viewWidth: number, viewHeight: number, padding = 48): void {
    const availW = Math.max(1, viewWidth - padding * 2)
    const availH = Math.max(1, viewHeight - padding * 2)
    const w = rect.width > 0 ? rect.width : 1
    const h = rect.height > 0 ? rect.height : 1
    this.scale = clamp(Math.min(availW / w, availH / h), MIN_SCALE, MAX_SCALE)
    const centerX = rect.x + rect.width / 2
    const centerY = rect.y + rect.height / 2
    this.x = viewWidth / 2 - centerX * this.scale
    this.y = viewHeight / 2 - centerY * this.scale
  }
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}
