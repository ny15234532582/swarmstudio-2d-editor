/**
 * 仓储层：所有 SQL 都集中在这里。
 *
 * 该层不依赖 Vue / Pixi / Worker，只依赖 sqlite3 的 Database 接口，
 * 因此既能在浏览器 Worker 里跑，也能在 Node + 内存库下做单元测试。
 *
 * 持久化策略：
 * - 点位增删移改、锁定、分组归属 → 按 mutation 增量写；
 * - 分组结构 / 过渡 / 帧与轨道 / 历史 → 每次整体覆盖（数量小，覆盖更简单）。
 */
import type { Database, PreparedStatement } from '@sqlite.org/sqlite-wasm'
import { HISTORY_LIMIT, type Mutation, type Operation } from '../core/operations'
import type { Frame, Group, Point, ProjectMeta, Track, Transition } from '../core/types'
import type { LoadedProject, ProjectRecord, RenderRecord } from './protocol'

type Row = Array<number | string | null | Uint8Array>

// sqlite-wasm 返回的行是弱类型数组，这里做统一的取值归一化
function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v)
}
function str(v: unknown): string {
  return v == null ? '' : String(v)
}
// SQLite 没有布尔类型，locked 以 0/1 存储，需兼容数字/字符串两种读回形式
function isTrue(v: unknown): boolean {
  return v === 1 || v === true || v === '1'
}

// 点位表列名与占位符集中定义，保证写入顺序与 bindPoint 一致
const POINT_COLUMNS = 'project_id,frame_id,id,x,y,z,r,g,b,drone_index,group_id,locked'
const POINT_PLACEHOLDERS = '?,?,?,?,?,?,?,?,?,?,?,?'

/** 把单个点位绑定到已 prepare 的插入/替换语句并复位，供批量复用 */
function bindPoint(stmt: PreparedStatement, projectId: string, p: Point): void {
  stmt
    .bind([
      projectId,
      p.frameId,
      p.id,
      p.x,
      p.y,
      p.z,
      p.r,
      p.g,
      p.b,
      p.droneIndex ?? null,
      p.groupId ?? null,
      p.locked ? 1 : 0,
    ])
    .stepReset()
}

/** 插入一条项目元信息（轨道/帧/过渡等随后单独写） */
export function insertProject(db: Database, project: ProjectRecord): void {
  db.prepare(
    'INSERT INTO projects(id,name,version,drone_count,drone_max_speed,drone_max_accel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind([
      project.id,
      project.name,
      project.version,
      project.droneCount,
      project.maxSpeed ?? 0,
      project.maxAccel ?? 0,
      project.createdAt,
      project.updatedAt,
    ])
    .stepFinalize()
}

/** 重命名项目并刷新 updated_at，使其在列表中排到最前 */
export function renameProject(db: Database, projectId: string, name: string): void {
  db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
    .bind([name, Date.now(), projectId])
    .stepFinalize()
}

/** 删除项目；子表依靠外键级联一并清除 */
export function deleteProject(db: Database, projectId: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').bind([projectId]).stepFinalize()
}

/** 项目摘要列表：JOIN 统计点位数，按最近更新倒序 */
export function listProjects(db: Database): ProjectMeta[] {
  const rows = db.selectArrays(
    `SELECT p.id, p.name, p.version, p.created_at, p.updated_at, COUNT(pt.id)
       FROM projects p
       LEFT JOIN points pt ON pt.project_id = p.id
       GROUP BY p.id
       ORDER BY p.updated_at DESC`,
  ) as Row[]
  return rows.map((r) => ({
    id: str(r[0]),
    name: str(r[1]),
    version: num(r[2]),
    createdAt: num(r[3]),
    updatedAt: num(r[4]),
    pointCount: num(r[5]),
  }))
}

/** 读取点位，按插入顺序（rowid）返回 */
function readPoints(db: Database, projectId: string): Point[] {
  const rows = db.selectArrays(
    'SELECT frame_id,id,x,y,z,r,g,b,drone_index,group_id,locked FROM points WHERE project_id = ? ORDER BY rowid ASC',
    [projectId],
  ) as Row[]
  return rows.map((r) => {
    const point: Point = {
      id: str(r[1]),
      frameId: str(r[0]),
      x: num(r[2]),
      y: num(r[3]),
      z: num(r[4]),
      r: num(r[5]),
      g: num(r[6]),
      b: num(r[7]),
    }
    if (r[8] != null) point.droneIndex = num(r[8])
    if (r[9] != null) point.groupId = str(r[9])
    if (isTrue(r[10])) point.locked = true
    return point
  })
}

