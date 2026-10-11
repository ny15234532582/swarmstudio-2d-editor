/**
 * 核心业务数据类型定义。
 *
 * 设计原则：这里定义的是「项目事实源」的数据结构，与渲染层 / 界面层无关。
 * 项目 = 时间线：由若干轨道组成，每个轨道是一串「帧片段」+ 片段之间的过渡。
 */

/** 单个点位。x/y/z 为业务坐标，z 只做保存/导入导出，画布按 XY 显示。 */
export interface Point {
  id: string
  x: number
  y: number
  z: number
  r: number
  g: number
  b: number
  /** 所属帧 id（点位归属于时间线上的某一帧片段） */
  frameId: string
  /** 该点使用的无人机编号 0..droneCount-1（帧内唯一；缺省表示未显式分配） */
  droneIndex?: number
  /** 所属分组 id（可选，指向 Project.groups） */
  groupId?: string
  /** 锁定后不可被选中 / 拖动 / 删除 / 改色，避免误操作 */
  locked?: boolean
}

/** RGB 颜色，各通道 0~255 整数。 */
export interface RGB {
  r: number
  g: number
  b: number
}

/** 点位分组。锁定打在点上（组锁定 = 批量锁定组内点），因此组本身不重复存锁定态。 */
export interface Group {
  id: string
  name: string
  /** 组的标识色，仅用于列表展示 */
  color: RGB
}

/** 时间轴上的一个帧片段（对应一张导入图片）。 */
export interface Frame {
  id: string
  name: string
  /** 缩略图 data URL，随项目持久化 */
  thumbnail: string
  /** 原图解码尺寸 */
  width: number
  height: number
  /** 在该帧停留的时长（秒） */
  duration: number
  /** 降采样源图 data URL（最大边 ≤1600），用于重新编辑采样参数时重放二值化 */
  source?: string
  /** 生成该帧时使用的采样参数快照，供编辑弹窗回填 */
  params?: FrameParams
}

/** 帧的图片采样参数（BinarizeParams 的可持久化子集；maxPoints 由项目 droneCount 决定，不入库） */
export interface FrameParams {
  threshold: number
  invert: boolean
  minSpacing: number
  colorMode: 'source' | 'fixed'
  fixedColor: RGB
  worldWidth: number
}

/** 帧间点位分配算法（谁飞向谁）。 */
export type TransitionAlgorithm = 'index' | 'nearest' | 'hungarian' | 'auction' | 'bottleneck'
/** 点位运动轨迹（空间形状）。 */
export type TransitionPath = 'linear' | 'arc' | 'bezier'
/** 时间速度剖面（如何加速）。 */
export type VelocityProfile = 'linear' | 'ease' | 'trapezoid' | 'minJerk'
/** 时间缓动（velocityProfile 为 ease 时使用）。 */
export type EasingKind = 'linear' | 'easeInOut' | 'easeIn' | 'easeOut'

/** 两个相邻帧之间的过渡（独立插入，占用自己的时间）。 */
export interface Transition {
  id: string
  fromFrameId: string
  toFrameId: string
  /** 基础过渡时长（秒） */
  duration: number
  /** 分配算法 */
  algorithm: TransitionAlgorithm
  /** 空间路径 */
  path: TransitionPath
  /** 速度剖面 */
  velocityProfile: VelocityProfile
  /** 缓动（velocityProfile = 'ease' 时生效） */
  easing: EasingKind
  /** 总错峰时长（秒）：点按顺序错开出发，形成波浪/拖尾；0 表示同时出发 */
  stagger: number
  /** 各层参数：curvature（弧线曲率）、epsilon（拍卖）、accelRatio（梯形）等 */
  params: Record<string, number>
}

/** 无人机运动能力上限（项目级）。0 或缺省表示不限制。 */
export interface DroneLimits {
  /** 最大速度（世界单位/秒） */
  maxSpeed?: number
  /** 最大加速度（世界单位/秒²） */
  maxAccel?: number
}

/** 一条轨道：一串帧片段 + 它们之间的过渡。当前项目只用一条。 */
export interface Track {
  id: string
  name: string
  clips: Frame[]
  transitions: Transition[]
}

/** 项目元信息与数据。version 用于后续数据格式迁移。 */
export interface Project {
  /** 数据格式版本，迁移依据 */
  version: number
  /** 项目唯一 id（也是 OPFS 目录名） */
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** 固定无人机总数 N（每帧只用其中一部分） */
  droneCount: number
  /** 无人机运动能力上限（项目级，供过渡校验/提示） */
  droneLimits?: DroneLimits
  tracks: Track[]
  /** 全项目扁平点位（用 Point.frameId 归属到具体帧） */
  points: Point[]
  /** 全项目分组（点位可选归属） */
  groups: Group[]
}

/** 当前支持的项目数据版本。 */
export const PROJECT_VERSION = 3

/** 项目列表项（不加载完整点位，便于列表展示） */
export interface ProjectMeta {
  id: string
  name: string
  version: number
  pointCount: number
  createdAt: number
  updatedAt: number
}

/** 位置更新，用于拖动/移动的增量更新 */
export interface PositionUpdate {
  id: string
  x: number
  y: number
}

/** 世界坐标下的矩形，用于框选 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Vec2 {
  x: number
  y: number
}

/** 创建点位时除 id 外的字段（frameId 必填） */
export type PointInit = Omit<Point, 'id'>
