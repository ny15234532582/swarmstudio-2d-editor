/**
 * 时间线缩略图（胶片条）：把点云按 XY 投影画成小图。
 *
 * 同步在离屏 canvas 上绘制（点固定 1 像素），带 LRU 缓存；
 * 不做超采样、不做 Worker——保证每个片段都能出图且点足够小。
 */
import { drawPoints } from './previewDraw'

/** 最简点结构（世界坐标 + RGB） */
export interface PreviewPoint {
  x: number
  y: number
  r: number
  g: number
  b: number
  alpha?: number
}

export interface Projection {
  scale: number
  ox: number
  oy: number
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 计算把世界包围盒等比适配进 w×h 的投影（纯函数，可单测） */
export function fitProjection(bbox: BBox, w: number, h: number, pad: number): Projection {
  const bw = bbox.maxX - bbox.minX
  const bh = bbox.maxY - bbox.minY
  const availW = Math.max(1, w - 2 * pad)
  const availH = Math.max(1, h - 2 * pad)
  const sw = bw > 1e-9 ? availW / bw : Infinity
  const sh = bh > 1e-9 ? availH / bh : Infinity
  let scale = Math.min(sw, sh)
  if (!Number.isFinite(scale)) scale = 1
  const ox = (w - (bbox.minX + bbox.maxX) * scale) / 2
  const oy = (h - (bbox.minY + bbox.maxY) * scale) / 2
  return { scale, ox, oy }
}

/** 求点位包围盒 */
export function computeBBox(points: PreviewPoint[]): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

/** 合并两个包围盒 */
export function unionBBox(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

/** 打包成交错数组 [x,y,r,g,b] × n */
export function packPoints(points: PreviewPoint[]): Float32Array {
  const out = new Float32Array(points.length * 5)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const o = i * 5
    out[o] = p.x
    out[o + 1] = p.y
    out[o + 2] = p.r
    out[o + 3] = p.g
    out[o + 4] = p.b
  }
  return out
}

// ------------------------------------------------------------ 缓存 + 渲染

const CACHE_CAP = 300
const cache = new Map<string, string>()
const order: string[] = []

/** 命中缓存直接返回，否则调用 makePoints 采样并渲染 */
export function renderThumbnail(
  key: string,
  makePoints: () => PreviewPoint[],
  bbox: BBox,
  w: number,
  h: number,
): string {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const points = makePoints()
  const proj = fitProjection(bbox, w, h, Math.max(2, h * 0.06))
  drawPoints(ctx, {
    w,
    h,
    bg: '#0b0e13',
    radius: 0.5, // 固定 1 像素：缩略图里点要小
    count: points.length,
    scale: proj.scale,
    ox: proj.ox,
    oy: proj.oy,
    pts: packPoints(points),
  })
  const url = canvas.toDataURL('image/png')
  cache.set(key, url)
  order.push(key)
  while (order.length > CACHE_CAP) {
    const k = order.shift()!
    cache.delete(k)
  }
  return url
}

/** 清空缩略图缓存（数据结构变更后调用） */
export function clearThumbnailCache(): void {
  cache.clear()
  order.length = 0
}
