/**
 * 均匀网格空间索引。
 *
 * 用途：点位数量达到数千后，逐点做命中判断（O(n)）在拖动/框选时不可接受。
 * 用网格把「屏幕点击 → 最近点」和「框选 → 命中点集」降到近似 O(1)。
 *
 * 说明：本索引是从业务数据派生的只读缓存，不属于事实源；
 * 结构化变更（增删/加载/移动提交）后重建即可。
 */
import type { Point, Rect } from './types'

export class SpatialGrid {
  private readonly cellSize: number
  private readonly cells = new Map<number, string[]>()

  constructor(cellSize = 64) {
    this.cellSize = cellSize
  }

  private key(cx: number, cy: number): number {
    // 用 32 位整数打包两个较小区间的网格坐标，避免字符串 key 的内存与哈希开销
    return (cx & 0xffff) * 0x10000 + (cy & 0xffff)
  }

  /**
   * 用当前点集重建索引。O(n)：一次遍历把每个点 id 放进其所在网格。
   * 索引只存 id，不存 Point 引用，避免持有业务对象造成内存泄漏。
   */
  rebuild(points: Point[]): void {
    this.cells.clear()
    for (const p of points) {
      // 世界坐标 → 网格坐标（向下取整，负坐标也正确落入相邻格）
      const cx = Math.floor(p.x / this.cellSize)
      const cy = Math.floor(p.y / this.cellSize)
      const k = this.key(cx, cy)
      let bucket = this.cells.get(k)
      if (!bucket) {
        bucket = []
        this.cells.set(k, bucket)
      }
      bucket.push(p.id)
    }
  }

  /**
   * 查询给定世界坐标半径内可能命中的点 id（粗筛，不做精确距离判断）。
   * 半径先外扩为轴对齐方框覆盖的网格范围，再取这些格里的所有点：
   * 结果是候选超集，调用方仍需做一次精确距离过滤。
   */
  queryCircle(x: number, y: number, radius: number): string[] {
    const result: string[] = []
    const minX = Math.floor((x - radius) / this.cellSize)
    const maxX = Math.floor((x + radius) / this.cellSize)
    const minY = Math.floor((y - radius) / this.cellSize)
    const maxY = Math.floor((y + radius) / this.cellSize)
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const bucket = this.cells.get(this.key(cx, cy))
        if (bucket) result.push(...bucket)
      }
    }
    return result
  }

  /** 查询与矩形相交的网格内所有点 id（框选粗筛，结果为候选超集） */
  queryRect(rect: Rect): string[] {
    const minX = Math.floor(rect.x / this.cellSize)
    const maxX = Math.floor((rect.x + rect.width) / this.cellSize)
    const minY = Math.floor(rect.y / this.cellSize)
    const maxY = Math.floor((rect.y + rect.height) / this.cellSize)
    const result: string[] = []
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const bucket = this.cells.get(this.key(cx, cy))
        if (bucket) result.push(...bucket)
      }
    }
    return result
  }
}
