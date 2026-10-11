/**
 * EditorStore —— 编辑器的运行时事实源（Single Source of Truth）。
 *
 * 职责边界：
 * - 持有 project 业务数据（普通对象，非响应式，避免大量点的代理开销）。
 *   项目 = 时间线：tracks（当前 1 条）/ 每轨的帧片段与过渡 + 扁平点位 + 分组。
 * - 维护 id → Point / Group / Frame / Transition 索引与空间网格缓存（派生数据）。
 * - 维护 selection 选中状态与 activeFrameId（界面临时状态，不属于项目数据）。
 * - 对外广播渲染事件（points:* / selection:* / activeFrame:change）、结构事件
 *   （frames:change / transitions:change）与 mutation 流（已提交的数据变更）。
 * - 所有可撤销操作都被归一化为 core/operations 的 Operation。
 */
import { Emitter } from './emitter'
import { HistoryManager } from './history'
import { SpatialGrid } from '../core/spatial'
import { createGroup, createPoint, createTransition } from '../core/factory'
import type {
  GroupEntry,
  LockEntry,
  MoveEntry,
  Mutation,
  Operation,
  OperationContext,
} from '../core/operations'
import type {
  Frame,
  FrameParams,
  Group,
  Point,
  PointInit,
  PositionUpdate,
  Project,
  RGB,
  Transition,
} from '../core/types'

export type EditorEvents = {
  'project:load': undefined
  'meta:change': undefined
  'points:add': { ids: string[] }
  'points:remove': { ids: string[] }
  'points:move': { ids: string[] }
  'points:color': { ids: string[] }
  /** 锁定状态变化（渲染层据此调整明暗） */
  'points:lock': { ids: string[] }
  /** 分组结构 / 归属变化（UI 列表据此刷新） */
  'groups:change': undefined
  /** 帧片段结构变化（增删 / 排序 / 时长 / 缩略图） */
  'frames:change': undefined
  /** 过渡结构变化 */
  'transitions:change': undefined
  /** 当前显示帧切换（渲染层据此重建） */
  'activeFrame:change': undefined
  'selection:change': undefined
  'history:change': undefined
  /** 已提交的数据变更（用于持久化） */
  'mutation': Mutation
  /** 项目数据发生变化（需要保存） */
  'dirty': undefined
}

export type SelectMode = 'replace' | 'add' | 'toggle'

export class EditorStore {
  project: Project
  readonly selection = new Set<string>()
  readonly history: HistoryManager
  readonly events = new Emitter<EditorEvents>()

  private pointById = new Map<string, Point>()
  private groupById = new Map<string, Group>()
  private frameById = new Map<string, Frame>()
  private transitionById = new Map<string, Transition>()
  private pointsByFrame = new Map<string, Point[]>()
  private spatial = new SpatialGrid(64)
  private spatialDirty = true

  /** 当前显示的帧 id（画布只显示这一帧的点） */
  private activeFrameId = ''
  /** 当前轨道下标（当前项目只有一条轨道） */
  private readonly activeTrackIndex = 0

