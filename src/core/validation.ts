/**
 * 数据校验。用于 OPFS 读取、JSON 导入等所有「外部数据进入系统」的入口。
 * 原则：宁可明确报错，也不让脏数据进入事实源。
 */
import {
  PROJECT_VERSION,
  type EasingKind,
  type Frame,
  type Group,
  type Point,
  type Project,
  type Track,
  type Transition,
  type TransitionAlgorithm,
  type TransitionPath,
  type VelocityProfile,
} from './types'

export class DataValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataValidationError'
  }
}

/** 有限数值校验：排除 NaN / Infinity（JSON 反序列化后仍可能为 null 等非数值） */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 颜色分量校验：0~255 的整数 */
function isByte(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
}

/** 校验并归一化单个点。 */
export function validatePoint(input: unknown, index: number): Point {
  if (typeof input !== 'object' || input === null) {
    throw new DataValidationError(`第 ${index} 个点不是对象`)
  }
  const p = input as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0) {
    throw new DataValidationError(`第 ${index} 个点缺少合法的 id`)
  }
  if (typeof p.frameId !== 'string' || p.frameId.length === 0) {
    throw new DataValidationError(`点 ${p.id} 缺少合法的 frameId`)
  }
  if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) {
    throw new DataValidationError(`点 ${p.id} 的 x/y/z 必须是有限数值`)
  }
  if (!isByte(p.r) || !isByte(p.g) || !isByte(p.b)) {
    throw new DataValidationError(`点 ${p.id} 的 r/g/b 必须是 0~255 的整数`)
  }
  if (p.droneIndex !== undefined && (!Number.isInteger(p.droneIndex) || (p.droneIndex as number) < 0)) {
    throw new DataValidationError(`点 ${p.id} 的 droneIndex 必须是非负整数`)
  }
  if (p.groupId !== undefined && typeof p.groupId !== 'string') {
    throw new DataValidationError(`点 ${p.id} 的 groupId 必须是字符串`)
  }
  if (p.locked !== undefined && typeof p.locked !== 'boolean') {
    throw new DataValidationError(`点 ${p.id} 的 locked 必须是布尔值`)
  }
  const point: Point = { id: p.id, x: p.x, y: p.y, z: p.z, r: p.r, g: p.g, b: p.b, frameId: p.frameId }
  if (p.droneIndex !== undefined) point.droneIndex = p.droneIndex as number
  if (p.groupId !== undefined) point.groupId = p.groupId as string
  if (p.locked === true) point.locked = true
  return point
}

/** 校验并归一化分组；颜色非法时回退到默认蓝。 */
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

function validateFrame(input: unknown, index: number): Frame {
  if (typeof input !== 'object' || input === null) {
    throw new DataValidationError(`第 ${index} 个帧不是对象`)
  }
  const f = input as Record<string, unknown>
  if (typeof f.id !== 'string' || f.id.length === 0) {
    throw new DataValidationError(`第 ${index} 个帧缺少合法的 id`)
  }
  const frame: Frame = {
    id: f.id,
    name: typeof f.name === 'string' ? f.name : '未命名帧',
    thumbnail: typeof f.thumbnail === 'string' ? f.thumbnail : '',
    width: isFiniteNumber(f.width) ? f.width : 0,
    height: isFiniteNumber(f.height) ? f.height : 0,
    duration: isFiniteNumber(f.duration) && f.duration > 0 ? f.duration : 3,
  }
  if (typeof f.source === 'string') frame.source = f.source
  if (typeof f.params === 'object' && f.params !== null) {
    const p = f.params as Record<string, unknown>
    const color = (p.fixedColor ?? {}) as Record<string, unknown>
    frame.params = {
      threshold: isFiniteNumber(p.threshold) ? p.threshold : 128,
      invert: p.invert === true,
      minSpacing: isFiniteNumber(p.minSpacing) && p.minSpacing > 0 ? p.minSpacing : 6,
      colorMode: p.colorMode === 'fixed' ? 'fixed' : 'source',
      fixedColor: {
        r: isByte(color.r) ? color.r : 54,
        g: isByte(color.g) ? color.g : 198,
        b: isByte(color.b) ? color.b : 255,
      },
      worldWidth: isFiniteNumber(p.worldWidth) && p.worldWidth > 0 ? p.worldWidth : 1200,
    }
  }
  return frame
}

const ALGORITHMS: TransitionAlgorithm[] = ['index', 'nearest', 'hungarian', 'auction', 'bottleneck']
const PATHS: TransitionPath[] = ['linear', 'arc', 'bezier']
const PROFILES: VelocityProfile[] = ['linear', 'ease', 'trapezoid', 'minJerk']
const EASINGS: EasingKind[] = ['linear', 'easeInOut', 'easeIn', 'easeOut']

