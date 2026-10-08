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
  /**
   * RGBA，长度 = width * height * 4。
   * 用 Uint8ClampedArray 而非 ArrayBuffer：与 canvas 的 ImageData.data 同类型，
   * 赋值天然按 0~255 截断，省去手动 clamp。
   */
  data: Uint8ClampedArray
}

export interface BinarizeParams {
  /** 二值化阈值 0~255 */
  threshold: number
  /** 反相：深色图案取点 */
  invert: boolean
  /** 目标点数（用于计算抽稀步长） */
  targetPoints: number
  /** 取色方式：source = 取原图像素颜色，fixed = 统一使用 fixedColor */
  colorMode: 'source' | 'fixed'
  /** colorMode 为 fixed 时使用的统一颜色 */
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
    // alpha < 8 视为透明：透明区域不参与取点，避免背景被判成图案
    if (data[o + 3] < 8) continue // 透明像素不入点
    const keep = luma(data[o], data[o + 1], data[o + 2]) >= threshold
    // invert 时取「暗部」为图案（深色线条取点），否则取亮部
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

/**
 * 根据目标点数计算步长：保留像素越多，步长越大。
 *
 * 抽稀在 X/Y 两方向同时跳步，实际点数约为 selectedCount / step²；
 * 反解即得 step = sqrt(selectedCount / targetPoints)。步长下限 1（不做上采样）。
 */
export function computeStep(selectedCount: number, targetPoints: number): number {
  if (selectedCount === 0) return 1
  return Math.max(1, Math.round(Math.sqrt(selectedCount / Math.max(1, targetPoints))))
}

/**
 * 二值化并预演抽稀结果。
 * 返回的 mask 供 generatePoints / buildPreview 复用，避免重复二值化。
 */
export function analyze(src: SourceImage, params: BinarizeParams): MaskAnalysis {
  const mask = buildMask(src, params)
  // 第一遍：统计阈值内像素数，据此推导合适的抽稀步长
  let selectedCount = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) selectedCount++

  const step = computeStep(selectedCount, params.targetPoints)
  // 第二遍：按同一步长预演，得到真正会生成的点数（供 UI 显示）
  let pointCount = 0
  for (let y = 0; y < src.height; y += step) {
    for (let x = 0; x < src.width; x += step) {
      if (mask[y * src.width + x]) pointCount++
    }
  }
  return { mask, selectedCount, step, pointCount }
}

/**
 * 生成点位（含 id 与颜色）。
 *
 * 坐标映射：以图片中心为原点、按「目标世界宽度 / 图片宽度」统一缩放，
 * 使不同分辨率图片生成的图案在世界坐标下尺寸一致；z 恒为 0（画布按 XY 显示）。
 */
export function generatePoints(src: SourceImage, params: BinarizeParams): Point[] {
  const { mask, step } = analyze(src, params)
  const { width, height, data } = src
  // 统一缩放系数：先相对图片中心归零，再乘 scale
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
        // 源色模式：直接取原图像素颜色
        const o = i * 4
        r = data[o]
        g = data[o + 1]
        b = data[o + 2]
      } else {
        // 固定色模式：所有点统一使用主题色
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

/**
 * 生成二值化预览图（最近邻缩放到 maxSize 以内），用于弹窗里实时预览。
 *
 * 用最近邻而非平滑缩放：预览只需表达「保留 / 丢弃」的分布，
 * 平滑插值反而会模糊边界；最近邻实现最简单、速度也最快。
 */
export function buildPreview(
  src: SourceImage,
  mask: Uint8Array,
  maxSize = 320,
): PreviewImage {
  const { width, height } = src
  // 只缩不放：ratio <= 1，保证预览不会超过 maxSize
  const ratio = Math.min(1, maxSize / Math.max(width, height))
  const pw = Math.max(1, Math.round(width * ratio))
  const ph = Math.max(1, Math.round(height * ratio))
  const out = new Uint8ClampedArray(pw * ph * 4)
  for (let y = 0; y < ph; y++) {
    // min 兜底：ratio=1 时浮点误差可能越界，钳到最后一列/行
    const sy = Math.min(height - 1, Math.floor(y / ratio))
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(width - 1, Math.floor(x / ratio))
      const keep = mask[sy * width + sx]
      const o = (y * pw + x) * 4
      // 保留点用主题蓝、丢弃点用画布深色，形成高对比预览
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
