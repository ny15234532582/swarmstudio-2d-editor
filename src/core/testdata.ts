/**
 * 测试数据生成：确定性伪随机，保证多次生成结果一致，便于性能复现。
 */
import { createId } from './id'
import type { Point } from './types'

/**
 * mulberry32 —— 32 位确定性伪随机数发生器：同一 seed 必然产出同一序列。
 * 不依赖 Math.random，因此性能测试可复现（同样的点数分布、同样的渲染负载）。
 * 返回闭包，闭包内部维护内部状态 a。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0 // 归一化为无符号 32 位
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0 // 常量取自 Weyl 序列
    let t = Math.imul(a ^ (a >>> 15), 1 | a) // 混淆：异或右移后相乘
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 // 映射到 [0,1)
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
    // z 居中于 0：±depth/2，仅用于保存/导入导出，画布按 XY 显示
    const z = (rand() - 0.5) * depth
    // r/g 随 x/y 渐变（可肉眼确认坐标映射），b 随机
    const r = Math.round((x / width) * 255)
    const g = Math.round((y / height) * 255)
    const b = Math.round(rand() * 255)
    points[i] = { id: createId(), x, y, z, r, g, b }
  }
  return points
}
