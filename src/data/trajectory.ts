/**
 * 真实轨迹文件（`.jsdm`，Blender 导出的无人机轨迹）解析。
 *
 * 结构：{ name, description, droneTypes, frameCount, planeCount, pointFrames, channelFrames }
 *  - pointFrames: [{ time, points: [{ no, x, y, z }] }]  关键帧位置
 *  - channelFrames: [{ time, channels: [{ no, c1, c2, c3 }] }]  关键帧颜色
 *
 * 映射到我们的工程：每个关键帧 → 一帧；相邻关键帧之间 → 一个过渡。
 * 坐标：文件是 XZ 竖直平面（y=0）→ our.x=file.x, our.y=file.z, our.z=file.y。
 */
import { createId } from '../core/id'
import { createFrame, createProject, createTransition } from '../core/factory'
import type { Point, Project, Track, Transition } from '../core/types'

interface TrajPoint {
  no: number
  x: number
  y: number
  z: number
}
interface TrajFrame {
  time: number
  points: TrajPoint[]
}
interface TrajChannelFrame {
  time: number
  channels: Array<{ no: number; c1: number; c2: number; c3: number }>
}

export interface TrajectoryFile {
  name?: string
  description?: string
  planeCount?: number
  frameCount?: number
  pointFrames: TrajFrame[]
  channelFrames?: TrajChannelFrame[]
}

/** 是否像一份轨迹文件 */
export function isTrajectoryFile(input: unknown): input is TrajectoryFile {
  return (
    !!input &&
    typeof input === 'object' &&
    Array.isArray((input as TrajectoryFile).pointFrames) &&
    (input as TrajectoryFile).pointFrames.length > 0
  )
}

/** 每个关键帧的时长（停留，秒）：取一个小的默认值 */
const HOLD_SECONDS = 0.5
const MIN_TRANSITION_SECONDS = 0.2

/** 把轨迹文件转成我们的 Project（每关键帧一帧，相邻间一个过渡） */
export function trajectoryToProject(traj: TrajectoryFile, name?: string): Project {
  const project = createProject(name || traj.name || '导入的轨迹')
  project.droneCount = traj.planeCount && traj.planeCount > 0 ? traj.planeCount : 3000

  const track: Track = { id: createId('trk'), name: '轨道 1', clips: [], transitions: [] }
  const allPoints: Point[] = []

  traj.pointFrames.forEach((kf, i) => {
    const frame = createFrame(
      `帧 ${i + 1} · t=${(kf.time / 1000).toFixed(1)}s`,
      '',
      0,
      0,
      HOLD_SECONDS,
    )
    track.clips.push(frame)
    const colorByNo = channelFrameColors(traj, i)
    for (const p of kf.points) {
      const c = colorByNo.get(p.no) ?? { r: 255, g: 255, b: 255 }
      allPoints.push({
        id: createId(),
        frameId: frame.id,
        droneIndex: p.no,
        x: p.x,
        // 画布 y 轴向下为正，而轨迹 z 是高度（向上为正）：取反，避免上下镜像
        y: -p.z,
        z: p.y,
        r: c.r,
        g: c.g,
        b: c.b,
      })
    }
  })

  // 相邻关键帧之间的过渡
  for (let i = 0; i + 1 < traj.pointFrames.length; i++) {
    const dt = (traj.pointFrames[i + 1].time - traj.pointFrames[i].time) / 1000
    const tr: Transition = createTransition(track.clips[i].id, track.clips[i + 1].id)
    tr.duration = Math.max(MIN_TRANSITION_SECONDS, dt)
    // 导入轨迹自带稳定编号（no）：默认按索引，忠实还原 no→no
    tr.algorithm = 'index'
    tr.velocityProfile = 'linear'
    tr.easing = 'linear'
    track.transitions.push(tr)
  }

  project.tracks = [track]
  project.points = allPoints
  project.groups = []
  return project
}

/** 某关键帧的 颜色（no → rgb）：按序号对齐 channelFrames，缺失返回空 */
function channelFrameColors(
  traj: TrajectoryFile,
  index: number,
): Map<number, { r: number; g: number; b: number }> {
  const map = new Map<number, { r: number; g: number; b: number }>()
  const cf = traj.channelFrames?.[index]
  if (!cf) return map
  for (const ch of cf.channels) {
    map.set(ch.no, { r: ch.c1, g: ch.c2, b: ch.c3 })
  }
  return map
}
