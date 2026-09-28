/**
 * 图片 → 点阵 的纯计算核心（不依赖 DOM / Worker，可在 Node 单测）。
 *
 * 流程：
 *   1. 灰度化：按 luma 权重把 RGB 转成亮度；
 *   2. 二值化：亮度 >= 阈值 记为「保留」，可反相；透明像素丢弃；
 *   3. 抽稀采样：按目标点数计算网格步长，只保留网格上的点；
 *   4. 坐标映射：像素坐标 → 居中、缩放到目标世界宽度的点坐标（z = 0）。
 *
 * 颜色可取自原图像素，或统一为主题色。
 */
import { createId } from '../core/id'
import type { Point, RGB } from '../core/types'

export interface SourceImage {
  width: number
  height: number
  /** RGBA，长度 = width * height * 4 */
  data: Uint8ClampedArray
}

export interface BinarizeParams {
  /** 二值化阈值 0~255 */
  threshold: number
  /** 反相：深色图案取点 */
  invert: boolean
  /** 目标点数（用于计算抽稀步长） */
  targetPoints: number
  colorMode: 'source' | 'fixed'
  fixedColor: RGB
  /** 生成点位横向跨度（世界坐标） */
  worldWidth: number
}

export const DEFAULT_BINARIZE_PARAMS: BinarizeParams = {
  threshold: 128,
  invert: false,
  targetPoints: 20000,
  colorMode: 'source',
  fixedColor: { r: 54, g: 198, b: 255 },
  worldWidth: 1200,
}

/** 感知亮度（Rec. 601） */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** 二值化掩码：1 = 保留，0 = 丢弃 */
export function buildMask(src: SourceImage, params: BinarizeParams): Uint8Array {
  const { width, height, data } = src
  const mask = new Uint8Array(width * height)
  const threshold = params.threshold
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4
    if (data[o + 3] < 8) continue // 透明像素不入点
    const keep = luma(data[o], data[o + 1], data[o + 2]) >= threshold
    if (params.invert ? !keep : keep) mask[i] = 1
  }
  return mask
}

export interface MaskAnalysis {
  mask: Uint8Array
  /** 二值化后保留的像素数 */
  selectedCount: number
  /** 抽样步长 */
  step: number
  /** 抽稀后实际会生成的点数 */
  pointCount: number
}

/** 根据目标点数计算步长：保留像素越多，步长越大 */
export function computeStep(selectedCount: number, targetPoints: number): number {
  if (selectedCount === 0) return 1
  return Math.max(1, Math.round(Math.sqrt(selectedCount / Math.max(1, targetPoints))))
}

export function analyze(src: SourceImage, params: BinarizeParams): MaskAnalysis {
  const mask = buildMask(src, params)
  let selectedCount = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) selectedCount++

  const step = computeStep(selectedCount, params.targetPoints)
  let pointCount = 0
  for (let y = 0; y < src.height; y += step) {
    for (let x = 0; x < src.width; x += step) {
      if (mask[y * src.width + x]) pointCount++
    }
  }
  return { mask, selectedCount, step, pointCount }
}

/** 生成点位（含 id 与颜色） */
export function generatePoints(src: SourceImage, params: BinarizeParams): Point[] {
  const { mask, step } = analyze(src, params)
  const { width, height, data } = src
  const scale = params.worldWidth / width
  const cx = width / 2
  const cy = height / 2
  const points: Point[] = []

  for (let y = 0; y < height; y += step) {
    const rowOffset = y * width
    for (let x = 0; x < width; x += step) {
      const i = rowOffset + x
      if (!mask[i]) continue
      let r: number
      let g: number
      let b: number
      if (params.colorMode === 'source') {
        const o = i * 4
        r = data[o]
        g = data[o + 1]
        b = data[o + 2]
      } else {
        r = params.fixedColor.r
        g = params.fixedColor.g
        b = params.fixedColor.b
      }
      points.push({
        id: createId(),
        x: (x - cx) * scale,
        y: (y - cy) * scale,
        z: 0,
        r,
        g,
        b,
      })
    }
  }
  return points
}

export interface PreviewImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** 生成二值化预览图（最近邻缩放到 maxSize 以内），用于弹窗里实时预览 */
export function buildPreview(
  src: SourceImage,
  mask: Uint8Array,
  maxSize = 320,
): PreviewImage {
  const { width, height } = src
  const ratio = Math.min(1, maxSize / Math.max(width, height))
  const pw = Math.max(1, Math.round(width * ratio))
  const ph = Math.max(1, Math.round(height * ratio))
  const out = new Uint8ClampedArray(pw * ph * 4)
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(height - 1, Math.floor(y / ratio))
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(width - 1, Math.floor(x / ratio))
      const keep = mask[sy * width + sx]
      const o = (y * pw + x) * 4
      if (keep) {
        out[o] = 54
        out[o + 1] = 198
        out[o + 2] = 255
      } else {
        out[o] = 17
        out[o + 1] = 21
        out[o + 2] = 28
      }
      out[o + 3] = 255
    }
  }
  return { width: pw, height: ph, data: out }
}
