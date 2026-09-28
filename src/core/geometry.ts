/**
 * 纯几何工具（无副作用，可在 Node 单测）。
 * 目前用于「套索选择」：判断点是否落在自由多边形内。
 */
import type { Rect } from './types'

/** 扁平化多边形：[x0,y0,x1,y1,...]，至少 3 个顶点 */
export type Polygon = number[]

/** 射线法（even-odd）：判断点是否在多边形内部 */
export function pointInPolygon(px: number, py: number, polygon: Polygon): boolean {
  const n = polygon.length >> 1
  if (n < 3) return false
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i * 2]
    const yi = polygon[i * 2 + 1]
    const xj = polygon[j * 2]
    const yj = polygon[j * 2 + 1]
    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** 多边形包围盒，用于空间索引粗筛 */
export function polygonBounds(polygon: Polygon): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < polygon.length; i += 2) {
    const x = polygon[i]
    const y = polygon[i + 1]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