/** 读取分组 */
function readGroups(db: Database, projectId: string): Group[] {
  const rows = db.selectArrays(
    'SELECT id,name,color_r,color_g,color_b FROM groups WHERE project_id = ? ORDER BY rowid ASC',
    [projectId],
  ) as Row[]
  return rows.map((r) => ({
    id: str(r[0]),
    name: str(r[1]),
    color: { r: num(r[2]), g: num(r[3]), b: num(r[4]) },
  }))
}

/** 读取所有轨道，并装配其帧与过渡 */
function readTracks(db: Database, projectId: string): Track[] {
  const trackRows = db.selectArrays(
    'SELECT id,name FROM tracks WHERE project_id = ? ORDER BY order_index ASC',
    [projectId],
  ) as Row[]
  const frameRows = db.selectArrays(
    'SELECT id,track_id,name,thumbnail,width,height,duration,source,params FROM frames WHERE project_id = ? ORDER BY order_index ASC',
    [projectId],
  ) as Row[]
  const transRows = db.selectArrays(
    'SELECT id,track_id,from_frame_id,to_frame_id,duration,algorithm,path,easing,velocity_profile,stagger,params FROM transitions WHERE project_id = ? ORDER BY order_index ASC',
    [projectId],
  ) as Row[]

  const framesByTrack = new Map<string, Frame[]>()
  for (const r of frameRows) {
    const frame: Frame = {
      id: str(r[0]),
      name: str(r[2]),
      thumbnail: str(r[3]),
      width: num(r[4]),
      height: num(r[5]),
      duration: num(r[6]),
    }
    if (r[7] != null && str(r[7]) !== '') frame.source = str(r[7])
    if (r[8] != null && str(r[8]) !== '') {
      try {
        frame.params = JSON.parse(str(r[8])) as Frame['params']
      } catch {
        // 参数损坏则忽略，回落到默认
      }
    }
    const list = framesByTrack.get(str(r[1]))
    if (list) list.push(frame)
    else framesByTrack.set(str(r[1]), [frame])
  }
  const transByTrack = new Map<string, Transition[]>()
  for (const r of transRows) {
    let params: Record<string, number> = {}
    try {
      params = JSON.parse(str(r[10])) as Record<string, number>
    } catch {
      params = {}
    }
    const tr: Transition = {
      id: str(r[0]),
      fromFrameId: str(r[2]),
      toFrameId: str(r[3]),
      duration: num(r[4]),
      algorithm: str(r[5]) as Transition['algorithm'],
      path: str(r[6]) as Transition['path'],
      easing: str(r[7]) as Transition['easing'],
      velocityProfile: (str(r[8]) || 'ease') as Transition['velocityProfile'],
      stagger: num(r[9]) || 0,
      params,
    }
    const list = transByTrack.get(str(r[1]))
    if (list) list.push(tr)
    else transByTrack.set(str(r[1]), [tr])
  }

  return trackRows.map((r) => ({
    id: str(r[0]),
    name: str(r[1]),
    clips: framesByTrack.get(str(r[0])) ?? [],
    transitions: transByTrack.get(str(r[0])) ?? [],
  }))
}

/** 读取历史；单条 JSON 损坏时跳过，避免整份历史无法加载 */
function readHistory(db: Database, projectId: string): Operation[] {
  const rows = db.selectArrays(
    'SELECT op FROM history WHERE project_id = ? ORDER BY seq ASC',
    [projectId],
  ) as Row[]
  const ops: Operation[] = []
  for (const r of rows) {
    try {
      ops.push(JSON.parse(str(r[0])) as Operation)
    } catch {
      // 单条历史损坏不影响项目加载
    }
  }
  return ops
}

/** 加载完整项目；项目不存在返回 null */
export function loadProject(db: Database, projectId: string): LoadedProject | null {
  const rows = db.selectArrays(
    'SELECT id,name,version,drone_count,drone_max_speed,drone_max_accel,created_at,updated_at FROM projects WHERE id = ?',
    [projectId],
  ) as Row[]
  const meta = rows[0]
  if (!meta) return null
  return {
    project: {
      id: str(meta[0]),
      name: str(meta[1]),
      version: num(meta[2]),
      droneCount: num(meta[3]),
      droneLimits: { maxSpeed: num(meta[4]) || 0, maxAccel: num(meta[5]) || 0 },
      createdAt: num(meta[6]),
      updatedAt: num(meta[7]),
      points: readPoints(db, projectId),
      groups: readGroups(db, projectId),
      tracks: readTracks(db, projectId),
    },
    history: readHistory(db, projectId),
  }
}

