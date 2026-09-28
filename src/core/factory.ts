/**
 * 业务对象工厂：集中构造 Point / Project，保证字段与约束一致。
 */
import { createId, createProjectId } from './id'
import { PROJECT_VERSION, type Group, type Point, type PointInit, type Project } from './types'

export function createPoint(init: PointInit): Point {
  const point: Point = {
    id: createId(),
    x: init.x,
    y: init.y,
    z: init.z,
    r: init.r,
    g: init.g,
    b: init.b,
  }
  if (init.groupId !== undefined) point.groupId = init.groupId
  return point
}

export function createProject(name: string): Project {
  const now = Date.now()
  return {
    version: PROJECT_VERSION,
    id: createProjectId(),
    name,
    createdAt: now,
    updatedAt: now,
    points: [],
    groups: [],
  }
}

const GROUP_PALETTE: Array<{ r: number; g: number; b: number }> = [
  { r: 54, g: 198, b: 255 },
  { r: 74, g: 217, b: 145 },
  { r: 240, g: 180, b: 41 },
  { r: 255, g: 107, b: 107 },
  { r: 178, g: 122, b: 255 },
  { r: 255, g: 149, b: 92 },
]

export function createGroup(name: string, colorIndex = 0): Group {
  return {
    id: createId('grp'),
    name,
    color: GROUP_PALETTE[colorIndex % GROUP_PALETTE.length],
  }
}
