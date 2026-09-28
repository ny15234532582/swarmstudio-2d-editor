/**
 * 数据校验。用于 OPFS 读取、JSON 导入等所有「外部数据进入系统」的入口。
 * 原则：宁可明确报错，也不让脏数据进入事实源。
 */
import { PROJECT_VERSION, type Group, type Point, type Project } from './types'

export class DataValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataValidationError'
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isByte(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
}

export function validatePoint(input: unknown, index: number): Point {
  if (typeof input !== 'object' || input === null) {
    throw new DataValidationError(`第 ${index} 个点不是对象`)
  }
  const p = input as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0) {
    throw new DataValidationError(`第 ${index} 个点缺少合法的 id`)
  }
  if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) {
    throw new DataValidationError(`点 ${p.id} 的 x/y/z 必须是有限数值`)
  }
  if (!isByte(p.r) || !isByte(p.g) || !isByte(p.b)) {
    throw new DataValidationError(`点 ${p.id} 的 r/g/b 必须是 0~255 的整数`)
  }
  if (p.groupId !== undefined && typeof p.groupId !== 'string') {
    throw new DataValidationError(`点 ${p.id} 的 groupId 必须是字符串`)
  }
  if (p.locked !== undefined && typeof p.locked !== 'boolean') {
    throw new DataValidationError(`点 ${p.id} 的 locked 必须是布尔值`)
  }
  const point: Point = {
    id: p.id,
    x: p.x,
    y: p.y,
    z: p.z,
    r: p.r,
    g: p.g,
    b: p.b,
  }
  if (p.groupId !== undefined) point.groupId = p.groupId as string
  if (p.locked === true) point.locked = true
  return point
}

export function validateGroup(input: unknown, index: number): Group {
  if (typeof input !== 'object' || input === null) {
    throw new DataValidationError(`第 ${index} 个分组不是对象`)
  }
  const g = input as Record<string, unknown>
  if (typeof g.id !== 'string' || g.id.length === 0) {
    throw new DataValidationError(`第 ${index} 个分组缺少合法的 id`)
  }
  if (typeof g.name !== 'string') {
    throw new DataValidationError(`分组 ${g.id} 缺少 name`)
  }
  const color = (g.color ?? {}) as Record<string, unknown>
  return {
    id: g.id,
    name: g.name,
    color: {
      r: isByte(color.r) ? color.r : 54,
      g: isByte(color.g) ? color.g : 198,
      b: isByte(color.b) ? color.b : 255,
    },
  }
}

export function validateProject(input: unknown): Project {
  if (typeof input !== 'object' || input === null) {
    throw new DataValidationError('项目数据不是对象')
  }
  const raw = input as Record<string, unknown>
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new DataValidationError('项目缺少合法的 version 字段')
  }
  if (raw.version > PROJECT_VERSION) {
    throw new DataValidationError(
      `项目数据版本 ${raw.version} 高于当前支持版本 ${PROJECT_VERSION}，请升级应用后再打开`,
    )
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new DataValidationError('项目缺少合法的 id')
  }
  if (typeof raw.name !== 'string') {
    throw new DataValidationError('项目缺少 name')
  }
  if (!Array.isArray(raw.points)) {
    throw new DataValidationError('项目 points 必须是数组')
  }
  const seen = new Set<string>()
  const points = raw.points.map((item, i) => {
    const point = validatePoint(item, i)
    if (seen.has(point.id)) {
      throw new DataValidationError(`存在重复的点位 id: ${point.id}`)
    }
    seen.add(point.id)
    return point
  })
  // v1 项目没有 groups 字段，这里按空数组归一化（即内存中的数据格式迁移）
  const groups: Group[] = Array.isArray(raw.groups)
    ? raw.groups.map((item, i) => validateGroup(item, i))
    : []
  const groupIds = new Set(groups.map((g) => g.id))
  for (const point of points) {
    // 丢弃指向不存在分组的 groupId，避免出现孤儿引用
    if (point.groupId && !groupIds.has(point.groupId)) delete point.groupId
  }
  return {
    version: PROJECT_VERSION,
    id: raw.id,
    name: raw.name,
    createdAt: isFiniteNumber(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : Date.now(),
    points,
    groups,
  }
}