  /** 已提交的数据操作入口：先改数据（触发渲染事件），再广播 mutation */
  private readonly ctx: OperationContext = {
    addPoints: (points) => {
      this.mutateAdd(points)
      this.events.emit('mutation', { type: 'add', points })
    },
    removePoints: (ids) => {
      this.mutateRemove(ids)
      this.events.emit('mutation', { type: 'remove', ids })
    },
    setPositions: (updates) => {
      this.mutateMove(updates)
      this.events.emit('mutation', { type: 'move', updates })
    },
    setColors: (ids, color) => {
      this.mutateColor(ids, color)
      this.events.emit('mutation', { type: 'color', ids, color })
    },
    // 分组结构本身通过 applyChanges 的 groups 快照整体落库；
    // 点位的归属变化则是点级 mutation
    addGroup: (group) => this.mutateAddGroup(group),
    removeGroup: (groupId) => this.mutateRemoveGroup(groupId),
    setGroupIds: (entries) => {
      this.mutateSetGroupIds(entries)
      this.events.emit('mutation', { type: 'setGroup', entries })
    },
    setLocked: (entries) => {
      this.mutateSetLocked(entries)
      this.events.emit('mutation', { type: 'setLocked', entries })
    },
    addFrame: (frame, points, index) => {
      this.mutateAddFrame(frame, points, index)
      this.events.emit('mutation', { type: 'add', points })
    },
    removeFrame: (frameId) => {
      const ids = this.getFramePoints(frameId).map((p) => p.id)
      this.mutateRemoveFrame(frameId)
      this.events.emit('mutation', { type: 'remove', ids })
    },
    updateFrame: (frame, points) => {
      const old = this.getFramePoints(frame.id).slice()
      this.mutateUpdateFrame(frame, points)
      this.events.emit('mutation', { type: 'remove', ids: old.map((p) => p.id) })
      this.events.emit('mutation', { type: 'add', points })
    },
    setFrameDuration: (frameId, duration) => this.mutateSetFrameDuration(frameId, duration),
    moveFrame: (from, to) => this.mutateMoveFrame(from, to),
    addTransition: (transition) => this.mutateAddTransition(transition),
    updateTransition: (transition) => this.mutateUpdateTransition(transition),
    removeTransition: (transitionId) => this.mutateRemoveTransition(transitionId),
  }

  constructor(project: Project) {
    this.project = project
    this.rebuildIndex()
    this.history = new HistoryManager(this.ctx, () => {
      this.events.emit('history:change', undefined)
      this.markDirty()
    })
  }

  // ---------------------------------------------------------------- 轨道 / 帧

  get track() {
    return this.project.tracks[this.activeTrackIndex]
  }

  get frames(): Frame[] {
    return this.track.clips
  }

  get transitions(): Transition[] {
    return this.track.transitions
  }

  get activeFrameIdValue(): string {
    return this.activeFrameId
  }

  get activeFrame(): Frame | undefined {
    return this.frameById.get(this.activeFrameId)
  }

  getFrame(id: string): Frame | undefined {
    return this.frameById.get(id)
  }

  getTransition(id: string): Transition | undefined {
    return this.transitionById.get(id)
  }

  getFramePoints(frameId: string): Point[] {
    return this.pointsByFrame.get(frameId) ?? []
  }

  /** 供过渡引擎使用的 frameId → 点位 映射 */
  getPointsByFrame(): Map<string, Point[]> {
    return this.pointsByFrame
  }

  getPointCountOfFrame(frameId: string): number {
    return this.pointsByFrame.get(frameId)?.length ?? 0
  }

  // ---------------------------------------------------------------- 载入

  loadProject(project: Project, history: Operation[] = []): void {
    this.project = project
    this.selection.clear()
    this.rebuildIndex()
    this.activeFrameId = this.track.clips[0]?.id ?? ''
    this.history.load(history)
    this.events.emit('project:load', undefined)
    this.events.emit('frames:change', undefined)
    this.events.emit('transitions:change', undefined)
    this.events.emit('activeFrame:change', undefined)
    this.events.emit('selection:change', undefined)
  }

  setProjectName(name: string): void {
    this.project.name = name
    this.markDirty()
    this.events.emit('meta:change', undefined)
  }

  setDroneCount(count: number): void {
    const n = Math.max(1, Math.floor(count))
    if (n === this.project.droneCount) return
    this.project.droneCount = n
    this.markDirty()
    this.events.emit('meta:change', undefined)
  }

  get droneLimits(): { maxSpeed: number; maxAccel: number } {
    const l = this.project.droneLimits
    return { maxSpeed: l?.maxSpeed ?? 0, maxAccel: l?.maxAccel ?? 0 }
  }

  /** 设置无人机运动能力上限（0 表示不限制），用于过渡约束校验 */
  setDroneLimits(limits: { maxSpeed?: number; maxAccel?: number }): void {
    const next = {
      maxSpeed: Math.max(0, limits.maxSpeed ?? 0),
      maxAccel: Math.max(0, limits.maxAccel ?? 0),
    }
    const cur = this.droneLimits
    if (cur.maxSpeed === next.maxSpeed && cur.maxAccel === next.maxAccel) return
    this.project.droneLimits = next
    this.markDirty()
    this.events.emit('meta:change', undefined)
  }

  get pointCount(): number {
    return this.project.points.length
  }

