import { describe, expect, it } from 'vitest'
import { computeBBox, fitProjection, unionBBox } from '../src/render/preview'
import { drawPoints } from '../src/render/previewDraw'

describe('fitProjection', () => {
  it('宽扁包围盒：以宽度为准等比缩放并居中', () => {
    const p = fitProjection({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 72, 72, 6)
    expect(p.scale).toBeCloseTo(0.6)
    expect(p.ox).toBeCloseTo(6)
    expect(p.oy).toBeCloseTo(21)
  })

  it('把包围盒映射进 [pad, size-pad] 内', () => {
    const pad = 6
    const p = fitProjection({ minX: -30, minY: 10, maxX: 70, maxY: 90 }, 72, 72, pad)
    const map = (x: number, y: number) => ({ x: x * p.scale + p.ox, y: y * p.scale + p.oy })
    for (const c of [map(-30, 10), map(70, 10), map(-30, 90), map(70, 90)]) {
      expect(c.x).toBeGreaterThanOrEqual(pad - 1e-6)
      expect(c.x).toBeLessThanOrEqual(72 - pad + 1e-6)
      expect(c.y).toBeGreaterThanOrEqual(pad - 1e-6)
      expect(c.y).toBeLessThanOrEqual(72 - pad + 1e-6)
    }
  })

  it('退化包围盒（单点）：缩放有限、居中', () => {
    const p = fitProjection({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 72, 72, 6)
    expect(Number.isFinite(p.scale)).toBe(true)
    expect(p.scale).toBe(1)
    expect(p.ox).toBeCloseTo(31)
    expect(p.oy).toBeCloseTo(31)
  })
})

describe('computeBBox / unionBBox', () => {
  it('求包围盒并合并', () => {
    const a = computeBBox([
      { x: 0, y: 0, r: 0, g: 0, b: 0 },
      { x: 10, y: 5, r: 0, g: 0, b: 0 },
    ])
    expect(a).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 5 })
    const b = computeBBox([{ x: -2, y: 8, r: 0, g: 0, b: 0 }])
    expect(unionBBox(a, b)).toEqual({ minX: -2, minY: 0, maxX: 10, maxY: 8 })
  })
})

describe('drawPoints', () => {
  it('填充底色并按点绘制（极小点用 1px）', () => {
    let fillRects = 0
    let arcs = 0
    const ctx = {
      fillStyle: '',
      fillRect: () => fillRects++,
      beginPath: () => {},
      arc: () => arcs++,
      fill: () => {},
    }
    const pts = new Float32Array([0, 0, 255, 0, 0, 10, 10, 0, 255, 0, 20, 20, 0, 0, 255])
    drawPoints(ctx as unknown as CanvasRenderingContext2D, {
      w: 64,
      h: 64,
      bg: '#000',
      radius: 0.5,
      count: 3,
      scale: 1,
      ox: 0,
      oy: 0,
      pts,
    })
    expect(fillRects).toBe(4) // 1 底色 + 3 点
    expect(arcs).toBe(0)
  })
})
