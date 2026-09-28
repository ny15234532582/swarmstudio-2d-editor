import { describe, expect, it } from 'vitest'
import { pointInPolygon, polygonBounds } from '../src/core/geometry'

// 一个 10x10 的正方形（世界坐标）
const square = [0, 0, 10, 0, 10, 10, 0, 10]

describe('pointInPolygon', () => {
  it('内部点判定为真', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true)
  })

  it('外部点判定为假', () => {
    expect(pointInPolygon(15, 5, square)).toBe(false)
    expect(pointInPolygon(-1, 5, square)).toBe(false)
  })

  it('凹多边形的凹陷区域判定为假', () => {
    // L 形：缺口在右上
    const lShape = [0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10]
    expect(pointInPolygon(2, 8, lShape)).toBe(true) // 竖边内
    expect(pointInPolygon(2, 2, lShape)).toBe(true) // 横边内
    expect(pointInPolygon(8, 8, lShape)).toBe(false) // 缺口
  })

  it('三角形可正确判定', () => {
    const triangle = [0, 0, 10, 0, 0, 10]
    expect(pointInPolygon(1, 1, triangle)).toBe(true)
    expect(pointInPolygon(9, 9, triangle)).toBe(false)
  })

  it('顶点不足 3 个时返回假', () => {
    expect(pointInPolygon(0, 0, [0, 0, 1, 1])).toBe(false)
  })
})

describe('polygonBounds', () => {
  it('返回多边形包围盒', () => {
    expect(polygonBounds([2, 3, 8, 1, 5, 9])).toEqual({ x: 2, y: 1, width: 6, height: 8 })
  })
})
