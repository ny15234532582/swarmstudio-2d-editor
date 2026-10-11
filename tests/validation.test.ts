import { describe, expect, it } from 'vitest'
import { validateProject, validatePoint, DataValidationError } from '../src/core/validation'

function frame(id = 'f1') {
  return { id, name: '帧', thumbnail: '', width: 10, height: 10, duration: 3 }
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: 'proj_1',
    name: '测试',
    createdAt: 1,
    updatedAt: 2,
    droneCount: 100,
    tracks: [{ id: 't1', name: '轨', clips: [frame()], transitions: [] }],
    points: [{ id: 'a', frameId: 'f1', x: 1, y: 2, z: 3, r: 10, g: 20, b: 30 }],
    ...overrides,
  }
}

describe('validateProject', () => {
  it('接受合法项目', () => {
    const project = validateProject(makeProject())
    expect(project.points).toHaveLength(1)
    expect(project.points[0].z).toBe(3)
    expect(project.droneCount).toBe(100)
    expect(project.tracks[0].clips).toHaveLength(1)
  })

  it('缺少 version 时抛错', () => {
    expect(() => validateProject(makeProject({ version: undefined }))).toThrow(DataValidationError)
  })

  it('版本高于当前支持时抛错', () => {
    expect(() => validateProject(makeProject({ version: 999 }))).toThrow(/高于当前支持版本/)
  })

  it('重复点位 id 抛错', () => {
    const dup = makeProject({
      points: [
        { id: 'a', frameId: 'f1', x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 },
        { id: 'a', frameId: 'f1', x: 1, y: 1, z: 0, r: 0, g: 0, b: 0 },
      ],
    })
    expect(() => validateProject(dup)).toThrow(/重复/)
  })

  it('丢弃指向不存在帧的点位', () => {
    const project = validateProject(
      makeProject({ points: [{ id: 'a', frameId: 'ghost', x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 }] }),
    )
    expect(project.points).toHaveLength(0)
  })
})

describe('validatePoint', () => {
  const base = { id: 'a', frameId: 'f1', x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 }

  it('rgb 越界抛错', () => {
    expect(() => validatePoint({ ...base, r: 256 }, 0)).toThrow(DataValidationError)
  })

  it('坐标非有限值抛错', () => {
    expect(() => validatePoint({ ...base, x: NaN }, 0)).toThrow(/有限数值/)
  })

  it('rgb 非整数抛错', () => {
    expect(() => validatePoint({ ...base, r: 1.5 }, 0)).toThrow(/整数/)
  })

  it('缺少 frameId 抛错', () => {
    expect(() => validatePoint({ id: 'a', x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 }, 0)).toThrow(/frameId/)
  })
})
