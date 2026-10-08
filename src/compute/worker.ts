/**
 * 图片计算 Worker：把二值化 / 抽稀这类纯像素运算移出主线程。
 *
 * 大图（几百万像素）的灰度化 + 阈值 + 采样循环如果跑在主线程会明显卡顿；
 * 这里只在 load 时接收一次像素缓冲，之后调参只回传小预览。
 */
import { analyze, buildPreview, generatePoints, type SourceImage } from './imageProcessor'
import type { ComputeRequest, ComputeResponse, PreviewResult } from './protocol'

/**
 * 只声明用到的 self 成员，避免在无 DOM/WebWorker 类型库时污染全局类型。
 */
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
}

const scope = self as unknown as WorkerScope

/** Worker 侧缓存的当前图片；load 之后一直驻留，直到下一次 load 覆盖 */
let source: SourceImage | null = null

/**
 * 同步处理一条请求。
 * 返回值可选带 transfer 列表：预览缓冲通过所有权转移回主线程，避免拷贝。
 */
function handle(request: ComputeRequest): { result: unknown; transfer?: Transferable[] } {
  switch (request.type) {
    case 'load': {
      // 复制一份像素：request.pixels 的所有权虽已转移进来，但转成
      // Uint8ClampedArray 视图后可被 analyze/buildPreview 直接使用，
      // 也避免后续请求复用到已被回收的 ArrayBuffer。
      source = {
        width: request.width,
        height: request.height,
        data: new Uint8ClampedArray(request.pixels),
      }
      return { result: { width: request.width, height: request.height } }
    }
    case 'render': {
      if (!source) throw new Error('尚未载入图片')
      // 调参时只做一次 analyze，mask 同时喂给预览与计数
      const { mask, selectedCount, step, pointCount } = analyze(source, request.params)
      const preview = buildPreview(source, mask)
      const result: PreviewResult = {
        selectedCount,
        pointCount,
        step,
        previewWidth: preview.width,
        previewHeight: preview.height,
        preview: preview.data.buffer as ArrayBuffer,
      }
      // 预览 buffer 转移所有权回主线程（这里之后不再使用它）
      return { result, transfer: [result.preview] }
    }
    case 'generate': {
      if (!source) throw new Error('尚未载入图片')
      // 最终点位数据量可能很大，用结构化克隆回传（点对象是一般数据）
      return { result: generatePoints(source, request.params) }
    }
  }
}

scope.onmessage = (event: MessageEvent) => {
  const request = event.data as ComputeRequest
  try {
    const { result, transfer } = handle(request)
    const response: ComputeResponse = { id: request.id, ok: true, result }
    scope.postMessage(response, transfer ?? [])
  } catch (err) {
    // 异常通过协议回传而不是抛出，让主线程的 Promise 能对应 id 地 reject
    const response: ComputeResponse = { id: request.id, ok: false, error: (err as Error).message }
    scope.postMessage(response)
  }
}
