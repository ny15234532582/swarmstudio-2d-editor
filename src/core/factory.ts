/**
 * 业务对象工厂：集中构造 Point / Project，保证字段与约束一致。
 */
import { createId, createProjectId } from './id'
import { PROJECT_VERSION, type Group, type Point, type PointInit, type Project } from './types'

/**
 * 由初始化参数构造 Point。id 由工厂统一生成，调用方不传。
 * groupId 可选：仅当显式提供时才写入，避免给普通点留下 undefined 字段。
 */
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

/** 新建空项目：createdAt/updatedAt 取同一时刻，points/groups 初始为空 */
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

/** 分组标识色板：仅用于列表区分，取模循环，因此索引可任意大 */
const GROUP_PALETTE: Array<{ r: number; g: number; b: number }> = [
  { r: 54, g: 198, b: 255 },
  { r: 74, g: 217, b: 145 },
  { r: 240, g: 180, b: 41 },
  { r: 255, g: 107, b: 107 },
  { r: 178, g: 122, b: 255 },
  { r: 255, g: 149, b: 92 },
]

/** 由名称与调色板索引构造分组；索引取模保证始终命中色板 */
export function createGroup(name: string, colorIndex = 0): Group {
  return {
    id: createId('grp'),
    name,
    color: GROUP_PALETTE[colorIndex % GROUP_PALETTE.length],
  }
}
