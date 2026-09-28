/**
 * 业务对象工厂：集中构造 Point / Project，保证字段与约束一致。
 */
import { createId, createProjectId } from './id'
import { PROJECT_VERSION, type Point, type PointInit, type Project } from './types'

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
  }
}