  get activePointCount(): number {
    return this.pointsByFrame.get(this.activeFrameId)?.length ?? 0
  }

  get selectedCount(): number {
    return this.selection.size
  }

  private rebuildIndex(): void {
    if (!Array.isArray(this.project.tracks)) this.project.tracks = []
    if (!Array.isArray(this.project.points)) this.project.points = []
    if (!Array.isArray(this.project.groups)) this.project.groups = []

    this.pointById.clear()
    this.pointsByFrame.clear()
    for (const p of this.project.points) {
      this.pointById.set(p.id, p)
      const list = this.pointsByFrame.get(p.frameId)
      if (list) list.push(p)
      else this.pointsByFrame.set(p.frameId, [p])
    }
    this.groupById.clear()
    for (const g of this.project.groups) this.groupById.set(g.id, g)
    this.frameById.clear()
    this.transitionById.clear()
    for (const track of this.project.tracks) {
      for (const f of track.clips) this.frameById.set(f.id, f)
      for (const tr of track.transitions) this.transitionById.set(tr.id, tr)
    }
    this.spatialDirty = true
  }

  getPoint(id: string): Point | undefined {
    return this.pointById.get(id)
  }

  getSpatial(): SpatialGrid {
    if (this.spatialDirty) {
      this.spatial.rebuild(this.pointsByFrame.get(this.activeFrameId) ?? [])
      this.spatialDirty = false
    }
    return this.spatial
  }

  getSelectedPoints(): Point[] {
    const result: Point[] = []
    for (const id of this.selection) {
      const p = this.pointById.get(id)
      if (p) result.push(p)
    }
    return result
  }

  setActiveFrame(frameId: string): void {
    if (frameId === this.activeFrameId || !this.frameById.has(frameId)) return
    this.activeFrameId = frameId
    this.selection.clear()
    this.spatialDirty = true
    this.events.emit('activeFrame:change', undefined)
    this.events.emit('selection:change', undefined)
  }

  // ---------------------------------------------------------------- 分组

  get groups(): Group[] {
    return this.project.groups
  }

  getGroup(id: string): Group | undefined {
    return this.groupById.get(id)
  }

  getGroupMembers(groupId: string): Point[] {
    return this.project.points.filter((p) => p.groupId === groupId)
  }

  getGroupMemberCount(groupId: string): number {
    let count = 0
    for (const p of this.project.points) if (p.groupId === groupId) count++
    return count
  }

  /** 组内是否所有点都已锁定（用于 UI 显示组锁状态） */
  isGroupLocked(groupId: string): boolean {
    const members = this.getGroupMembers(groupId)
    return members.length > 0 && members.every((p) => p.locked === true)
  }

  // --------------------------------------------------- 低层数据操作（不改历史）

  private mutateAdd(points: Point[]): void {
    const ids: string[] = []
    for (const p of points) {
      if (this.pointById.has(p.id)) continue
      // 未指定帧时归入当前帧
      if (!p.frameId) p.frameId = this.activeFrameId
      this.project.points.push(p)
      this.pointById.set(p.id, p)
      const list = this.pointsByFrame.get(p.frameId)
      if (list) list.push(p)
      else this.pointsByFrame.set(p.frameId, [p])
      ids.push(p.id)
    }
    this.spatialDirty = true
    this.events.emit('points:add', { ids })
  }

  private mutateRemove(ids: string[]): void {
    const idSet = new Set(ids)
    this.project.points = this.project.points.filter((p) => !idSet.has(p.id))
    for (const id of ids) {
      const p = this.pointById.get(id)
      if (p) {
        const list = this.pointsByFrame.get(p.frameId)
        if (list) {
          const idx = list.indexOf(p)
          if (idx >= 0) list.splice(idx, 1)
        }
      }
      this.pointById.delete(id)
      this.selection.delete(id)
    }
    this.spatialDirty = true
    this.events.emit('points:remove', { ids })
    this.events.emit('selection:change', undefined)
  }

  private mutateMove(updates: PositionUpdate[]): void {
    const ids: string[] = []
    for (const u of updates) {
      const p = this.pointById.get(u.id)
      if (!p) continue
      p.x = u.x
      p.y = u.y
      ids.push(u.id)
    }
    this.spatialDirty = true
    this.events.emit('points:move', { ids })
  }

