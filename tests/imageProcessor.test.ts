import { describe, expect, it } from 'vitest'
import {
  analyze,
  buildMask,
  spacingToStep,
  generatePoints,
  luma,
  type BinarizeParams,
  type SourceImage,
} from '../src/compute/imageProcessor'

/** 用二维颜色数组构造图像：[r,g,b,a] 或 [r,g,b]（默认不透明） */
function image(rows: number[][][]): SourceImage {
  const height = rows.length
  const width = rows[0].length
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = rows[y][x]
      const o = (y * width + x) * 4
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = a
    }
  }
  return { width, height, data }
}

const WHITE: number[] = [255, 255, 255]
const BLACK: number[] = [0, 0, 0]

const base: BinarizeParams = {
  threshold: 128,
  invert: false,
  minSpacing: 1,
  colorMode: 'source',
  fixedColor: { r: 10, g: 20, b: 30 },
  worldWidth: 1200,
}

const sample = image([
  [WHITE, BLACK],
  [BLACK, WHITE],
])

describe('imageProcessor', () => {
  it('luma 按感知权重计算', () => {
    expect(luma(255, 255, 255)).toBeCloseTo(255, 5)
    expect(luma(0, 0, 0)).toBe(0)
  })

  it('二值化掩码：亮像素保留', () => {
    const mask = buildMask(sample, base)
    expect(Array.from(mask)).toEqual([1, 0, 0, 1])
  })

  it('反相后只保留暗像素', () => {
    const mask = buildMask(sample, { ...base, invert: true })
    expect(Array.from(mask)).toEqual([0, 1, 1, 0])
  })

  it('透明像素不入点', () => {
    const transparent = image([[WHITE.slice().concat(0) as number[], BLACK]])
    const mask = buildMask(transparent, base)
    expect(Array.from(mask)).toEqual([0, 0])
  })

  it('坐标按世界宽度居中缩放，z 固定为 0', () => {
    const points = generatePoints(sample, base)
    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({ x: -600, y: -600, z: 0 })
    expect(points[1]).toMatchObject({ x: 0, y: 0, z: 0 })
  })

  it('颜色可取原图或统一色', () => {
    const source = generatePoints(sample, base)
    expect(source[0]).toMatchObject({ r: 255, g: 255, b: 255 })

    const fixed = generatePoints(sample, { ...base, colorMode: 'fixed' })
    expect(fixed[0]).toMatchObject({ r: 10, g: 20, b: 30 })
  })

  it('按最小间距换算步长并向上取整', () => {
    // stepPx = ceil(minSpacing * srcWidth / worldWidth)
    expect(spacingToStep(1200, 1200, 1)).toBe(1)
    expect(spacingToStep(1200, 1200, 2)).toBe(2)
    expect(spacingToStep(1200, 1200, 1.1)).toBe(2) // ceil(1.1) = 2
    // 步长下限为 1（不做上采样）；非法尺寸兜底为 1
    expect(spacingToStep(1200, 1200, 0.1)).toBe(1)
    expect(spacingToStep(0, 1200, 5)).toBe(1)
  })

  it('最小间距越大生成的点越少', () => {
    const full = image([
      [WHITE, WHITE, WHITE, WHITE],
      [WHITE, WHITE, WHITE, WHITE],
      [WHITE, WHITE, WHITE, WHITE],
      [WHITE, WHITE, WHITE, WHITE],
    ])
    const dense = analyze(full, { ...base, minSpacing: 1 })
    const sparse = analyze(full, { ...base, minSpacing: 3000 })
    expect(dense.pointCount).toBe(16)
    expect(dense.step).toBe(1)
    expect(sparse.pointCount).toBe(1)
    expect(sparse.step).toBe(10) // ceil(3000 * 4 / 1200) = 10
  })

  it('生成点的任意两两间距不小于最小间距（世界单位）', () => {
    const full = image(
      Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => WHITE)),
    )
    // worldWidth=1200, 宽 8 → scale=150；minSpacing=200 → step=ceil(200*8/1200)=2
    const params = { ...base, minSpacing: 200 }
    const points = generatePoints(full, params)
    expect(points.length).toBeGreaterThan(0)
    let minDist = Infinity
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].x - points[j].x
        const dy = points[i].y - points[j].y
        minDist = Math.min(minDist, Math.hypot(dx, dy))
      }
    }
    expect(minDist).toBeGreaterThanOrEqual(params.minSpacing)
  })
})
