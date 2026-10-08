/**
 * 纯几何工具（无副作用，可在 Node 单测）。
 * 目前用于「套索选择」：判断点是否落在自由多边形内。
 */
import type { Rect } from './types'

/** 扁平化多边形：[x0,y0,x1,y1,...]，至少 3 个顶点 */
export type Polygon = number[]

/**
 * 射线法（even-odd）：判断点是否在多边形内部。
 *
 * 从点向右发一条水平射线，统计与多少条边相交：奇数次在内部、偶数次在外部。
 * 实现上以顶点 j=i-1 与 i 构成一条边（首尾闭合），只对「边的两端分居
 * 射线上下方」的情形计数，再用交点的 x 是否在点右侧决定是否相交，
 * 从而天然规避水平边和顶点重复计数的问题。
 */
export function pointInPolygon(px: number, py: number, polygon: Polygon): boolean {
  // 顶点数 = 坐标分量数 / 2（用位运算取半）
  const n = polygon.length >> 1
  if (n < 3) return false
  let inside = false
  // j 从最后一个顶点起步，i 从 0 开始，保证最后一条边闭合
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i * 2]
    const yi = polygon[i * 2 + 1]
    const xj = polygon[j * 2]
    const yj = polygon[j * 2 + 1]
    // 条件一：边跨越 py（异或判断两端是否分居上下）；
    // 条件二：交点 x 落在点的右侧
    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** 多边形包围盒，用于空间索引粗筛（先按包围盒排除大部分点，再逐点精确判断） */
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