  private mutateColor(ids: string[], color: RGB): void {
    for (const id of ids) {
      const p = this.pointById.get(id)
      if (!p) continue
      p.r = color.r
      p.g = color.g
      p.b = color.b
    }
    this.events.emit('points:color', { ids })
  }

  private mutateAddGroup(group: Group): void {
    if (this.groupById.has(group.id)) return
    this.project.groups.push(group)
    this.groupById.set(group.id, group)
    this.events.emit('groups:change', undefined)
  }

  private mutateRemoveGroup(groupId: string): void {
    this.project.groups = this.project.groups.filter((g) => g.id !== groupId)
    this.groupById.delete(groupId)
    this.events.emit('groups:change', undefined)
  }

  private mutateSetGroupIds(entries: GroupEntry[]): void {
    for (const [id, groupId] of entries) {
      const p = this.pointById.get(id)
      if (!p) continue
      if (groupId === null) delete p.groupId
      else p.groupId = groupId
    }
    this.events.emit('groups:change', undefined)
  }

  private mutateSetLocked(entries: LockEntry[]): void {
    const ids: string[] = []
    for (const [id, locked] of entries) {
      const p = this.pointById.get(id)
      if (!p) continue
      if (locked) p.locked = true
      else delete p.locked
      ids.push(id)
      // 锁定的点立即移出选择，避免被后续删除/改色影响
      if (locked) this.selection.delete(id)
    }
    this.events.emit('points:lock', { ids })
    if (ids.length > 0) this.events.emit('selection:change', undefined)
  }

  // --------------------------------------------------- 低层帧 / 过渡操作

  private mutateAddFrame(frame: Frame, points: Point[], index: number): void {
    for (const p of points) p.frameId = frame.id
    const clips = this.track.clips
    const at = Math.max(0, Math.min(index, clips.length))
    clips.splice(at, 0, frame)
    this.frameById.set(frame.id, frame)
    this.pointsByFrame.set(frame.id, points)
    for (const p of points) {
      this.project.points.push(p)
      this.pointById.set(p.id, p)
    }
    this.spatialDirty = true
    this.events.emit('frames:change', undefined)
    this.setActiveFrame(frame.id)
  }

  private mutateRemoveFrame(frameId: string): void {
    const frame = this.frameById.get(frameId)
    if (!frame) return
    const track = this.project.tracks.find((t) => t.clips.some((c) => c.id === frameId)) ?? this.track
    const idx = track.clips.findIndex((c) => c.id === frameId)
    if (idx >= 0) track.clips.splice(idx, 1)
    // 一并移除该帧的点位
    const pts = this.pointsByFrame.get(frameId) ?? []
    const idSet = new Set(pts.map((p) => p.id))
    this.project.points = this.project.points.filter((p) => !idSet.has(p.id))
    for (const p of pts) {
      this.pointById.delete(p.id)
      this.selection.delete(p.id)
    }
    this.pointsByFrame.delete(frameId)
    this.frameById.delete(frameId)
    // 移除与之相关的过渡
    const before = track.transitions.length
    track.transitions = track.transitions.filter(
      (tr) => tr.fromFrameId !== frameId && tr.toFrameId !== frameId,
    )
    for (const tr of track.transitions) this.transitionById.set(tr.id, tr)
    this.spatialDirty = true
    this.events.emit('frames:change', undefined)
    this.events.emit('points:remove', { ids: [...idSet] })
    if (track.transitions.length !== before) this.events.emit('transitions:change', undefined)
    // 若删除的是当前帧，切到相邻帧
    if (this.activeFrameId === frameId) {
      const next = track.clips[Math.min(idx, track.clips.length - 1)]
      this.activeFrameId = next?.id ?? ''
      this.selection.clear()
      this.events.emit('activeFrame:change', undefined)
      this.events.emit('selection:change', undefined)
    }
  }

