/**
 * 图片计算客户端：主线程侧入口。
 *
 * 负责：解码图片（用离屏 canvas 缩到安全尺寸，避免超大图占内存）、
 * 把像素缓冲一次性 transfer 给 Worker、把预览画回主线程。
 */
import type { Point } from '../core/types'
import type { BinarizeParams } from './imageProcessor'
import type { ComputeRequest, ComputeResponse, PreviewResult } from './protocol'

/** 解码时把图片最长边限制在该尺寸内：既控制内存，也相当于一次超采样 */
const MAX_DECODE_SIZE = 1600

export interface LoadedImageInfo {
  width: number
  height: number
  name: string
}

async function decodeToImageData(
  file: File,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(file)
  const ratio = Math.min(1, MAX_DECODE_SIZE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * ratio))
  const height = Math.max(1, Math.round(bitmap.height * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建 canvas 上下文')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  const imageData = ctx.getImageData(0, 0, width, height)
  return { width, height, data: imageData.data }
}

export class ImageComputeClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private nextId = 1

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<ComputeResponse>) => this.onMessage(event.data)
    this.worker.onerror = (event) => {
      const error = new Error(`图片计算 Worker 错误：${event.message || '未知错误'}`)
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
    }
  }

  private onMessage(response: ComputeResponse): void {
    const entry = this.pending.get(response.id)
    if (!entry) return
    this.pending.delete(response.id)
    if (response.ok) entry.resolve(response.result)
    else entry.reject(new Error(response.error))
  }

  private post(request: ComputeRequest, transfer: Transferable[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject })
      this.worker.postMessage(request, transfer)
    })
  }

  /** 解码并载入图片（像素缓冲转移给 Worker） */
  async load(file: File): Promise<LoadedImageInfo> {
    const { width, height, data } = await decodeToImageData(file)
    await this.post(
      { id: this.nextId++, type: 'load', width, height, pixels: data.buffer as ArrayBuffer },
      [data.buffer as ArrayBuffer],
    )
    return { width, height, name: file.name }
  }

  /** 按参数计算预览与点数（不生成完整点位） */
  async render(params: BinarizeParams): Promise<{ info: PreviewResult; image: ImageData }> {
    const result = (await this.post({ id: this.nextId++, type: 'render', params })) as PreviewResult
    const image = new ImageData(
      new Uint8ClampedArray(result.preview),
      result.previewWidth,
      result.previewHeight,
    )
    return { info: result, image }
  }

  /** 生成最终点位 */
  async generate(params: BinarizeParams): Promise<Point[]> {
    return (await this.post({ id: this.nextId++, type: 'generate', params })) as Point[]
  }

  destroy(): void {
    this.worker.terminate()
    this.pending.clear()
  }
}

let singleton: ImageComputeClient | null = null

export function getImageComputeClient(): ImageComputeClient {
  if (!singleton) singleton = new ImageComputeClient()
  return singleton
}