/**
 * 覆盖保存历史：先清空再整体重写，只保留最近 HISTORY_LIMIT(=100) 条。
 */
export function saveHistory(db: Database, projectId: string, ops: Operation[]): void {
  db.prepare('DELETE FROM history WHERE project_id = ?').bind([projectId]).stepFinalize()
  const recent = ops.slice(-HISTORY_LIMIT)
  if (recent.length === 0) return
  const stmt = db.prepare(
    'INSERT INTO history(project_id,seq,label,op,created_at) VALUES(?,?,?,?,?)',
  )
  const now = Date.now()
  recent.forEach((op, index) => {
    stmt.bind([projectId, index, op.label, JSON.stringify(op), now]).stepReset()
  })
  stmt.finalize()
}

/** 分组结构整体覆盖保存 */
export function saveGroups(db: Database, projectId: string, groups: Group[]): void {
  db.prepare('DELETE FROM groups WHERE project_id = ?').bind([projectId]).stepFinalize()
  if (groups.length === 0) return
  const stmt = db.prepare(
    'INSERT INTO groups(project_id,id,name,color_r,color_g,color_b) VALUES(?,?,?,?,?,?)',
  )
  for (const g of groups) {
    stmt.bind([projectId, g.id, g.name, g.color.r, g.color.g, g.color.b]).stepReset()
  }
  stmt.finalize()
}