  /** 用新的帧字段与点位整体替换某帧内容（帧 id 与过渡引用保持不变） */
  private mutateUpdateFrame(frame: Frame, points: Point[]): void {
    const existing = this.frameById.get(frame.id)
    if (!existing) return
    existing.name = frame.name
    existing.thumbnail = frame.thumbnail
    existing.width = frame.width
    existing.height = frame.height
    existing.duration = frame.duration
    if (frame.source !== undefined) existing.source = frame.source
    else delete existing.source
    if (frame.params !== undefined) existing.params = frame.params
    else delete existing.params
    // 替换该帧点位
    const old = this.pointsByFrame.get(frame.id) ?? []
    const oldSet = new Set(old.map((p) => p.id))
    this.project.points = this.project.points.filter((p) => !oldSet.has(p.id))
    for (const p of old) {
      this.pointById.delete(p.id)
      this.selection.delete(p.id)
    }
    for (const p of points) {
      p.frameId = frame.id
      this.project.points.push(p)
      this.pointById.set(p.id, p)
    }
    this.pointsByFrame.set(frame.id, points)
    this.spatialDirty = true
    this.events.emit('frames:change', undefined)
    // 强制渲染层按当前帧重建（编辑当前帧时立即反映）
    this.events.emit('activeFrame:change', undefined)
  }

  private mutateSetFrameDuration(frameId: string, duration: number): void {
    const frame = this.frameById.get(frameId)
    if (!frame) return
    frame.duration = duration
    this.events.emit('frames:change', undefined)
  }

  private mutateMoveFrame(from: number, to: number): void {
    const clips = this.track.clips
    if (from < 0 || from >= clips.length) return
    const [f] = clips.splice(from, 1)
    const at = Math.max(0, Math.min(to, clips.length))
    clips.splice(at, 0, f)
    this.events.emit('frames:change', undefined)
  }

  private mutateAddTransition(transition: Transition): void {
    if (this.transitionById.has(transition.id)) return
    this.track.transitions.push(transition)
    this.transitionById.set(transition.id, transition)
    this.events.emit('transitions:change', undefined)
  }

  private mutateUpdateTransition(transition: Transition): void {
    const list = this.track.transitions
    const idx = list.findIndex((t) => t.id === transition.id)
    if (idx < 0) return
    list[idx] = transition
    this.transitionById.set(transition.id, transition)
    this.events.emit('transitions:change', undefined)
  }

  private mutateRemoveTransition(transitionId: string): void {
    this.track.transitions = this.track.transitions.filter((t) => t.id !== transitionId)
    this.transitionById.delete(transitionId)
    this.events.emit('transitions:change', undefined)
  }

  // ------------------------------------------------------------- 可撤销操作

  addPoint(init: Omit<PointInit, 'frameId'> & { frameId?: string }): Point {
    const frameId = init.frameId ?? this.activeFrameId
    const point = createPoint({ ...init, frameId })
    this.history.execute({ kind: 'add', label: '新增点', points: [point] })
    this.select(point.id, 'replace')
    return point
  }

  addPoints(points: Array<Omit<Point, 'frameId'> & { frameId?: string }>): void {
    const normalized = points.map((p) => ({ ...p, frameId: p.frameId ?? this.activeFrameId })) as Point[]
    this.history.execute({
      kind: 'add',
      label: `新增 ${normalized.length} 个点`,
      points: normalized,
    })
  }

  deletePoints(ids: string[]): void {
    const points = ids
      .map((id) => this.pointById.get(id))
      // 锁定的点不允许删除
      .filter((p): p is Point => p !== undefined && p.locked !== true)
    if (points.length === 0) return
    this.history.execute({
      kind: 'remove',
      label: points.length > 1 ? `删除 ${points.length} 个点` : '删除点',
      points,
    })
  }

  deleteSelected(): void {
    if (this.selection.size === 0) return
    this.deletePoints([...this.selection])
  }

  setColorForSelection(color: RGB): void {
    if (this.selection.size === 0) return
    const ids = [...this.selection]
    const before: [string, number, number, number][] = []
    for (const id of ids) {
      const p = this.pointById.get(id)
      if (p) before.push([id, p.r, p.g, p.b])
    }
    this.history.execute({ kind: 'color', label: '修改颜色', ids, after: color, before })
  }

  /** 拖动中的瞬时预览：只改数据 + 重绘，不写历史、不产生 mutation */
  previewMove(updates: PositionUpdate[]): void {
    this.mutateMove(updates)
  }