function validateTransition(input: unknown, index: number): Transition {
  if (typeof input !== 'object' || input === null) {
    throw new DataValidationError(`第 ${index} 个过渡不是对象`)
  }
  const t = input as Record<string, unknown>
  if (typeof t.id !== 'string' || typeof t.fromFrameId !== 'string' || typeof t.toFrameId !== 'string') {
    throw new DataValidationError(`第 ${index} 个过渡缺少 id / fromFrameId / toFrameId`)
  }
  const params: Record<string, number> = {}
  if (typeof t.params === 'object' && t.params !== null) {
    for (const [k, v] of Object.entries(t.params as Record<string, unknown>)) {
      if (isFiniteNumber(v)) params[k] = v
    }
  }
  // 兼容旧数据：optimal → hungarian
  const rawAlgo = t.algorithm === 'optimal' ? 'hungarian' : t.algorithm
  return {
    id: t.id,
    fromFrameId: t.fromFrameId,
    toFrameId: t.toFrameId,
    duration: isFiniteNumber(t.duration) && t.duration > 0 ? t.duration : 2,
    algorithm: ALGORITHMS.includes(rawAlgo as TransitionAlgorithm)
      ? (rawAlgo as TransitionAlgorithm)
      : 'nearest',
    path: PATHS.includes(t.path as TransitionPath) ? (t.path as TransitionPath) : 'linear',
    velocityProfile: PROFILES.includes(t.velocityProfile as VelocityProfile)
      ? (t.velocityProfile as VelocityProfile)
      : 'ease',
    easing: EASINGS.includes(t.easing as EasingKind) ? (t.easing as EasingKind) : 'easeInOut',
    stagger: isFiniteNumber(t.stagger) && t.stagger > 0 ? t.stagger : 0,
    params,
  }
}

function validateTrack(input: unknown, index: number): Track {
  if (typeof input !== 'object' || input === null) {
    throw new DataValidationError(`第 ${index} 条轨道不是对象`)
  }
  const t = input as Record<string, unknown>
  const clips = Array.isArray(t.clips) ? t.clips.map((c, i) => validateFrame(c, i)) : []
  const frameIds = new Set(clips.map((c) => c.id))
  const transitions = (Array.isArray(t.transitions) ? t.transitions : [])
    .map((x, i) => validateTransition(x, i))
    // 丢弃指向不存在帧的过渡，避免孤儿引用
    .filter((tr) => frameIds.has(tr.fromFrameId) && frameIds.has(tr.toFrameId))
  return {
    id: typeof t.id === 'string' && t.id.length > 0 ? t.id : `trk_${index}`,
    name: typeof t.name === 'string' ? t.name : `轨道 ${index + 1}`,
    clips,
    transitions,
  }
}

/**
 * 校验整个项目。
 * 版本策略：高于当前版本明确报错，防止新版字段被旧应用静默丢弃。
 */
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
  const tracks = (Array.isArray(raw.tracks) ? raw.tracks : []).map((t, i) => validateTrack(t, i))
  const frameIds = new Set(tracks.flatMap((t) => t.clips.map((c) => c.id)))

  if (!Array.isArray(raw.points)) {
    throw new DataValidationError('项目 points 必须是数组')
  }
  const seen = new Set<string>()
  const points: Point[] = []
  raw.points.forEach((item, i) => {
    const point = validatePoint(item, i)
    if (seen.has(point.id)) throw new DataValidationError(`存在重复的点位 id: ${point.id}`)
    seen.add(point.id)
    // 丢弃指向不存在帧的点，避免孤儿数据
    if (!frameIds.has(point.frameId)) return
    points.push(point)
  })

  const groups: Group[] = Array.isArray(raw.groups)
    ? raw.groups.map((item, i) => validateGroup(item, i))
    : []
  const groupIds = new Set(groups.map((g) => g.id))
  for (const point of points) {
    if (point.groupId && !groupIds.has(point.groupId)) delete point.groupId
  }

  return {
    version: PROJECT_VERSION,
    id: raw.id,
    name: raw.name,
    createdAt: isFiniteNumber(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : Date.now(),
    droneCount:
      Number.isInteger(raw.droneCount) && (raw.droneCount as number) > 0 ? (raw.droneCount as number) : 1000,
    droneLimits: validateDroneLimits(raw.droneLimits),
    tracks: tracks.length > 0 ? tracks : [{ id: 'trk_default', name: '轨道 1', clips: [], transitions: [] }],
    points,
    groups,
  }
}

/** 归一化无人机能力上限；非数值或 ≤0 视为「不限制」 */
function validateDroneLimits(input: unknown): { maxSpeed: number; maxAccel: number } {
  const d = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const maxSpeed = isFiniteNumber(d.maxSpeed) && d.maxSpeed > 0 ? d.maxSpeed : 0
  const maxAccel = isFiniteNumber(d.maxAccel) && d.maxAccel > 0 ? d.maxAccel : 0
  return { maxSpeed, maxAccel }
}
