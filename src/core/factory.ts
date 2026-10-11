/**
 * 业务对象工厂：集中构造 Point / Frame / Transition / Track / Project，
 * 保证字段与约束一致。
 */
import { createId, createProjectId } from './id'
import {
  PROJECT_VERSION,
  type EasingKind,
  type Frame,
  type FrameParams,
  type Group,
  type Point,
  type PointInit,
  type Project,
  type Track,
  type Transition,
  type TransitionAlgorithm,
  type TransitionPath,
} from './types'

/** 默认项目无人机总数 */
export const DEFAULT_DRONE_COUNT = 1000
/** 新帧默认停留时长（秒） */
export const DEFAULT_FRAME_DURATION = 3
/** 新过渡默认时长（秒） */
export const DEFAULT_TRANSITION_DURATION = 2

/**
 * 由初始化参数构造 Point。id 由工厂统一生成，调用方不传。
 * 可选字段（droneIndex/groupId/locked）仅在显式提供时才写入。
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
    frameId: init.frameId,
  }
  if (init.droneIndex !== undefined) point.droneIndex = init.droneIndex
  if (init.groupId !== undefined) point.groupId = init.groupId
  if (init.locked !== undefined) point.locked = init.locked
  return point
}

/** 由导入图片构造帧片段 */
export function createFrame(
  name: string,
  thumbnail: string,
  width: number,
  height: number,
  duration = DEFAULT_FRAME_DURATION,
  source?: string,
  params?: FrameParams,
): Frame {
  const frame: Frame = { id: createId('frm'), name, thumbnail, width, height, duration }
  if (source !== undefined) frame.source = source
  if (params !== undefined) frame.params = params
  return frame
}

/** 构造帧间过渡（默认均衡·瓶颈分配 + 直线 + 缓动剖面，同时出发） */
export function createTransition(fromFrameId: string, toFrameId: string): Transition {
  return {
    id: createId('trx'),
    fromFrameId,
    toFrameId,
    duration: DEFAULT_TRANSITION_DURATION,
    algorithm: 'bottleneck' as TransitionAlgorithm,
    path: 'linear' as TransitionPath,
    velocityProfile: 'ease',
    easing: 'easeInOut' as EasingKind,
    stagger: 0,
    params: {},
  }
}

/** 新建空轨道 */
export function createTrack(name = '轨道 1'): Track {
  return { id: createId('trk'), name, clips: [], transitions: [] }
}

/** 新建空项目：含一条轨道，并预置一个空帧（便于直接编辑；首次导入图片时会替换它） */
export function createProject(name: string): Project {
  const now = Date.now()
  const track = createTrack()
  track.clips.push(createFrame('帧 1', '', 0, 0))
  return {
    version: PROJECT_VERSION,
    id: createProjectId(),
    name,
    createdAt: now,
    updatedAt: now,
    droneCount: DEFAULT_DRONE_COUNT,
    droneLimits: { maxSpeed: 0, maxAccel: 0 },
    tracks: [track],
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
