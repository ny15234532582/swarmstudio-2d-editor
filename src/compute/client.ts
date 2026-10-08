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

/**
 * 用 createImageBitmap + 离屏 canvas 解码并等比缩小到安全尺寸。
 * 返回 RGBA 像素（与 SourceImage.data 同布局），供 transfer 给 Worker。
 */
async function decodeToImageData(
  file: File,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(file)
  // 只缩不放：ratio <= 1，最长边不超过 MAX_DECODE_SIZE
  const ratio = Math.min(1, MAX_DECODE_SIZE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * ratio))
  const height = Math.max(1, Math.round(bitmap.height * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  // willReadFrequently：随后要 getImageData 读取像素，提示浏览器用内存后端
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建 canvas 上下文')
  ctx.drawImage(bitmap, 0, 0, width, height)
  // ImageBitmap 占用的是独立的原生内存，画完即可主动释放
  bitmap.close?.()

  const imageData = ctx.getImageData(0, 0, width, height)
  return { width, height, data: imageData.data }
}

export class ImageComputeClient {
  private readonly worker: Worker
  /**
   * 请求 id → Promise 回调。
   * Worker 单线程串行处理，用 id 把异步回包对应回各自的 Promise
   * （相当于手写的 request/response 关联）。
   */
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private nextId = 1

  constructor() {
    // 用模块 URL 起 Worker，支持打包器把 worker.ts 作为独立 chunk 输出
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<ComputeResponse>) => this.onMessage(event.data)
    // Worker 整体崩溃（脚本加载失败等）不会走 onmessage，这里统一 reject 所有挂起请求
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

  /** 发送请求并在 pending 中登记，返回可按 id 解析的 Promise */
  private post(request: ComputeRequest, transfer: Transferable[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject })
      this.worker.postMessage(request, transfer)
    })
  }

  /** 解码并载入图片（像素缓冲转移给 Worker） */
  async load(file: File): Promise<LoadedImageInfo> {
    const { width, height, data } = await decodeToImageData(file)
    // transfer 后 data.buffer 所有权归 Worker，主线程不再持有像素，省一次大内存拷贝
    await this.post(
      { id: this.nextId++, type: 'load', width, height, pixels: data.buffer as ArrayBuffer },
      [data.buffer as ArrayBuffer],
    )
    return { width, height, name: file.name }
  }

  /** 按参数计算预览与点数（不生成完整点位） */
  async render(params: BinarizeParams): Promise<{ info: PreviewResult; image: ImageData }> {
    const result = (await this.post({ id: this.nextId++, type: 'render', params })) as PreviewResult
    // 把 Worker 回传的裸 RGBA buffer 包装成主线程可直接绘制的 ImageData
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
    // terminate 会立即停止 Worker，未完成的请求直接清掉（不再有回包）
    this.worker.terminate()
    this.pending.clear()
  }
}

let singleton: ImageComputeClient | null = null

/**
 * 获取全局单例 Worker 客户端。
 * Worker 启动成本与像素缓存都较重，整个应用共用一个，避免重复解码。
 */
export function getImageComputeClient(): ImageComputeClient {
  if (!singleton) singleton = new ImageComputeClient()
  return singleton
}