  /** 拖动结束：把本次位移作为一条 move Operation 入历史 */
  commitMove(before: Map<string, { x: number; y: number }>): void {
    const beforeEntries: MoveEntry[] = []
    const afterEntries: MoveEntry[] = []
    let moved = false
    for (const [id, prev] of before) {
      const p = this.pointById.get(id)
      if (!p) continue
      if (p.x !== prev.x || p.y !== prev.y) moved = true
      beforeEntries.push([id, prev.x, prev.y])
      afterEntries.push([id, p.x, p.y])
    }
    if (!moved) return
    this.events.emit('mutation', {
      type: 'move',
      updates: afterEntries.map(([id, x, y]) => ({ id, x, y })),
    })
    this.history.push({ kind: 'move', label: '移动点位', before: beforeEntries, after: afterEntries })
  }

  undo(): void {
    this.history.undo()
  }

  redo(): void {
    this.history.redo()
  }

  // ------------------------------------------------------------ 帧片段操作

  /**
   * 追加一个帧片段（导入图片）。若当前轨道只有一个「空默认帧」，则直接替换它，
   * 避免新建项目后总留着一个空帧。
   */
  addFrame(frame: Frame, points: Point[]): void {
    for (const p of points) p.frameId = frame.id
    const clips = this.track.clips
    const singularEmpty =
      clips.length === 1 &&
      clips[0].thumbnail === '' &&
      this.getPointCountOfFrame(clips[0].id) === 0
    if (singularEmpty) {
      // 静默移除空默认帧（不入历史），再插入新帧
      this.mutateRemoveFrame(clips[0].id)
      this.history.execute({ kind: 'addFrame', label: '导入图片', frame, points, index: 0 })
      return
    }
    this.history.execute({
      kind: 'addFrame',
      label: '导入图片',
      frame,
      points,
      index: clips.length,
    })
  }

  removeFrame(frameId: string): void {
    const frame = this.frameById.get(frameId)
    if (!frame) return
    const index = this.track.clips.findIndex((c) => c.id === frameId)
    const points = this.getFramePoints(frameId)
    this.history.execute({ kind: 'removeFrame', label: '删除帧', frame, points, index })
  }

  /**
   * 编辑帧：更新名称/时长/缩略图/源图/采样参数并**替换其点位**（帧 id 不变，
   * 因此已有的过渡引用不会失效）。作为一条可撤销操作。
   */
  updateFrameContent(
    frameId: string,
    data: {
      name: string
      duration: number
      thumbnail: string
      source?: string
      params?: FrameParams
      points: Point[]
    },
  ): void {
    const frame = this.frameById.get(frameId)
    if (!frame) return
    const before: Frame = {
      ...frame,
      params: frame.params ? { ...frame.params } : undefined,
    }
    const beforePoints = this.getFramePoints(frameId).map((p) => ({ ...p }))
    const after: Frame = {
      ...frame,
      name: data.name,
      duration: Math.max(0.1, data.duration),
      thumbnail: data.thumbnail,
    }
    if (data.source !== undefined) after.source = data.source
    if (data.params !== undefined) after.params = data.params
    this.history.execute({
      kind: 'updateFrame',
      label: '修改帧',
      frameId,
      before,
      after,
      beforePoints,
      afterPoints: data.points,
    })
  }

  setFrameDuration(frameId: string, duration: number): void {
    const frame = this.frameById.get(frameId)
    if (!frame || duration <= 0 || frame.duration === duration) return
    this.history.execute({
      kind: 'setFrameDuration',
      label: '修改帧时长',
      frameId,
      before: frame.duration,
      after: duration,
    })
  }

  moveFrame(from: number, to: number): void {
    if (from === to) return
    if (from < 0 || from >= this.track.clips.length) return
    this.history.execute({ kind: 'moveFrame', label: '调整帧顺序', from, to })
  }

  /** 新增或更新过渡（存在同 id 即更新，否则新增） */
  upsertTransition(transition: Transition): void {
    const existing = this.transitionById.get(transition.id)
    if (existing) {
      this.history.execute({
        kind: 'updateTransition',
        label: '修改过渡',
        before: { ...existing, params: { ...existing.params } },
        after: transition,
      })
    } else {
      this.history.execute({ kind: 'addTransition', label: '新增过渡', transition })
    }
  }