/** 轨道 / 帧 / 过渡整体覆盖保存 */
export function saveTracks(db: Database, projectId: string, tracks: Track[]): void {
  db.prepare('DELETE FROM transitions WHERE project_id = ?').bind([projectId]).stepFinalize()
  db.prepare('DELETE FROM frames WHERE project_id = ?').bind([projectId]).stepFinalize()
  db.prepare('DELETE FROM tracks WHERE project_id = ?').bind([projectId]).stepFinalize()
  if (tracks.length === 0) return

  const trackStmt = db.prepare(
    'INSERT INTO tracks(project_id,id,name,order_index) VALUES(?,?,?,?)',
  )
  const frameStmt = db.prepare(
    'INSERT INTO frames(project_id,id,track_id,name,thumbnail,width,height,duration,source,params,order_index) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  )
  const transStmt = db.prepare(
    'INSERT INTO transitions(project_id,id,track_id,from_frame_id,to_frame_id,duration,algorithm,path,easing,velocity_profile,stagger,params,order_index) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
  tracks.forEach((track, ti) => {
    trackStmt.bind([projectId, track.id, track.name, ti]).stepReset()
    track.clips.forEach((f, fi) => {
      frameStmt
        .bind([
          projectId,
          f.id,
          track.id,
          f.name,
          f.thumbnail,
          f.width,
          f.height,
          f.duration,
          f.source ?? null,
          f.params ? JSON.stringify(f.params) : null,
          fi,
        ])
        .stepReset()
    })
    track.transitions.forEach((tr, ri) => {
      transStmt
        .bind([
          projectId,
          tr.id,
          track.id,
          tr.fromFrameId,
          tr.toFrameId,
          tr.duration,
          tr.algorithm,
          tr.path,
          tr.easing,
          tr.velocityProfile ?? 'ease',
          tr.stagger ?? 0,
          JSON.stringify(tr.params),
          ri,
        ])
        .stepReset()
    })
  })
  trackStmt.finalize()
  frameStmt.finalize()
  transStmt.finalize()
}

/** 应用单条 mutation：点级增删移改/改色/分组/锁定，均为增量 SQL */
function applyMutation(db: Database, projectId: string, mutation: Mutation): void {
  switch (mutation.type) {
    case 'add': {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO points(${POINT_COLUMNS}) VALUES(${POINT_PLACEHOLDERS})`,
      )
      for (const p of mutation.points) bindPoint(stmt, projectId, p)
      stmt.finalize()
      break
    }
    case 'remove': {
      const stmt = db.prepare('DELETE FROM points WHERE project_id = ? AND id = ?')
      for (const id of mutation.ids) stmt.bind([projectId, id]).stepReset()
      stmt.finalize()
      break
    }
    case 'move': {
      const stmt = db.prepare('UPDATE points SET x = ?, y = ? WHERE project_id = ? AND id = ?')
      for (const u of mutation.updates) stmt.bind([u.x, u.y, projectId, u.id]).stepReset()
      stmt.finalize()
      break
    }
    case 'color': {
      const stmt = db.prepare(
        'UPDATE points SET r = ?, g = ?, b = ? WHERE project_id = ? AND id = ?',
      )
      for (const id of mutation.ids) {
        stmt.bind([mutation.color.r, mutation.color.g, mutation.color.b, projectId, id]).stepReset()
      }
      stmt.finalize()
      break
    }
    case 'setGroup': {
      const stmt = db.prepare('UPDATE points SET group_id = ? WHERE project_id = ? AND id = ?')
      for (const [id, groupId] of mutation.entries) {
        stmt.bind([groupId, projectId, id]).stepReset()
      }
      stmt.finalize()
      break
    }
    case 'setLocked': {
      const stmt = db.prepare('UPDATE points SET locked = ? WHERE project_id = ? AND id = ?')
      for (const [id, locked] of mutation.entries) {
        stmt.bind([locked ? 1 : 0, projectId, id]).stepReset()
      }
      stmt.finalize()
      break
    }
  }
}

/** 更新项目的 updated_at，使最近修改的项目排到列表最前 */
function touchProject(db: Database, projectId: string): void {
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
    .bind([Date.now(), projectId])
    .stepFinalize()
}

/**
 * 增量写入：应用一批已提交的 mutation，并覆盖保存历史 / 分组 / 轨道结构，
 * 全在同一个事务里。
 */
export function applyChanges(
  db: Database,
  projectId: string,
  mutations: Mutation[],
  history: Operation[],
  groups: Group[],
  tracks: Track[],
): void {
  db.transaction(() => {
    for (const mutation of mutations) applyMutation(db, projectId, mutation)
    saveHistory(db, projectId, history)
    saveGroups(db, projectId, groups)
    saveTracks(db, projectId, tracks)
    touchProject(db, projectId)
  })
}

/** 全量替换项目数据（用于导入 / 打开 / 载入） */export function replaceData(
  db: Database,
  projectId: string,
  points: Point[],
  history: Operation[],
  groups: Group[],
  tracks: Track[],
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM points WHERE project_id = ?').bind([projectId]).stepFinalize()
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO points(${POINT_COLUMNS}) VALUES(${POINT_PLACEHOLDERS})`,
    )
    for (const p of points) bindPoint(stmt, projectId, p)
    stmt.finalize()
    saveHistory(db, projectId, history)
    saveGroups(db, projectId, groups)
    saveTracks(db, projectId, tracks)
    touchProject(db, projectId)
  })
}

// ------------------------------------------------------------ 过渡产物

/** 保存 / 覆盖一条过渡产物 */
export function saveRender(db: Database, projectId: string, render: RenderRecord): void {
  db.prepare(
    'INSERT OR REPLACE INTO transition_renders(project_id,transition_id,signature,algorithm,payload,elapsed_ms,created_at) VALUES(?,?,?,?,?,?,?)',
  )
    .bind([
      projectId,
      render.transitionId,
      render.signature,
      render.algorithm,
      render.payload,
      render.elapsedMs,
      render.createdAt,
    ])
    .stepFinalize()
}

/** 读取项目下全部过渡产物 */
export function listRenders(db: Database, projectId: string): RenderRecord[] {
  const rows = db.selectArrays(
    'SELECT transition_id,signature,algorithm,payload,elapsed_ms,created_at FROM transition_renders WHERE project_id = ?',
    [projectId],
  ) as Row[]
  return rows.map((r) => ({
    transitionId: str(r[0]),
    signature: str(r[1]),
    algorithm: str(r[2]),
    payload: str(r[3]),
    elapsedMs: num(r[4]),
    createdAt: num(r[5]),
  }))
}

/** 删除单条过渡产物 */
export function deleteRender(db: Database, projectId: string, transitionId: string): void {
  db.prepare('DELETE FROM transition_renders WHERE project_id = ? AND transition_id = ?')
    .bind([projectId, transitionId])
    .stepFinalize()
}
