/**
 * 测试数据生成：确定性伪随机，保证多次生成结果一致，便于性能复现。
 */
import { createId } from './id'
import type { Point } from './types'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface GenerateOptions {
  count: number
  seed?: number
  /** 世界坐标范围 */
  width?: number
  height?: number
  depth?: number
}

/**
 * 生成点阵测试数据。颜色随位置渐变，方便肉眼确认渲染与批量改色是否生效。
 */
export function generatePoints(options: GenerateOptions): Point[] {
  const { count, seed = 20260928, width = 1200, height = 800, depth = 200 } = options
  const rand = mulberry32(seed)
  const points: Point[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const x = rand() * width
    const y = rand() * height
    const z = (rand() - 0.5) * depth
    const r = Math.round((x / width) * 255)
    const g = Math.round((y / height) * 255)
    const b = Math.round(rand() * 255)
    points[i] = { id: createId(), x, y, z, r, g, b }
  }
  return points
}
