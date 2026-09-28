/**
 * 图片计算 Worker 的消息协议。
 *
 * 像素数据只在 load 时传一次（transfer 转移所有权），Worker 缓存后，
 * 后续调参只传参数、只回传小尺寸预览，避免反复搬运大图。
 */
import type { BinarizeParams } from './imageProcessor'

export interface PreviewResult {
  selectedCount: number
  pointCount: number
  step: number
  previewWidth: number
  previewHeight: number
  /** 预览图 RGBA，transfer 回来的 ArrayBuffer */
  preview: ArrayBuffer
}

export type ComputeRequest =
  | { id: number; type: 'load'; width: number; height: number; pixels: ArrayBuffer }
  | { id: number; type: 'render'; params: BinarizeParams }
  | { id: number; type: 'generate'; params: BinarizeParams }

export type ComputeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
