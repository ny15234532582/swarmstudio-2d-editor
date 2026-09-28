import { describe, expect, it } from 'vitest'
import { SpatialGrid } from '../src/core/spatial'
import type { Point } from '../src/core/types'

function p(id: string, x: number, y: number): Point {
  return { id, x, y, z: 0, r: 0, g: 0, b: 0 }
}

describe('SpatialGrid', () => {
  const points = [p('a', 10, 10), p('b', 200, 200), p('c', 55, 60)]
  const grid = new SpatialGrid(64)
  grid.rebuild(points)

  it('圆形查询命中附近点', () => {
    const hits = grid.queryCircle(12, 12, 8)
    expect(hits).toContain('a')
    expect(hits).not.toContain('b')
  })

  it('矩形查询命中范围内点', () => {
    const hits = grid.queryRect({ x: 0, y: 0, width: 100, height: 100 })
    expect(hits.sort()).toEqual(['a', 'c'])
  })

  it('空区域返回空数组', () => {
    expect(grid.queryCircle(-500, -500, 5)).toEqual([])
  })
})
