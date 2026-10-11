/**
 * 图片计算 Worker 的消息协议。
 *
 * 像素数据只在 load 时传一次（transfer 转移所有权），Worker 缓存后，
 * 后续调参只传参数、只回传小尺寸预览，避免反复搬运大图。
 */
import type { BinarizeParams } from './imageProcessor'

/** render 的返回：只回传小预览与统计，不回传完整点位 */
export interface PreviewResult {
  selectedCount: number
  /** 按最小间距采样后预计生成的点数（= 预计无人机数） */
  pointCount: number
  /** 采样步长（像素） */
  step: number
  previewWidth: number
  previewHeight: number
  /** 预览图 RGBA，transfer 回来的 ArrayBuffer */
  preview: ArrayBuffer
}

/**
 * 主线程 → Worker 的请求。
 * 三种请求共用 id 做请求/响应关联；load 的 pixels 通过 transfer 转移所有权。
 */
export type ComputeRequest =
  | { id: number; type: 'load'; width: number; height: number; pixels: ArrayBuffer }
  | { id: number; type: 'render'; params: BinarizeParams }
  | { id: number; type: 'generate'; params: BinarizeParams }

/**
 * Worker → 主线程的响应。
 * 用 ok 判别联合而非异常：成功携带 result（类型由对应请求决定），
 * 失败携带可读 error，主线程据此 reject 对应 Promise。
 */
export type ComputeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
