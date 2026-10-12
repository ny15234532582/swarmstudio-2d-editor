/**
 * 缩略图绘点（Worker 与主线程回退共用，避免重复实现）。
 * 输入交错数组 pts = [x, y, r, g, b] × count。
 */
export interface PreviewDrawReq {
  w: number
  h: number
  bg: string
  radius: number
  count: number
  scale: number
  ox: number
  oy: number
  pts: Float32Array
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export function drawPoints(ctx: Ctx2D, req: PreviewDrawReq): void {
  const { w, h, bg, radius, count, scale, ox, oy, pts } = req
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  const r = Math.max(0.5, radius)
  for (let i = 0; i < count; i++) {
    const o = i * 5
    const x = pts[o] * scale + ox
    const y = pts[o + 1] * scale + oy
    if (x < -r || y < -r || x > w + r || y > h + r) continue
    ctx.fillStyle = `rgb(${pts[o + 2] | 0},${pts[o + 3] | 0},${pts[o + 4] | 0})`
    if (r <= 1) {
      ctx.fillRect(x - 0.5, y - 0.5, 1, 1)
    } else {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
