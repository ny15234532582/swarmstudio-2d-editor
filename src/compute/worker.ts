/**
 * 图片计算 Worker：把二值化 / 抽稀这类纯像素运算移出主线程。
 *
 * 大图（几百万像素）的灰度化 + 阈值 + 采样循环如果跑在主线程会明显卡顿；
 * 这里只在 load 时接收一次像素缓冲，之后调参只回传小预览。
 */
import { analyze, buildPreview, generatePoints, type SourceImage } from './imageProcessor'
import type { ComputeRequest, ComputeResponse, PreviewResult } from './protocol'

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
}

const scope = self as unknown as WorkerScope

let source: SourceImage | null = null

function handle(request: ComputeRequest): { result: unknown; transfer?: Transferable[] } {
  switch (request.type) {
    case 'load': {
      source = {
        width: request.width,
        height: request.height,
        data: new Uint8ClampedArray(request.pixels),
      }
      return { result: { width: request.width, height: request.height } }
    }
    case 'render': {
      if (!source) throw new Error('尚未载入图片')
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
      return { result, transfer: [result.preview] }
    }
    case 'generate': {
      if (!source) throw new Error('尚未载入图片')
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
    const response: ComputeResponse = { id: request.id, ok: false, error: (err as Error).message }
    scope.postMessage(response)
  }
}