  /** 在相邻两帧之间新增一个默认过渡 */
  addTransitionBetween(fromFrameId: string, toFrameId: string): Transition | null {
    const clips = this.track.clips
    const i = clips.findIndex((c) => c.id === fromFrameId)
    if (i < 0 || clips[i + 1]?.id !== toFrameId) return null
    const transition = createTransition(fromFrameId, toFrameId)
    this.upsertTransition(transition)
    return transition
  }

  removeTransition(transitionId: string): void {
    const transition = this.transitionById.get(transitionId)
    if (!transition) return
    this.history.execute({ kind: 'removeTransition', label: '删除过渡', transition })
  }

  // ------------------------------------------------------------ 分组 / 锁定

  /** 把当前选中的点归为一个新组（可撤销） */
  groupSelection(name?: string): Group | null {
    if (this.selection.size === 0) return null
    const members = [...this.selection]
    const group = createGroup(name ?? `分组 ${this.project.groups.length + 1}`, this.project.groups.length)
    const before: GroupEntry[] = members.map((id) => [id, this.pointById.get(id)?.groupId ?? null])
    this.history.execute({ kind: 'group', label: '成组', group, members, before })
    return group
  }

  /** 解散一个组：清空组内点的归属并移除该组（可撤销） */
  ungroup(groupId: string): void {
    const group = this.groupById.get(groupId)
    if (!group) return
    const members = this.getGroupMembers(groupId).map((p) => p.id)
    this.history.execute({ kind: 'ungroup', label: '取消分组', group, members })
  }

  renameGroup(groupId: string, name: string): void {
    const group = this.groupById.get(groupId)
    if (!group || !name.trim()) return
    group.name = name.trim()
    this.events.emit('groups:change', undefined)
    this.markDirty()
  }

  /** 批量设置锁定状态（锁定的点会自动移出选择） */
  setLocked(ids: string[], locked: boolean): void {
    const entries: LockEntry[] = []
    for (const id of ids) {
      const p = this.pointById.get(id)
      if (!p) continue
      if ((p.locked === true) === locked) continue
      entries.push([id, p.locked === true])
    }
    if (entries.length === 0) return
    this.history.execute({
      kind: 'lock',
      label: locked ? '锁定点位' : '解锁点位',
      locked,
      entries,
    })
  }

  setLockedForSelection(locked: boolean): void {
    if (this.selection.size === 0) return
    this.setLocked([...this.selection], locked)
  }

  /** 组锁定 = 批量锁定组内所有点 */
  setLockedForGroup(groupId: string, locked: boolean): void {
    const ids = this.getGroupMembers(groupId).map((p) => p.id)
    this.setLocked(ids, locked)
  }

  /** 解锁全部锁定点 */
  unlockAll(): void {
    const ids: string[] = []
    for (const p of this.project.points) if (p.locked) ids.push(p.id)
    this.setLocked(ids, false)
  }

  /** 选中某个组的所有未锁定点 */
  selectGroup(groupId: string, mode: SelectMode = 'replace'): void {
    this.selectMany(
      this.getGroupMembers(groupId).map((p) => p.id),
      mode,
    )
  }

  // ---------------------------------------------------------------- 选中

  select(id: string, mode: SelectMode = 'replace'): void {
    this.selectMany([id], mode)
  }

  selectMany(ids: string[], mode: SelectMode = 'replace'): void {
    if (mode === 'replace') this.selection.clear()
    for (const id of ids) {
      const p = this.pointById.get(id)
      // 锁定点永远不可选（因此也不会被拖动/删除/改色）
      if (!p || p.locked === true) continue
      if (mode === 'toggle' && this.selection.has(id)) this.selection.delete(id)
      else this.selection.add(id)
    }
    this.events.emit('selection:change', undefined)
  }

  clearSelection(): void {
    if (this.selection.size === 0) return
    this.selection.clear()
    this.events.emit('selection:change', undefined)
  }

  private markDirty(): void {
    this.project.updatedAt = Date.now()
    this.events.emit('dirty', undefined)
  }
}
